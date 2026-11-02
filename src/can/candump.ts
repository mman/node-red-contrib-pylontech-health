/**
 * SocketCAN access by way of the `can-utils` binaries that Venus OS already ships
 * (`/usr/bin/candump`, `/usr/bin/cansend`).
 *
 * Shelling out rather than binding AF_CAN directly is deliberate: the npm `socketcan`
 * package needs a node-gyp build and publishes no prebuilds, so it cannot be installed
 * on a GX device, while `serialport` can. `candump` also needs no privileges — a CAN_RAW
 * socket is not gated behind CAP_NET_RAW on current kernels, and reading a SocketCAN
 * interface does not conflict with the `can-bus-bms` driver that owns the same bus,
 * because every bound socket receives its own copy of each frame.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { formatCanId, type CanFrame } from './frames.js';

/**
 * One `candump` output line.
 *
 * Handles the bare form and the `-t <mode>` timestamped form:
 *
 *     can1  373   [8]  A8 0C D1 0C 28 01 2B 01
 *    (000.000266)  can1  373   [8]  A8 0C D1 0C 28 01 2B 01
 *
 * An id longer than three hex digits is an extended (29-bit) identifier. Error and
 * remote-request frames are not data and return undefined, as do lines we cannot parse.
 */
export function parseCandumpLine(line: string): CanFrame | undefined {
  if (/ERRORFRAME/i.test(line)) return undefined;
  const m =
    /^\s*(?:\(\s*[\d.]+\s*\)\s+)?\S+\s+([0-9A-Fa-f]{3,8})\s+\[(\d+)\]((?:\s+[0-9A-Fa-f]{2})*)\s*$/.exec(
      line,
    );
  if (!m) return undefined;
  const [, rawId, rawLen, rawData] = m;
  const id = Number.parseInt(rawId!, 16);
  if (!Number.isFinite(id)) return undefined;
  const data = (rawData ?? '')
    .trim()
    .split(/\s+/)
    .filter((b) => b.length > 0)
    .map((b) => Number.parseInt(b, 16));
  // A remote-request frame announces a length but carries no bytes; skip it.
  if (data.length === 0 && Number.parseInt(rawLen!, 10) > 0) return undefined;
  return { id, ext: rawId!.length > 3, data };
}

/** Frame source, injectable so tests can replay a recorded capture. */
export interface CanReader {
  /** Frames as they arrive, until {@link CanReader.close} is called. */
  frames(): AsyncIterable<CanFrame>;
  /** Put a frame on the bus. Rejects if this reader cannot transmit. */
  send(frame: CanFrame): Promise<void>;
  close(): Promise<void>;
}

export type CanReaderFactory = (iface: string) => CanReader;

/** Hex payload in the `ID#DATA` notation `cansend` expects. */
export function formatCansendArg(frame: CanFrame): string {
  const data = frame.data.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return `${formatCanId(frame.id, frame.ext)}#${data}`;
}

const notFound = (binary: string, iface: string, err: NodeJS.ErrnoException): Error =>
  err.code === 'ENOENT'
    ? new Error(
        `${binary} not found. It ships with Venus OS in /usr/bin; on other hosts install can-utils. ` +
          `Interface was "${iface}".`,
      )
    : err;

class CandumpReader implements CanReader {
  private child: ChildProcess | undefined;
  private closed = false;

  constructor(private readonly iface: string) {}

  frames(): AsyncIterable<CanFrame> {
    const child = spawn('candump', [this.iface], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const iface = this.iface;
    const closedByUs = (): boolean => this.closed;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    // A candump that dies — most often a misspelled interface — must surface its
    // error rather than look like a bus that simply went quiet. Its stdout usually
    // closes a tick before the exit event, so record the failure and also check for
    // it once the line stream ends.
    let failure: Error | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      const fail = (err: Error) => {
        failure = err;
        reject(err);
      };
      child.once('error', (err: NodeJS.ErrnoException) => fail(notFound('candump', iface, err)));
      child.once('exit', (code, signal) => {
        if (closedByUs()) return;
        fail(
          new Error(
            `candump ${iface} exited ${signal ? `on ${signal}` : `with code ${code}`}` +
              `${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          ),
        );
      });
    });
    // Nothing else observes this promise until the race below, and an early
    // rejection would otherwise be an unhandled one.
    failed.catch(() => undefined);

    return {
      async *[Symbol.asyncIterator]() {
        const iterator = lines[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await Promise.race([iterator.next(), failed]);
            if (next.done) {
              // Give a pending exit event the chance to land before concluding the
              // bus was merely silent.
              await new Promise((resolve) => setImmediate(resolve));
              if (failure) throw failure;
              return;
            }
            const frame = parseCandumpLine(next.value);
            if (frame) yield frame;
          }
        } finally {
          lines.close();
        }
      },
    };
  }

  send(frame: CanFrame): Promise<void> {
    const arg = formatCansendArg(frame);
    return new Promise((resolve, reject) => {
      const child = spawn('cansend', [this.iface, arg], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (err: NodeJS.ErrnoException) =>
        reject(notFound('cansend', this.iface, err)),
      );
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `cansend ${this.iface} ${arg} exited with code ${code}` +
                  `${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
              ),
            ),
      );
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}

/** Default factory: reads via `candump <iface>` and transmits via `cansend <iface>`. */
export const spawnCandump: CanReaderFactory = (iface: string) => new CandumpReader(iface);

/** Replay a recorded `candump` capture. Used by the tests; transmitting is refused. */
export function replayReader(text: string): CanReader {
  const frames = text
    .split('\n')
    .map(parseCandumpLine)
    .filter((f): f is CanFrame => f !== undefined);
  return {
    frames: () => ({
      async *[Symbol.asyncIterator]() {
        for (const f of frames) yield f;
      },
    }),
    send: () => Promise.reject(new Error('replay reader cannot transmit')),
    close: () => Promise.resolve(),
  };
}
