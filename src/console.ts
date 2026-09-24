/**
 * Prompt-driven serial console client for Pylontech batteries.
 *
 * - Opens the port, optionally performs the 1200-baud wake sequence that
 *   switches the console to 115200 baud, then probes for the `pylon>` prompt.
 * - Serialises commands: one in flight at a time, each resolved when the
 *   prompt reappears or rejected on timeout.
 * - Emits `close` when the port goes away and `error` for transport errors.
 */
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export const WAKE_SEQUENCE = '~20014682C0048520FCC3\r';
export const WAKE_BAUD = 1200;
export const PROMPT = 'pylon>';
/** Pager prompt printed by the console after a screenful of output. */
export const PAGER_PROMPT = /Press \[Enter\] to be continued,\s*other key to exit\s*$/i;

/** Minimal surface we need from a serialport-compatible stream. Allows fakes in tests. */
export interface SerialLike extends EventEmitter {
  readonly isOpen: boolean;
  open(cb?: (err: Error | null) => void): void;
  close(cb?: (err: Error | null) => void): void;
  write(data: string | Buffer, cb?: (err: Error | null | undefined) => void): boolean;
  drain(cb?: (err: Error | null) => void): void;
  update(opts: { baudRate: number }, cb?: (err: Error | null) => void): void;
}

export type PortFactory = (path: string, baudRate: number) => SerialLike;

export interface ConsoleOptions {
  path: string;
  baudRate?: number;
  /** Perform the 1200-baud switch sequence on open. Default true. */
  wakeup?: boolean;
  /** Per-command inactivity timeout in ms: fails if the console stays silent this long. Default 3000. */
  commandTimeoutMs?: number;
  /** How long to wait after the wake sequence before switching baud. Default 500. */
  wakeDelayMs?: number;
  /** Injected for tests; defaults to a real `serialport` SerialPort. */
  createPort?: PortFactory;
}

function defaultFactory(path: string, baudRate: number): SerialLike {
  // Lazy require keeps the native binding out of unit tests and gives a clear error if it fails to load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SerialPort } = require('serialport') as typeof import('serialport');
  return new SerialPort({ path, baudRate, autoOpen: false }) as unknown as SerialLike;
}

const cbToPromise = (fn: (cb: (err: Error | null | undefined) => void) => void): Promise<void> =>
  new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));

export class ConsoleTimeoutError extends Error {
  constructor(
    command: string,
    timeoutMs: number,
    public readonly partial: string,
  ) {
    super(
      `Timeout after ${timeoutMs} ms waiting for prompt after "${command.trim() || '<enter>'}"`,
    );
    this.name = 'ConsoleTimeoutError';
  }
}

export class PylontechConsole extends EventEmitter {
  private port: SerialLike | undefined;
  private buffer = '';
  private waiter: { resolve: (s: string) => void; touch: () => void } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  readonly options: Required<Omit<ConsoleOptions, 'createPort'>> & { createPort: PortFactory };

  constructor(options: ConsoleOptions) {
    super();
    this.options = {
      path: options.path,
      baudRate: options.baudRate ?? 115200,
      wakeup: options.wakeup ?? true,
      commandTimeoutMs: options.commandTimeoutMs ?? 3000,
      wakeDelayMs: options.wakeDelayMs ?? 500,
      createPort: options.createPort ?? defaultFactory,
    };
  }

  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  /** Open the port, wake the console and verify the prompt answers. */
  async open(): Promise<void> {
    if (this.port) throw new Error('Console already open');
    this.closing = false;
    const { path, baudRate, wakeup, wakeDelayMs, createPort } = this.options;
    const port = createPort(path, wakeup ? WAKE_BAUD : baudRate);
    this.port = port;
    port.on('data', (chunk: Buffer | string) => this.onData(chunk));
    port.on('error', (err: Error) => this.emit('error', err));
    port.on('close', () => {
      this.port = undefined;
      this.failWaiter();
      if (!this.closing) this.emit('close');
    });
    try {
      await cbToPromise((cb) => port.open(cb));
      if (wakeup) {
        await cbToPromise((cb) => port.write(WAKE_SEQUENCE, cb));
        await cbToPromise((cb) => port.drain(cb));
        await delay(wakeDelayMs);
        await cbToPromise((cb) => port.update({ baudRate }, cb));
        await delay(100);
      }
      // Probe: an empty line must be answered with the prompt.
      await this.command('', this.options.commandTimeoutMs);
    } catch (err) {
      await this.close().catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const port = this.port;
    this.port = undefined;
    this.failWaiter();
    if (port && port.isOpen) await cbToPromise((cb) => port.close(cb)).catch(() => undefined);
  }

  /**
   * Send a command and return everything the console printed up to (excluding) the prompt.
   * Commands are queued so only one is in flight.
   */
  command(cmd: string, timeoutMs = this.options.commandTimeoutMs): Promise<string> {
    const run = this.queue.then(() => this.execute(cmd, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execute(cmd: string, timeoutMs: number): Promise<string> {
    const port = this.port;
    if (!port || !port.isOpen) throw new Error('Console port is not open');
    this.buffer = '';
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<string>((resolve, reject) => {
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          () => reject(new ConsoleTimeoutError(cmd, timeoutMs, this.buffer)),
          timeoutMs,
        );
      };
      this.waiter = { resolve, touch: arm };
      arm();
    });
    try {
      await cbToPromise((cb) => port.write(`${cmd}\n`, cb));
      const raw = await response;
      if (raw === '\0closed') throw new Error('Console port closed while waiting for response');
      return raw;
    } finally {
      if (timer) clearTimeout(timer);
      this.waiter = undefined;
    }
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    if (!this.waiter) return;
    this.waiter.touch();
    if (PAGER_PROMPT.test(this.buffer)) {
      // Long output is paged; strip the pager line and press Enter for the next page.
      this.buffer = this.buffer.replace(PAGER_PROMPT, '');
      this.port?.write('\n');
      return;
    }
    const idx = this.buffer.lastIndexOf(PROMPT);
    if (idx < 0) return;
    if (this.buffer.slice(idx + PROMPT.length).trim().length > 0) return; // prompt not at the end
    const body = this.buffer.slice(0, idx);
    const { resolve } = this.waiter;
    this.waiter = undefined;
    resolve(body);
  }

  private failWaiter(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.resolve('\0closed');
  }
}
