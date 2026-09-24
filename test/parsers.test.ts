import { describe, expect, it } from 'vitest';
import {
  assembleBattery,
  cellStats,
  isNotPresent,
  isUnknownCommand,
  parseBat,
  parseInfo,
  parsePwr,
  parseSoh,
  parseStat,
} from '../src/parsers.js';
import { fixture } from './helpers.js';

describe('parsePwr', () => {
  it('parses US3000C output with MosTempr columns and skips Absent rows', () => {
    const rows = parsePwr(fixture('pwr-us3000c.txt'));
    expect(rows.map((r) => r.position)).toEqual([1, 2]);
    const r = rows[0]!;
    expect(r.voltage).toBeCloseTo(49.64);
    expect(r.current).toBeCloseTo(-1.876);
    expect(r.temperature).toBe(25);
    expect(r.tempLow).toBe(22);
    expect(r.tempHigh).toBe(23);
    expect(r.voltLow).toBeCloseTo(3.308);
    expect(r.voltHigh).toBeCloseTo(3.31);
    expect(r.soc).toBe(87);
    expect(r.time).toBe('2023-01-15 12:03:22');
    expect(r.mosTemperature).toBe(23);
    expect(r.states).toEqual({
      base: 'Dischg',
      volt: 'Normal',
      curr: 'Normal',
      temp: 'Normal',
      bv: 'Normal',
      bt: 'Normal',
      mt: 'Normal',
    });
    expect(r.extra).toEqual({});
  });

  it('parses US2000 output without MosTempr columns', () => {
    const rows = parsePwr(fixture('pwr-us2000.txt'));
    expect(rows).toHaveLength(3);
    expect(rows[2]!.position).toBe(3);
    expect(rows[2]!.soc).toBe(95);
    expect(rows[0]!.mosTemperature).toBeUndefined();
    expect(rows[0]!.states.mt).toBeUndefined();
    expect(rows[0]!.states.base).toBe('Charge');
  });

  it('throws when no header is present', () => {
    expect(() => parsePwr(fixture('bat-absent.txt'))).toThrow(/No table header/);
  });
});

describe('parseBat', () => {
  it('parses 15 cells with BAL column and mAH coulomb', () => {
    const cells = parseBat(fixture('bat-us3000c.txt'));
    expect(cells).toHaveLength(15);
    expect(cells.map((c) => c.index)).toEqual([...Array(15).keys()]);
    const c = cells[0]!;
    expect(c.voltage).toBeCloseTo(3.305);
    expect(c.current).toBeCloseTo(-1.876);
    expect(c.temperature).toBe(22);
    expect(c.soc).toBe(87);
    expect(c.coulombAh).toBeCloseTo(43.247);
    expect(c.balancing).toBe(false);
    expect(cells[3]!.balancing).toBe(true);
    expect(c.states).toEqual({ base: 'Dischg', volt: 'Normal', curr: 'Normal', temp: 'Normal' });
  });

  it('handles firmware without BAL column', () => {
    const cells = parseBat(fixture('bat-us2000.txt'));
    expect(cells).toHaveLength(15);
    expect(cells[0]!.balancing).toBeUndefined();
    expect(cells[0]!.coulombAh).toBeCloseTo(47.5);
    expect(cells[1]!.voltage).toBeCloseTo(3.415);
  });

  it('throws on Command failed output (absent battery)', () => {
    expect(() => parseBat(fixture('bat-absent.txt'))).toThrow();
  });
});

describe('parseSoh', () => {
  it('maps cell index to SOH percent', () => {
    const soh = parseSoh(fixture('soh-us3000c.txt'));
    expect(soh.size).toBe(15);
    expect(soh.get(0)).toBe(100);
    expect(soh.get(7)).toBe(99);
  });
});

describe('parseInfo', () => {
  it('extracts identity and firmware fields', () => {
    const info = parseInfo(fixture('info-us3000c.txt'));
    expect(info.deviceAddress).toBe(1);
    expect(info.manufacturer).toBe('Pylon');
    expect(info.deviceName).toBe('US3000C');
    expect(info.barcode).toBe('PPTBH02212345678');
    expect(info.pcbaBarcode).toBe('PPTBH02298765432');
    expect(info.specification).toBe('48V/74AH');
    expect(info.cellNumber).toBe(15);
    expect(info.firmware).toEqual({
      board: 'PHANTOMSAV10R05',
      main: 'B76.28',
      soft: 'V2.3',
      boot: 'V2.4',
      comm: 'V2.0',
      releaseDate: '21-09-14',
    });
    expect(info.raw['Console Port rate']).toBe('115200');
  });

  it('throws on empty output', () => {
    expect(() => parseInfo('@\r\n$$\r\npylon>')).toThrow();
  });
});

