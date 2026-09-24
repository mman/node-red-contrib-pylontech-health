/**
 * Node-RED runtime for the `pylontech-health` node.
 *
 * Exported as a named function so tests can load it directly; the
 * `pylontech-health.ts` shim assigns it to `module.exports` for Node-RED.
 */
import type { Node, NodeAPI, NodeDef, NodeMessage, NodeMessageInFlow } from 'node-red';
import { ConsoleTimeoutError, PylontechConsole, type PortFactory } from './console.js';
import type { InfluxPoint, PointOptions, StackReading } from './model.js';
import { toPoints } from './points.js';
import { pollStack, type InfoCacheEntry } from './poller.js';

export interface PylontechHealthNodeDef extends NodeDef {
  port?: string;
  baud?: number | string;
  wakeup?: boolean | string;
  chain?: number | string;
  measurementPrefix?: string;
  cellIndexBase?: number | string;
  includeStates?: boolean | string;
  refreshInfoEvery?: number | string;
  commandTimeout?: number | string;
  pollTimeout?: number | string;
  readSoh?: boolean | string;
  readStat?: boolean | string;
}

interface Settings {
  port: string;
  baud: number;
  wakeup: boolean;
  chain: number;
  commandTimeoutMs: number;
  pollTimeoutMs: number;
  infoTtlMs: number;
  readSoh: boolean;
  readStat: boolean;
  points: PointOptions;
}

const num = (v: unknown, dflt: number): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : dflt;
};
const bool = (v: unknown, dflt: boolean): boolean => {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return v === 'true' || v === '1' || v === 'on';
};

export function readSettings(def: PylontechHealthNodeDef): Settings {
  return {
    port: (def.port ?? '').trim() || '/dev/ttyUSB0',
    baud: num(def.baud, 115200),
    wakeup: bool(def.wakeup, true),
    chain: Math.max(1, Math.trunc(num(def.chain, 1))),
    commandTimeoutMs: Math.max(200, num(def.commandTimeout, 3000)),
    pollTimeoutMs: Math.max(1000, num(def.pollTimeout, 30000)),
    infoTtlMs: Math.max(0, num(def.refreshInfoEvery, 60)) * 60_000,
    readSoh: bool(def.readSoh, false),
    readStat: bool(def.readStat, true),
    points: {
      measurementPrefix: (def.measurementPrefix ?? '').trim() || 'pylontech',
      cellIndexBase: num(def.cellIndexBase, 1) === 0 ? 0 : 1,
      includeStates: bool(def.includeStates, true),
    },
  };
}

export interface PylontechHealthMessage extends NodeMessageInFlow {
  /** Raw console command passthrough (debug/fixture capture). */
  command?: string;
  /** Force `info N` refresh on this poll. */
  refresh?: boolean;
}

export interface HealthOutput extends NodeMessage {
  payload: StackReading | { command: string; raw: string } | null;
  error?: string;
}

export interface PointsOutput extends NodeMessage {
  payload: InfluxPoint[];
}

/** Test seam: replace the serial port implementation. */
let portFactory: PortFactory | undefined;
export function setPortFactory(factory: PortFactory | undefined): void {
  portFactory = factory;
}

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

