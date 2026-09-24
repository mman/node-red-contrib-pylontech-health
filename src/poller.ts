/** Orchestrates one poll cycle: pwr → info N (cached) → bat N (→ soh N). */
import type { Battery, BatteryInfo, BatteryStat, StackReading } from './model.js';
import {
  assembleBattery,
  isNotPresent,
  isUnknownCommand,
  parseBat,
  parseInfo,
  parsePwr,
  parseSoh,
  parseStat,
  UnsupportedCommandError,
} from './parsers.js';

export type CommandFn = (cmd: string) => Promise<string>;

export interface InfoCacheEntry {
  info: BatteryInfo | undefined;
  stat: BatteryStat | undefined;
  fetchedAt: number;
}

export interface PollOptions {
  chain: number;
  cellIndexBase: 0 | 1;
  readSoh: boolean;
  /** Read `stat N` (SOH, cycles, lifetime counters) together with `info N`. Default true. */
  readStat?: boolean;
  /** Mutable cache, keyed by stack position. */
  infoCache: Map<number, InfoCacheEntry>;
  infoTtlMs: number;
  /** Force re-reading `info N` for every battery. */
  refreshInfo?: boolean;
  onProgress?: (done: number, total: number, step: string) => void;
  now?: () => number;
}

export async function pollStack(command: CommandFn, opts: PollOptions): Promise<StackReading> {
  const now = opts.now ?? Date.now;
  const started = now();
  const errors: string[] = [];
  const batteries: Battery[] = [];
  let sohUnsupported = false;
  let statUnsupported = false;
  const readStat = opts.readStat ?? true;

  opts.onProgress?.(0, 0, 'pwr');
  const rows = parsePwr(await command('pwr'));
  const total = rows.length;

  for (const [i, row] of rows.entries()) {
    const n = row.position;
    let info: BatteryInfo | undefined;
    let stat: BatteryStat | undefined;
    const cached = opts.infoCache.get(n);
    if (!opts.refreshInfo && cached && now() - cached.fetchedAt < opts.infoTtlMs) {
      info = cached.info;
      stat = cached.stat;
    } else {
      opts.onProgress?.(i, total, `info ${n}`);
      try {
        info = parseInfo(await command(`info ${n}`));
      } catch (err) {
        errors.push(`info ${n}: ${(err as Error).message}`);
        info = cached?.info;
      }
      if (readStat && !statUnsupported) {
        opts.onProgress?.(i, total, `stat ${n}`);
        try {
          const raw = await command(`stat ${n}`);
          if (isUnknownCommand(raw)) throw new UnsupportedCommandError('stat');
          if (isNotPresent(raw)) throw new Error('target device is not present');
          stat = parseStat(raw);
        } catch (err) {
          errors.push(`stat ${n}: ${(err as Error).message}`);
          if (err instanceof UnsupportedCommandError) statUnsupported = true;
          stat = cached?.stat;
        }
      }
      opts.infoCache.set(n, { info, stat, fetchedAt: now() });
    }

    opts.onProgress?.(i, total, `bat ${n}`);
    let cells: Battery['cells'] = [];
    try {
      cells = parseBat(await command(`bat ${n}`));
    } catch (err) {
      errors.push(`bat ${n}: ${(err as Error).message}`);
    }

    if (opts.readSoh && !sohUnsupported && cells.length > 0) {
      opts.onProgress?.(i, total, `soh ${n}`);
      try {
        const raw = await command(`soh ${n}`);
        if (isUnknownCommand(raw)) throw new UnsupportedCommandError('soh');
        const soh = parseSoh(raw);
        for (const c of cells) {
          const v = soh.get(c.index);
          if (v !== undefined) c.soh = v;
        }
      } catch (err) {
        errors.push(`soh ${n}: ${(err as Error).message}`);
        if (err instanceof UnsupportedCommandError) sohUnsupported = true;
      }
    }

    batteries.push(assembleBattery(row, info, cells, opts.cellIndexBase, stat));
  }
  opts.onProgress?.(total, total, 'done');

  return {
    chain: opts.chain,
    polledAt: new Date(started),
    durationMs: now() - started,
    batteries,
    errors,
    sohUnsupported,
    statUnsupported,
  };
}