describe('cellStats / assembleBattery', () => {
  it('computes min/max/spread with index base', () => {
    const cells = parseBat(fixture('bat-us3000c.txt'));
    const s0 = cellStats(cells, 0)!;
    const s1 = cellStats(cells, 1)!;
    expect(s0.min).toBeCloseTo(3.305);
    expect(s0.max).toBeCloseTo(3.308);
    expect(s0.spread).toBeCloseTo(0.003);
    expect(s0.minCell).toBe(0);
    expect(s1.minCell).toBe(1);
    expect(s0.maxCell).toBe(3);
    expect(s0.count).toBe(15);
    expect(cellStats([], 1)).toBeUndefined();
  });

  it('assembles a battery', () => {
    const pwr = parsePwr(fixture('pwr-us3000c.txt'))[0]!;
    const b = assembleBattery(
      pwr,
      parseInfo(fixture('info-us3000c.txt')),
      parseBat(fixture('bat-us3000c.txt')),
      1,
    );
    expect(b.position).toBe(1);
    expect(b.info?.barcode).toBe('PPTBH02212345678');
    expect(b.cells).toHaveLength(15);
    expect(b.cellStats?.count).toBe(15);
  });
});

describe('real US3000C firmware B69.25.0.0 captures', () => {
  it('parses pwr with a single battery and 15 Absent rows', () => {
    const rows = parsePwr(fixture('pwr-us3000c-b69.txt'));
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.position).toBe(1);
    expect(r.voltage).toBeCloseTo(50.777);
    expect(r.current).toBe(0);
    expect(r.temperature).toBe(41);
    expect(r.tempLow).toBe(25);
    expect(r.tempHigh).toBeCloseTo(25.9);
    expect(r.voltLow).toBeCloseTo(3.34);
    expect(r.voltHigh).toBeCloseTo(3.496);
    expect(r.soc).toBe(5);
    expect(r.time).toBe('2026-09-23 21:41:50');
    expect(r.mosTemperature).toBeCloseTo(28.2);
    expect(r.states.base).toBe('Idle');
    expect(r.states.mt).toBe('Normal');
  });
});

describe('real US3000C firmware B69.25.0.0 bat capture', () => {
  it('parses 15 cells with per-cell SOC, coulomb and balancing flags', () => {
    const cells = parseBat(fixture('bat-us3000c-b69.txt'));
    expect(cells).toHaveLength(15);
    expect(cells[0]).toMatchObject({
      index: 0,
      voltage: 3.493,
      current: 0,
      temperature: 25.9,
      soc: 100,
      coulombAh: 68.967,
      balancing: true,
      states: { base: 'Idle', volt: 'Normal', curr: 'Normal', temp: 'Normal' },
    });
    expect(cells[5]).toMatchObject({
      voltage: 3.341,
      temperature: 25.2,
      soc: 5,
      coulombAh: 3.708,
      balancing: false,
    });
    expect(cells[12]).toMatchObject({ soc: 92, coulombAh: 63.316, balancing: true });
    expect(cells.every((c) => Object.keys(c.extra).length === 0)).toBe(true);
    const s = cellStats(cells, 1)!;
    expect(s.min).toBeCloseTo(3.34);
    expect(s.max).toBeCloseTo(3.495);
    expect(s.spread).toBeCloseTo(0.155);
    expect(s.minCell).toBe(10);
    expect(s.maxCell).toBe(2);
  });
});

describe('parseStat (real US3000C B69.25.0.0 capture)', () => {
  it('extracts SOH, cycles and lifetime counters in SI units', () => {
    const st = parseStat(fixture('stat-us3000c-b69.txt'));
    expect(st).toMatchObject({
      soh: 94,
      cycles: 686,
      powerOnHours: 754.08,
      shutdowns: 662,
      resets: 78,
      maxChargeVoltDiff: 0.237,
      maxDischargeVoltDiff: 0,
      batteryHighVoltageEvents: 3,
      batteryLowVoltageEvents: 1,
      batteryOverVoltageEvents: 0,
      batteryUnderVoltageEvents: 0,
      lifeWarnings: 0,
      lifeAlarms: 0,
    });
    expect(st.raw['Device address']).toBe('1'); // line without a colon
    expect(st.raw['ChgCurr 0~0.2C Secs']).toBe('826944');
    expect(Object.keys(st.raw).length).toBeGreaterThan(100);
  });

  it('throws on a not-present answer, which isNotPresent recognises', () => {
    const raw = fixture('stat-absent.txt');
    expect(isNotPresent(raw)).toBe(true);
    expect(isUnknownCommand(raw)).toBe(false);
    expect(() => parseStat(raw)).toThrow(/No statistics/);
  });

  it('recognises unknown-command answers', () => {
    expect(isUnknownCommand(fixture('soh-unsupported.txt'))).toBe(true);
    expect(isUnknownCommand(fixture('bat-absent.txt'))).toBe(true);
    expect(isUnknownCommand(fixture('pwr-us3000c-b69.txt'))).toBe(false);
  });
});
