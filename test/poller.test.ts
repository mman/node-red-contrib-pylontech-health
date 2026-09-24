import { describe, expect, it } from 'vitest';
import { pollStack, type InfoCacheEntry } from '../src/poller.js';
import { fixture } from './helpers.js';

const RESPONSES: Record<string, string> = {
  pwr: fixture('pwr-us3000c.txt'),
  'info 1': fixture('info-us3000c.txt'),
  'info 2': fixture('info-us3000c.txt').replace('PPTBH02212345678', 'PPTBH02200000002'),
  'bat 1': fixture('bat-us3000c.txt'),
  'bat 2': fixture('bat-us2000.txt'),
  'soh 1': fixture('soh-us3000c.txt'),
  'soh 2': fixture('soh-us3000c.txt'),
  'stat 1': fixture('stat-us3000c-b69.txt'),
  'stat 2': fixture('stat-us3000c-b69.txt'),
};

function commandFn(overrides: Record<string, string | Error> = {}) {
  const log: string[] = [];
  const fn = async (cmd: string): Promise<string> => {
    log.push(cmd);
    const o = overrides[cmd];
    if (o instanceof Error) throw o;
    if (o !== undefined) return o;
    const r = RESPONSES[cmd];
    if (r === undefined) throw new Error(`unexpected command ${cmd}`);
    return r;
  };
  return { fn, log };
}

const base = () => ({
  chain: 1,
  cellIndexBase: 1 as const,
  readSoh: false,
  infoCache: new Map<number, InfoCacheEntry>(),
  infoTtlMs: 60_000,
});

describe('pollStack', () => {
  it('runs pwr, info N, bat N for each present battery', async () => {
    const { fn, log } = commandFn();
    const r = await pollStack(fn, base());
    expect(log).toEqual(['pwr', 'info 1', 'stat 1', 'bat 1', 'info 2', 'stat 2', 'bat 2']);
    expect(r.batteries.map((b) => b.position)).toEqual([1, 2]);
    expect(r.batteries[0]!.stat?.soh).toBe(94);
    expect(r.batteries[0]!.stat?.cycles).toBe(686);
    expect(r.batteries[1]!.info?.barcode).toBe('PPTBH02200000002');
    expect(r.batteries[0]!.cells).toHaveLength(15);
    expect(r.batteries[0]!.cellStats?.minCell).toBe(1);
    expect(r.errors).toEqual([]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the info cache until it expires or refresh is forced', async () => {
    const cache = new Map<number, InfoCacheEntry>();
    let t = 1_000_000;
    const now = () => t;
    const first = commandFn();
    await pollStack(first.fn, { ...base(), infoCache: cache, now });
    expect(cache.size).toBe(2);

    const second = commandFn();
    t += 1000;
    await pollStack(second.fn, { ...base(), infoCache: cache, now });
    expect(second.log).toEqual(['pwr', 'bat 1', 'bat 2']);

    const third = commandFn();
    await pollStack(third.fn, { ...base(), infoCache: cache, now, refreshInfo: true });
    expect(third.log).toContain('info 1');
    expect(third.log).toContain('stat 1');

    const fourth = commandFn();
    t += 120_000;
    await pollStack(fourth.fn, { ...base(), infoCache: cache, now });
    expect(fourth.log).toContain('info 2');
  });

  it('reads soh when enabled and attaches it to cells', async () => {
    const { fn, log } = commandFn();
    const r = await pollStack(fn, { ...base(), readSoh: true });
    expect(log).toContain('soh 1');
    expect(r.batteries[0]!.cells[7]!.soh).toBe(99);
    expect(r.batteries[0]!.cells[0]!.soh).toBe(100);
  });

  it('records per-battery errors and keeps going', async () => {
    const { fn } = commandFn({
      'bat 2': new Error('timeout'),
      'info 1': fixture('bat-absent.txt'),
    });
    const r = await pollStack(fn, base());
    expect(r.batteries).toHaveLength(2);
    expect(r.batteries[1]!.cells).toEqual([]);
    expect(r.batteries[1]!.cellStats).toBeUndefined();
    expect(r.batteries[0]!.info).toBeUndefined();
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/^info 1:/);
    expect(r.errors[1]).toMatch(/^bat 2: timeout/);
    expect(r.batteries[0]!.stat?.soh).toBe(94); // stat still read when info fails
  });

  it('reports progress', async () => {
    const { fn } = commandFn();
    const steps: string[] = [];
    await pollStack(fn, { ...base(), onProgress: (_d, _t, s) => steps.push(s) });
    expect(steps).toEqual([
      'pwr',
      'info 1',
      'stat 1',
      'bat 1',
      'info 2',
      'stat 2',
      'bat 2',
      'done',
    ]);
  });

  it('propagates a pwr failure', async () => {
    const { fn } = commandFn({ pwr: new Error('Console port is not open') });
    await expect(pollStack(fn, base())).rejects.toThrow(/not open/);
  });
});

