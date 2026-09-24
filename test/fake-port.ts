/** In-memory stand-in for a serialport stream that behaves like a Pylontech console. */
import { EventEmitter } from 'node:events';
import type { SerialLike } from '../src/console.js';
import { PROMPT, WAKE_SEQUENCE } from '../src/console.js';
import { fixture } from './helpers.js';

export interface FakePortOptions {
  /** Map of command → response body (fixture file name or literal text). */
  responses?: Record<string, string>;
  /** Console starts at 1200 baud and only answers after the wake sequence + baud switch. */
  requireWake?: boolean;
  /** Commands that never get answered (simulate a hung console). */
  silent?: string[];
  /** For silent commands: text emitted without a trailing prompt (simulates a stalled long output). */
  partial?: Record<string, string>;
  /** Delay between write and response in ms. */
  latencyMs?: number;
  /** Fail open() with this error. */
  openError?: Error;
  /** Commands whose output is paged: number of lines per page. */
  pageLines?: Record<string, number>;
}

const PAGER = 'Press [Enter] to be continued,other key to exit';

const DEFAULT_RESPONSES: Record<string, string> = {
  pwr: 'pwr-us3000c.txt',
  'info 1': 'info-us3000c.txt',
  'info 2': 'info-us3000c.txt',
  'bat 1': 'bat-us3000c.txt',
  'bat 2': 'bat-us2000.txt',
  'stat 1': 'stat-us3000c-b69.txt',
  'stat 2': 'stat-us3000c-b69.txt',
  'soh 1': 'soh-us3000c.txt',
  'soh 2': 'soh-us3000c.txt',
};

export class FakePort extends EventEmitter implements SerialLike {
  isOpen = false;
  baudRate: number;
  woken = false;
  writes: string[] = [];
  commands: string[] = [];
  private pending: string[] | undefined; // remaining pages

  constructor(
    public readonly path: string,
    baudRate: number,
    private readonly opts: FakePortOptions = {},
  ) {
    super();
    this.baudRate = baudRate;
  }

  open(cb?: (err: Error | null) => void): void {
    if (this.opts.openError) {
      queueMicrotask(() => cb?.(this.opts.openError!));
      return;
    }
    this.isOpen = true;
    queueMicrotask(() => {
      this.emit('open');
      cb?.(null);
    });
  }

  close(cb?: (err: Error | null) => void): void {
    this.isOpen = false;
    queueMicrotask(() => {
      this.emit('close');
      cb?.(null);
    });
  }

  /** Simulate the cable being unplugged. */
  disconnect(): void {
    this.isOpen = false;
    this.emit('close', new Error('Disconnected'));
  }

  drain(cb?: (err: Error | null) => void): void {
    queueMicrotask(() => cb?.(null));
  }

  update(opts: { baudRate: number }, cb?: (err: Error | null) => void): void {
    this.baudRate = opts.baudRate;
    queueMicrotask(() => cb?.(null));
  }

  write(data: string | Buffer, cb?: (err: Error | null | undefined) => void): boolean {
    const s = typeof data === 'string' ? data : data.toString('latin1');
    this.writes.push(s);
    queueMicrotask(() => cb?.(null));
    if (s === WAKE_SEQUENCE) {
      if (this.baudRate === 1200) this.woken = true;
      return true;
    }
    const ready = !this.opts.requireWake || (this.woken && this.baudRate === 115200);
    if (!ready) return true; // console at wrong baud: garbage in, nothing out
    const cmd = s.replace(/\n$/, '');
    if (cmd === '' && this.pending) {
      // Enter pressed at the pager prompt: emit the next page.
      const page = this.pending.shift()!;
      const last = this.pending.length === 0;
      if (last) this.pending = undefined;
      queueMicrotask(() =>
        this.emit('data', Buffer.from(page + (last ? PROMPT : PAGER), 'latin1')),
      );
      return true;
    }
    this.commands.push(cmd);
    if (this.opts.silent?.includes(cmd)) {
      const partial = this.opts.partial?.[cmd];
      if (partial) queueMicrotask(() => this.emit('data', Buffer.from(partial, 'latin1')));
      return true;
    }
    const key = this.opts.responses?.[cmd] ?? DEFAULT_RESPONSES[cmd];
    let body: string;
    if (cmd === '') body = '\r\n';
    else if (key === undefined) body = `${cmd}\r\n@\r\nInvalid command\r\n$$\r\n`;
    else body = key.endsWith('.txt') ? fixture(key).replace(/pylon>$/, '') : key;
    const perPage = this.opts.pageLines?.[cmd];
    if (perPage) {
      const lines = body.split(/(?<=\n)/);
      const pages: string[] = [];
      for (let i = 0; i < lines.length; i += perPage)
        pages.push(lines.slice(i, i + perPage).join(''));
      const first = pages.shift()!;
      this.pending = pages;
      queueMicrotask(() => this.emit('data', Buffer.from(first + PAGER, 'latin1')));
      return true;
    }
    const respond = () => {
      if (!this.isOpen) return;
      // Deliver in two chunks to exercise buffering.
      const mid = Math.floor(body.length / 2);
      this.emit('data', Buffer.from(body.slice(0, mid), 'latin1'));
      this.emit('data', Buffer.from(body.slice(mid) + PROMPT, 'latin1'));
    };
    if (this.opts.latencyMs) setTimeout(respond, this.opts.latencyMs);
    else queueMicrotask(respond);
    return true;
  }
}
