#!/usr/bin/env node
/**
 * Command-line companion to the pylontech-health node. Runs the same console,
 * poll and point-building code without Node-RED, for checking a new installation.
 *
 *   pylontech-health [options] probe
 *   pylontech-health [options] poll
 *   pylontech-health [options] points [--only cell|battery|stack] [--format json|line]
 *   pylontech-health [options] raw <command...>
 *   pylontech-health [options] capture <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConsoleTimeoutError, PylontechConsole, type PortFactory } from './console.js';
import { toLineProtocolBatch } from './lineprotocol.js';
import type { InfluxPoint, PointOptions } from './model.js';
import { parseInfo, parsePwr } from './parsers.js';
import { toPoints } from './points.js';
import { pollStack, type InfoCacheEntry } from './poller.js';

export const USAGE = `Usage: pylontech-health [options] <command>

Commands:
  probe                 open the port, wake the console, verify the prompt, print master "info"
  poll                  full pwr / info N / bat N cycle, print the structured model as JSON
  points                same as poll, print InfluxDB points
  raw <command...>      run one raw console command (e.g. raw bat 2) and print its output
  capture <dir>         save pwr, info N, bat N (and soh N) outputs as fixture files in <dir>

Options:
  -p, --port <path>     serial device            (default /dev/ttyPYLON)
  -b, --baud <n>        console baud rate        (default 115200)
      --no-wakeup       skip the 1200-baud wake sequence
      --chain <n>       chain tag                (default 1)
      --prefix <name>   measurement prefix       (default pylontech)
      --cell-base <0|1> cell numbering           (default 1)
      --no-states       omit *_state string fields
      --soh             also read soh N (per-cell SOH, not on all firmware)
      --no-stat         skip stat N (SOH, cycles, lifetime counters)
      --timeout <ms>    per-command timeout      (default 3000)
      --only <m>        points: cell | battery | stack (repeatable)
      --format <f>      points: json | line      (default json)
  -h, --help
`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface CliDeps {
  createPort?: PortFactory;
  now?: () => number;
}

export interface CliOptions {
  port: string;
  baud: number;
  wakeup: boolean;
  chain: number;
  timeoutMs: number;
  readSoh: boolean;
  readStat: boolean;
  points: PointOptions;
  only: Array<'cell' | 'battery' | 'stack'>;
  format: 'json' | 'line';
  command: string;
  positionals: string[];
  help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: '/dev/ttyPYLON' },
      baud: { type: 'string', short: 'b', default: '115200' },
      wakeup: { type: 'boolean', default: true },
      'no-wakeup': { type: 'boolean', default: false },
      chain: { type: 'string', default: '1' },
      prefix: { type: 'string', default: 'pylontech' },
      'cell-base': { type: 'string', default: '1' },
      states: { type: 'boolean', default: true },
      'no-states': { type: 'boolean', default: false },
      soh: { type: 'boolean', default: false },
      'no-stat': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '3000' },
      only: { type: 'string', multiple: true, default: [] },
      format: { type: 'string', default: 'json' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const int = (v: string | undefined, name: string, dflt: number): number => {
    const n = Number.parseInt(v ?? '', 10);
    if (v === undefined || v === '') return dflt;
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
    return n;
  };
  const only = (values.only ?? []).map((o) => {
    if (o !== 'cell' && o !== 'battery' && o !== 'stack')
      throw new Error(`--only must be cell, battery or stack, got "${o}"`);
    return o;
  });
  const format = values.format ?? 'json';
  if (format !== 'json' && format !== 'line')
    throw new Error(`--format must be json or line, got "${format}"`);
  const [command = '', ...rest] = positionals;
  return {
    port: values.port ?? '/dev/ttyPYLON',
    baud: int(values.baud, 'baud', 115200),
    wakeup: !values['no-wakeup'],
    chain: Math.max(1, int(values.chain, 'chain', 1)),
    timeoutMs: Math.max(200, int(values.timeout, 'timeout', 3000)),
    readSoh: values.soh ?? false,
    readStat: !values['no-stat'],
    points: {
      measurementPrefix: values.prefix || 'pylontech',
      cellIndexBase: int(values['cell-base'], 'cell-base', 1) === 0 ? 0 : 1,
      includeStates: !values['no-states'],
    },
    only,
    format,
    command,
    positionals: rest,
    help: values.help ?? false,
  };
}

const jsonReplacer = (_k: string, v: unknown): unknown =>
  v instanceof Map ? Object.fromEntries(v) : v;
const json = (v: unknown): string => JSON.stringify(v, jsonReplacer, 2);

async function withConsole<T>(
  opts: CliOptions,
  io: CliIO,
  deps: CliDeps,
  fn: (con: PylontechConsole) => Promise<T>,
): Promise<T> {
  const con = new PylontechConsole({
    path: opts.port,
    baudRate: opts.baud,
    wakeup: opts.wakeup,
    commandTimeoutMs: opts.timeoutMs,
    ...(deps.createPort ? { createPort: deps.createPort } : {}),
  });
  con.on('error', (err: Error) => io.err(`serial error: ${err.message}`));
  io.err(
    `opening ${opts.port} at ${opts.baud} baud${opts.wakeup ? ' (with 1200-baud wake sequence)' : ''} …`,
  );
  const t0 = Date.now();
  await con.open();
  io.err(`console answered with prompt after ${Date.now() - t0} ms`);
  try {
    return await fn(con);
  } finally {
    await con.close();
  }
}

function pollOptions(opts: CliOptions, deps: CliDeps) {
  return {
    chain: opts.chain,
    cellIndexBase: opts.points.cellIndexBase,
    readSoh: opts.readSoh,
    readStat: opts.readStat,
    infoCache: new Map<number, InfoCacheEntry>(),
    infoTtlMs: 0,
    refreshInfo: true,
    ...(deps.now ? { now: deps.now } : {}),
  };
}

export async function runCli(argv: string[], io: CliIO, deps: CliDeps = {}): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    io.err((err as Error).message);
    io.err(USAGE);
    return 2;
  }
  if (opts.help || opts.command === '') {
    io.out(USAGE);
    return opts.help ? 0 : 2;
  }

  try {
    switch (opts.command) {
      case 'probe': {
        await withConsole(opts, io, deps, async (con) => {
          const pwr = parsePwr(await con.command('pwr'));
          io.err(
            `pwr reports ${pwr.length} battery(ies) at position(s) ${pwr.map((r) => r.position).join(', ')}`,
          );
          const info = parseInfo(await con.command('info'));
          io.out(json({ port: opts.port, batteries: pwr.map((r) => r.position), master: info }));
        });
        return 0;
      }
      case 'poll': {
        const reading = await withConsole(opts, io, deps, (con) =>
          pollStack((c) => con.command(c), {
            ...pollOptions(opts, deps),
            onProgress: (_d, _t, step) => io.err(`  ${step}`),
          }),
        );
        io.out(json(reading));
        for (const e of reading.errors) io.err(`warning: ${e}`);
        return reading.errors.length ? 1 : 0;
      }
      case 'points': {
        const reading = await withConsole(opts, io, deps, (con) =>
          pollStack((c) => con.command(c), {
            ...pollOptions(opts, deps),
            onProgress: (_d, _t, step) => io.err(`  ${step}`),
          }),
        );
        let points: InfluxPoint[] = toPoints(reading, opts.points);
        if (opts.only.length) {
          const wanted = new Set(opts.only.map((o) => `${opts.points.measurementPrefix}/${o}`));
          points = points.filter((p) => wanted.has(p.measurement));
        }
        io.out(opts.format === 'line' ? toLineProtocolBatch(points) : json(points));
        io.err(`${points.length} point(s)` + (opts.format === 'line' ? ', timestamps in ms' : ''));
        for (const e of reading.errors) io.err(`warning: ${e}`);
        return reading.errors.length ? 1 : 0;
      }
      case 'raw': {
        const cmd = opts.positionals.join(' ').trim();
        if (!cmd) throw new Error('raw needs a console command, e.g. raw bat 2');
        const out = await withConsole(opts, io, deps, (con) => con.command(cmd));
        io.out(out.replace(/\r/g, ''));
        return 0;
      }
      case 'capture': {
        const dir = opts.positionals[0];
        if (!dir) throw new Error('capture needs a target directory');
        mkdirSync(dir, { recursive: true });
        const files = await withConsole(opts, io, deps, async (con) => {
          const saved: string[] = [];
          const save = async (cmd: string) => {
            const raw = await con.command(cmd);
            const file = join(dir, `${cmd.replace(/\s+/g, '-')}.txt`);
            writeFileSync(file, `${raw}pylon>`);
            saved.push(file);
            io.err(`  ${cmd} → ${file}`);
            return raw;
          };
          const rows = parsePwr(await save('pwr'));
          await save('info');
          for (const r of rows) {
            await save(`info ${r.position}`);
            await save(`bat ${r.position}`);
            if (opts.readStat) await save(`stat ${r.position}`);
            if (opts.readSoh) await save(`soh ${r.position}`);
          }
          return saved;
        });
        io.out(json({ dir, files }));
        return 0;
      }
      default:
        io.err(`Unknown command "${opts.command}"`);
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    if (err instanceof ConsoleTimeoutError && err.partial.trim().length > 0) {
      io.err(`--- ${err.partial.length} byte(s) received before the timeout ---`);
      io.err(err.partial.replace(/\r/g, ''));
      io.err('--- end of partial output ---');
    }
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
      process.exit(1);
    },
  );
}