describe('pollStack on firmware without soh', () => {
  it('flags sohUnsupported after the first rejection and stops asking', async () => {
    const { fn, log } = commandFn({
      'soh 1': fixture('soh-unsupported.txt'),
      'soh 2': fixture('soh-unsupported.txt'),
    });
    const r = await pollStack(fn, { ...base(), readSoh: true });
    expect(r.sohUnsupported).toBe(true);
    expect(log.filter((c) => c.startsWith('soh'))).toEqual(['soh 1']);
    expect(r.errors).toEqual(['soh 1: soh: not supported by this firmware']);
    expect(r.statUnsupported).toBe(false);
    expect(r.batteries[0]!.cells[0]!.soh).toBeUndefined();
  });

  it('does not flag sohUnsupported when soh works', async () => {
    const { fn } = commandFn();
    const r = await pollStack(fn, { ...base(), readSoh: true });
    expect(r.sohUnsupported).toBe(false);
  });
});

describe('pollStack stat handling', () => {
  it('skips stat when readStat is false', async () => {
    const { fn, log } = commandFn();
    const r = await pollStack(fn, { ...base(), readStat: false });
    expect(log.some((c) => c.startsWith('stat'))).toBe(false);
    expect(r.batteries[0]!.stat).toBeUndefined();
  });

  it('flags statUnsupported and stops asking when the firmware lacks stat', async () => {
    const unknown = "stat 1\r\n@\r\nUnknown command 'stat' - try 'help'\r\n$$\r\n";
    const { fn, log } = commandFn({ 'stat 1': unknown, 'stat 2': unknown });
    const r = await pollStack(fn, base());
    expect(r.statUnsupported).toBe(true);
    expect(log.filter((c) => c.startsWith('stat'))).toEqual(['stat 1']);
    expect(r.errors).toEqual(['stat 1: stat: not supported by this firmware']);
  });

  it('records a not-present answer as an error without disabling stat', async () => {
    const { fn, log } = commandFn({ 'stat 2': fixture('stat-absent.txt') });
    const r = await pollStack(fn, base());
    expect(r.statUnsupported).toBe(false);
    expect(log.filter((c) => c.startsWith('stat'))).toEqual(['stat 1', 'stat 2']);
    expect(r.errors).toEqual(['stat 2: target device is not present']);
    expect(r.batteries[1]!.stat).toBeUndefined();
  });

  it('serves stat from the cache with info', async () => {
    const cache = new Map<number, InfoCacheEntry>();
    const first = commandFn();
    await pollStack(first.fn, { ...base(), infoCache: cache });
    const second = commandFn();
    const r = await pollStack(second.fn, { ...base(), infoCache: cache });
    expect(second.log).toEqual(['pwr', 'bat 1', 'bat 2']);
    expect(r.batteries[0]!.stat?.soh).toBe(94);
  });
});