export function registerPylontechHealth(RED: NodeAPI): void {
  function PylontechHealthNode(this: Node, def: PylontechHealthNodeDef): void {
    RED.nodes.createNode(this, def);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const node = this;
    const settings = readSettings(def);
    const infoCache = new Map<number, InfoCacheEntry>();

    let console_: PylontechConsole | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let reconnectDelay = RECONNECT_MIN_MS;
    let closed = false;
    let polling = false;

    const status = (
      fill: 'red' | 'green' | 'yellow' | 'blue' | 'grey',
      shape: 'ring' | 'dot',
      text: string,
    ) => node.status({ fill, shape, text });

    function scheduleReconnect(reason: string): void {
      if (closed || reconnectTimer) return;
      status('red', 'ring', `${reason} · retry in ${Math.round(reconnectDelay / 1000)}s`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    async function connect(): Promise<void> {
      if (closed || console_) return;
      status('yellow', 'ring', `connecting ${settings.port}`);
      const con = new PylontechConsole({
        path: settings.port,
        baudRate: settings.baud,
        wakeup: settings.wakeup,
        commandTimeoutMs: settings.commandTimeoutMs,
        ...(portFactory ? { createPort: portFactory } : {}),
      });
      con.on('error', (err: Error) => node.warn(`serial error: ${err.message}`));
      con.on('close', () => {
        if (console_ === con) console_ = undefined;
        if (!closed) {
          node.warn(`port ${settings.port} closed unexpectedly`);
          scheduleReconnect('port closed');
        }
      });
      console_ = con;
      try {
        await con.open();
        reconnectDelay = RECONNECT_MIN_MS;
        status('green', 'dot', 'ready');
        node.log(`connected to Pylontech console on ${settings.port}`);
      } catch (err) {
        console_ = undefined;
        const msg = (err as Error).message;
        node.error(`cannot open ${settings.port}: ${msg}`);
        scheduleReconnect(msg.length > 40 ? 'open failed' : msg);
      }
    }

    async function reconnect(): Promise<void> {
      const con = console_;
      console_ = undefined;
      if (con) await con.close().catch(() => undefined);
      await connect();
    }

    async function runRawCommand(
      msg: PylontechHealthMessage,
      con: PylontechConsole,
      send: (m: [null, HealthOutput]) => void,
    ): Promise<void> {
      const command = String(msg.command).trim();
      const raw = await con.command(command);
      send([null, { ...msg, topic: 'pylontech/raw', payload: { command, raw } } as HealthOutput]);
      status('green', 'dot', `ran "${command}"`);
    }

    async function runPoll(
      msg: PylontechHealthMessage,
      con: PylontechConsole,
      send: (m: [PointsOutput, HealthOutput]) => void,
    ): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ConsoleTimeoutError('poll', settings.pollTimeoutMs, '')),
          settings.pollTimeoutMs,
        );
      });
      try {
        const reading = await Promise.race([
          pollStack((c) => con.command(c), {
            chain: settings.chain,
            cellIndexBase: settings.points.cellIndexBase,
            readSoh: settings.readSoh,
            readStat: settings.readStat,
            infoCache,
            infoTtlMs: settings.infoTtlMs,
            refreshInfo: msg.refresh === true,
            onProgress: (done, total, step) =>
              status(
                'blue',
                'dot',
                total ? `polling ${done}/${total} · ${step}` : `polling · ${step}`,
              ),
          }),
          timeout,
        ]);
        if (reading.sohUnsupported && settings.readSoh) {
          settings.readSoh = false;
          node.warn('this firmware has no "soh" command; state of health disabled for this node');
        }
        if (reading.statUnsupported && settings.readStat) {
          settings.readStat = false;
          node.warn(
            'this firmware has no "stat" command; lifetime statistics disabled for this node',
          );
        }
        const points = toPoints(reading, settings.points);
        const cells = reading.batteries.reduce((a, b) => a + b.cells.length, 0);
        for (const e of reading.errors) node.warn(e);
        status(
          reading.errors.length ? 'yellow' : 'green',
          'dot',
          `${reading.batteries.length} batt · ${cells} cells · ${(reading.durationMs / 1000).toFixed(1)}s` +
            (reading.errors.length ? ` · ${reading.errors.length} err` : ''),
        );
        send([
          { ...msg, topic: 'pylontech/points', payload: points } as PointsOutput,
          { ...msg, topic: 'pylontech/health', payload: reading } as HealthOutput,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    node.on('input', (msg: PylontechHealthMessage, send, done) => {
      const con = console_;
      if (!con || !con.isOpen) {
        done(new Error(`Pylontech console on ${settings.port} is not connected`));
        return;
      }
      if (polling) {
        node.warn('poll already in progress, message dropped');
        done();
        return;
      }
      polling = true;
      const task =
        typeof msg.command === 'string' && msg.command.trim().length > 0
          ? runRawCommand(msg, con, send as (m: [null, HealthOutput]) => void)
          : runPoll(msg, con, send as (m: [PointsOutput, HealthOutput]) => void);
      task
        .then(() => done())
        .catch((err: Error) => {
          status('red', 'ring', err.message.length > 40 ? 'poll failed' : err.message);
          send([
            null,
            {
              ...msg,
              topic: 'pylontech/health',
              payload: null,
              error: err.message,
            } as HealthOutput,
          ]);
          done(err);
          if (err instanceof ConsoleTimeoutError) void reconnect();
        })
        .finally(() => {
          polling = false;
        });
    });

    node.on('close', (removed: boolean, done: () => void) => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const con = console_;
      console_ = undefined;
      void (con ? con.close() : Promise.resolve())
        .catch(() => undefined)
        .finally(() => {
          node.status({});
          done();
        });
      void removed;
    });

    void connect();
  }

  RED.nodes.registerType(
    'pylontech-health',
    PylontechHealthNode as unknown as Parameters<NodeAPI['nodes']['registerType']>[1],
  );
}
