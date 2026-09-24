/**
 * Pure parsers for Pylontech console command output.
 *
 * Each parser accepts the raw text returned by the console (echo, `@`, `$$`,
 * prompt and "Command completed successfully" lines are tolerated) and returns
 * typed objects with SI units (V, A, °C, Ah).
 */
import type { Battery, BatteryInfo, BatteryStat, Cell, CellStats, PowerRow } from './model.js';

const NOISE_LINES = new Set(['@', '$$', 'pylon>', 'Command completed successfully']);

/** Multi-word / punctuated header tokens → single canonical key. */
const HEADER_ALIASES: Array<[RegExp, string]> = [
  [/Base\s*State/i, 'BaseState'],
  [/Volt\.?\s*State/i, 'VoltState'],
  [/Curr\.?\s*State/i, 'CurrState'],
  [/Temp\.?\s*State/i, 'TempState'],
  [/Base\.St/i, 'BaseState'],
  [/Volt\.St/i, 'VoltState'],
  [/Curr\.St/i, 'CurrState'],
  [/Temp\.St/i, 'TempState'],
  [/B\.V\.St/i, 'BVState'],
  [/B\.T\.St/i, 'BTState'],
  [/M\.T\.St/i, 'MTState'],
];

/** True when the console rejected the command (e.g. `Unknown command 'soh' - try 'help'`). */
export function isUnknownCommand(raw: string): boolean {
  return /Unknown command|Invalid command|Command failed/i.test(raw);
}

/** True when the console reports the addressed battery is missing (`Target device is not present`). */
export function isNotPresent(raw: string): boolean {
  return /not present/i.test(raw);
}

export class UnsupportedCommandError extends Error {
  constructor(public readonly command: string) {
    super(`${command}: not supported by this firmware`);
    this.name = 'UnsupportedCommandError';
  }
}

/** Split console output into meaningful body lines. */
export function bodyLines(raw: string): string[] {
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !NOISE_LINES.has(l))
    .filter((l) => !/^pylon>/.test(l));
}

function normaliseHeader(line: string): string[] {
  let h = line;
  for (const [re, key] of HEADER_ALIASES) h = h.replace(re, key);
  return h.split(/\s+/).filter(Boolean);
}

/** Join tokens that the firmware prints with an internal space. */
function normaliseRow(line: string): string[] {
  const l = line
    // "43247 mAH" -> "43247mAH"
    .replace(/(-?\d+)\s+(mAH|mAh|mah|AH|Ah)\b/g, '$1$2')
    // "2023-01-15 12:03:22" -> "2023-01-15T12:03:22"
    .replace(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/g, '$1T$2');
  return l.split(/\s+/).filter(Boolean);
}

interface Table {
  headers: string[];
  rows: Record<string, string>[];
}

/** Find the header line (first line containing `firstHeader`) and map rows onto it. */
function parseTable(raw: string, firstHeader: RegExp): Table {
  const lines = bodyLines(raw);
  const headerIdx = lines.findIndex((l) => firstHeader.test(l));
  if (headerIdx < 0) throw new Error(`No table header found in output: ${lines[0] ?? '<empty>'}`);
  const headers = normaliseHeader(lines[headerIdx]!);
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const tokens = normaliseRow(line);
    // A data row must start with a number (position or cell index).
    if (!/^\d+$/.test(tokens[0] ?? '')) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = tokens[i];
      if (v !== undefined) row[h] = v;
    });
    rows.push(row);
  }
  return { headers, rows };
}

const milli = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '-') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n / 1000 : undefined;
};
const percent = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v.replace('%', ''), 10);
  return Number.isFinite(n) ? n : undefined;
};
const mAh = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const m = /^(-?\d+)\s*(mAH|AH)?$/i.exec(v);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  const unit = (m[2] ?? 'mAH').toLowerCase();
  return unit === 'ah' ? n : n / 1000;
};
const req = (v: number | undefined, name: string): number => {
  if (v === undefined) throw new Error(`Missing numeric column ${name}`);
  return v;
};

const PWR_KNOWN = new Set([
  'Power',
  'Volt',
  'Curr',
  'Tempr',
  'Tlow',
  'Thigh',
  'Vlow',
  'Vhigh',
  'BaseState',
  'VoltState',
  'CurrState',
  'TempState',
  'Coulomb',
  'Time',
  'BVState',
  'BTState',
  'MosTempr',
  'MTState',
]);

/** Parse `pwr` output. Rows marked Absent (or lacking numeric data) are skipped. */
export function parsePwr(raw: string): PowerRow[] {
  const { rows } = parseTable(raw, /^Power\s+Volt/i);
  const out: PowerRow[] = [];
  for (const r of rows) {
    if (Object.values(r).some((v) => /^absent$/i.test(v))) continue;
    const voltage = milli(r['Volt']);
    if (voltage === undefined) continue;
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) if (!PWR_KNOWN.has(k)) extra[k] = v;
    out.push({
      position: Number.parseInt(r['Power']!, 10),
      voltage,
      current: req(milli(r['Curr']), 'Curr'),
      temperature: req(milli(r['Tempr']), 'Tempr'),
      tempLow: milli(r['Tlow']),
      tempHigh: milli(r['Thigh']),
      voltLow: milli(r['Vlow']),
      voltHigh: milli(r['Vhigh']),
      soc: percent(r['Coulomb']),
      time: r['Time']?.replace('T', ' '),
      mosTemperature: milli(r['MosTempr']),
      states: {
        base: r['BaseState'] ?? '',
        volt: r['VoltState'] ?? '',
        curr: r['CurrState'] ?? '',
        temp: r['TempState'] ?? '',
        bv: r['BVState'],
        bt: r['BTState'],
        mt: r['MTState'],
      },
      extra,
    });
  }
  return out;
}

const BAT_KNOWN = new Set([
  'Battery',
  'Volt',
  'Curr',
  'Tempr',
  'BaseState',
  'VoltState',
  'CurrState',
  'TempState',
  'SOC',
  'Coulomb',
  'BAL',
]);

/** Parse `bat N` output into cells (index as reported, 0-based). */
export function parseBat(raw: string): Cell[] {
  const { rows } = parseTable(raw, /^Battery\s+Volt/i);
  return rows.map((r) => {
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) if (!BAT_KNOWN.has(k)) extra[k] = v;
    const bal = r['BAL'];
    return {
      index: Number.parseInt(r['Battery']!, 10),
      voltage: req(milli(r['Volt']), 'Volt'),
      current: req(milli(r['Curr']), 'Curr'),
      temperature: req(milli(r['Tempr']), 'Tempr'),
      soc: percent(r['SOC']),
      coulombAh: mAh(r['Coulomb']),
      balancing: bal === undefined ? undefined : /^y/i.test(bal),
      states: {
        base: r['BaseState'] ?? '',
        volt: r['VoltState'] ?? '',
        curr: r['CurrState'] ?? '',
        temp: r['TempState'] ?? '',
      },
      extra,
    };
  });
}

/** Parse `soh N` output → map of cell index → SOH percent. */
export function parseSoh(raw: string): Map<number, number> {
  const { rows } = parseTable(raw, /^Battery\s+SOH/i);
  const out = new Map<number, number>();
  for (const r of rows) {
    const idx = Number.parseInt(r['Battery']!, 10);
    const soh = percent(r['SOH']);
    if (soh !== undefined) out.set(idx, soh);
  }
  return out;
}

const int = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

/** Parse `info N` output (`Key : Value` lines). */
export function parseInfo(raw: string): BatteryInfo {
  const kv = keyValueLines(raw);
  if (Object.keys(kv).length === 0) throw new Error('No key/value lines in info output');
  const get = (re: RegExp): string | undefined => {
    const k = Object.keys(kv).find((k) => re.test(k));
    return k === undefined ? undefined : kv[k];
  };
  return {
    deviceAddress: int(get(/^Device address$/i)),
    manufacturer: get(/^Manufacturer$/i),
    deviceName: get(/^Device name$/i),
    barcode: get(/^Barcode$/i),
    pcbaBarcode: get(/^PCBA Barcode$/i),
    specification: get(/^Specification$/i),
    cellNumber: int(get(/^Cell Number$/i)),
    firmware: {
      board: get(/^Board version$/i),
      main: get(/^Main Soft version$/i),
      soft: get(/^Soft version$/i),
      boot: get(/^Boot version$/i),
      comm: get(/^Comm version$/i),
      releaseDate: get(/^Release Date$/i),
    },
    raw: kv,
  };
}

/** Parse `Key : Value` (or `Key   Value`) lines into a map, keys whitespace-normalised. */
function keyValueLines(raw: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of bodyLines(raw)) {
    const i = line.indexOf(':');
    if (i > 0) {
      kv[line.slice(0, i).trim().replace(/\s+/g, ' ')] = line.slice(i + 1).trim();
      continue;
    }
    const m = /^(.*?\S)\s{2,}(\S+)$/.exec(line);
    if (m) kv[m[1]!.replace(/\s+/g, ' ')] = m[2]!;
  }
  return kv;
}

/** Parse `stat N` output (lifetime statistics). */
export function parseStat(raw: string): BatteryStat {
  const kv = keyValueLines(raw);
  if (kv['SOH'] === undefined && kv['CYCLE Times'] === undefined)
    throw new Error('No statistics in stat output');
  const n = (key: string): number | undefined => int(kv[key]);
  const mv = (key: string): number | undefined => {
    const v = n(key);
    return v === undefined ? undefined : v / 1000;
  };
  const secs = n('Pwr on Secs');
  return {
    soh: n('SOH'),
    cycles: n('CYCLE Times'),
    powerOnHours: secs === undefined ? undefined : Number((secs / 3600).toFixed(2)),
    shutdowns: n('Shut Times'),
    resets: n('Reset Times'),
    maxChargeVoltDiff: mv('Max Charge Volt Diff'),
    maxDischargeVoltDiff: mv('Max DisCharge Volt Diff'),
    batteryHighVoltageEvents: n('Bat HV Times'),
    batteryLowVoltageEvents: n('Bat LV Times'),
    batteryOverVoltageEvents: n('Bat OV Times'),
    batteryUnderVoltageEvents: n('Bat UV Times'),
    lifeWarnings: n('LifeWarn Times'),
    lifeAlarms: n('LifeAlarm Times'),
    raw: kv,
  };
}

/** Compute min/max/spread over cells; `indexBase` shifts reported indices. */
export function cellStats(cells: Cell[], indexBase: 0 | 1): CellStats | undefined {
  if (cells.length === 0) return undefined;
  let min = cells[0]!;
  let max = cells[0]!;
  for (const c of cells) {
    if (c.voltage < min.voltage) min = c;
    if (c.voltage > max.voltage) max = c;
  }
  return {
    min: min.voltage,
    max: max.voltage,
    spread: Number((max.voltage - min.voltage).toFixed(3)),
    minCell: min.index + indexBase,
    maxCell: max.index + indexBase,
    count: cells.length,
  };
}

/** Assemble a Battery from its parts. */
export function assembleBattery(
  power: PowerRow,
  info: BatteryInfo | undefined,
  cells: Cell[],
  indexBase: 0 | 1,
  stat?: BatteryStat,
): Battery {
  return {
    position: power.position,
    info,
    stat,
    power,
    cells,
    cellStats: cellStats(cells, indexBase),
  };
}
