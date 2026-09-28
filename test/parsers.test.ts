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
    expect(s0.mean).toBeCloseTo(3.3063, 3);
    expect(s0.tempMin).toBe(22);
    expect(s0.tempMax).toBe(22);
    expect(s0.tempMean).toBe(22);
    expect(s0.tempSpread).toBe(0);
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

describe('US3000D master pwr with Tlow.Id / Thigh.Id / Vlow.Id / Vhigh.Id columns', () => {
  it('parses six batteries and the extreme-cell index columns', () => {
    const rows = parsePwr(fixture('pwr-us3000d.txt'));
    expect(rows).toHaveLength(6);
    const r = rows[0]!;
    expect(r.position).toBe(1);
    expect(r.voltage).toBeCloseTo(52.382);
    expect(r.current).toBeCloseTo(-0.391);
    expect(r.temperature).toBeCloseTo(28.8);
    expect(r.tempLow).toBeCloseTo(25.4);
    expect(r.tempLowCell).toBe(5);
    expect(r.tempHigh).toBe(26);
    expect(r.tempHighCell).toBe(0);
    expect(r.voltLow).toBeCloseTo(3.481);
    expect(r.voltLowCell).toBe(2);
    expect(r.voltHigh).toBeCloseTo(3.497);
    expect(r.voltHighCell).toBe(10);
    expect(r.states.base).toBe('Dischg');
    expect(r.soc).toBe(99);
    expect(r.time).toBe('2026-09-28 12:16:26');
    expect(r.mosTemperature).toBeCloseTo(31.8);
    expect(r.states.mt).toBe('Normal');
    expect(r.extra).toEqual({});
    const last = rows[5]!;
    expect(last.position).toBe(6);
    expect(last.tempLowCell).toBe(10);
    expect(last.tempHighCell).toBe(13);
    expect(last.voltLowCell).toBe(10);
    expect(last.voltHighCell).toBe(13);
    expect(last.soc).toBe(100);
  });

  it('leaves the index columns undefined on firmware without them', () => {
    const r = parsePwr(fixture('pwr-us3000c-b69.txt'))[0]!;
    expect(r.tempLowCell).toBeUndefined();
    expect(r.voltHighCell).toBeUndefined();
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
    expect(s.mean).toBeCloseTo(3.385, 3);
    expect(s.tempMin).toBe(25);
    expect(s.tempMax).toBeCloseTo(25.9);
    expect(s.tempSpread).toBeCloseTo(0.9);
    expect(s.tempMean).toBeCloseTo(25.367, 3);
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

describe('US3000D master (firmware 1.1) captures', () => {
  it('parses the bare stat: SOH, cycles and counters, no power-on hours or volt diffs', () => {
    const st = parseStat(fixture('stat-us3000d.txt'));
    expect(st).toMatchObject({
      soh: 100,
      cycles: 4547,
      shutdowns: 8,
      resets: 0,
      batteryHighVoltageEvents: 0,
      batteryLowVoltageEvents: 0,
      batteryOverVoltageEvents: 0,
      batteryUnderVoltageEvents: 0,
    });
    expect(st.powerOnHours).toBeUndefined();
    expect(st.maxChargeVoltDiff).toBeUndefined();
    expect(st.lifeWarnings).toBeUndefined();
    expect(st.raw['Device address']).toBe('1');
    expect(st.raw['Power on Times']).toBe('14');
    expect(st.raw['Dsg Cap']).toBe('305882');
    // "Command completed successfully!" (with the bang) must not leak into the map
    expect(Object.keys(st.raw).some((k) => /Command completed/.test(k))).toBe(false);
  });

  it('does not mistake stat detail (no SOH, no cycles) for statistics', () => {
    expect(() => parseStat(fixture('stat-detail-us3000d.txt'))).toThrow(/No statistics/);
  });

  it('parses the bare info, taking the board from "Board" when "Board version" is empty', () => {
    const info = parseInfo(fixture('info-us3000d.txt'));
    expect(info).toMatchObject({
      deviceAddress: 1,
      deviceName: 'US3000D',
      barcode: 'Y251121C8P160585',
      specification: '48V/74AH',
      cellNumber: 15,
      firmware: {
        board: 'NF4.E3',
        main: 'B1.4.0.0',
        soft: 'V1.1',
        boot: 'V0.02',
        comm: 'V2.0',
        releaseDate: '25-11-13',
      },
    });
    expect(info.pcbaBarcode).toBeUndefined();
  });

  it('rejects "Invalid command or fail to excute" answers instead of parsing an empty info', () => {
    const info1 = fixture('info-1-rejected-us3000d.txt');
    const stat1 = fixture('stat-1-rejected-us3000d.txt');
    expect(isUnknownCommand(info1)).toBe(true);
    expect(isUnknownCommand(stat1)).toBe(true);
    expect(() => parseInfo(info1)).toThrow(/not supported/);
    expect(() => parseStat(stat1)).toThrow(/No statistics/);
    expect(isUnknownCommand(fixture('info-us3000d.txt'))).toBe(false);
    expect(isUnknownCommand(fixture('help-us3000d.txt'))).toBe(false);
  });
});

describe('bat with separate DTemp/CTemp state columns and wide "mAH" gap', () => {
  it('keeps every column aligned', () => {
    const cells = parseBat(fixture('bat-dtemp-ctemp-1.txt'));
    expect(cells).toHaveLength(15);
    expect(cells[0]).toMatchObject({
      index: 0,
      voltage: 3.455,
      current: -0.108,
      temperature: 24.6,
      soc: 99,
      coulombAh: 73.1,
      balancing: false,
      states: {
        base: 'Idle',
        volt: 'Normal',
        curr: 'Normal',
        temp: 'Normal',
        dtemp: 'Normal',
        ctemp: 'Normal',
      },
    });
    expect(cells[5]).toMatchObject({
      current: -0.16,
      temperature: 24.5,
      states: { base: 'Dischg' },
    });
    expect(cells.every((c) => Object.keys(c.extra).length === 0)).toBe(true);
  });

  it('parses a zero coulomb counter as 0 Ah, not undefined', () => {
    const cells = parseBat(fixture('bat-dtemp-ctemp-2.txt'));
    expect(cells[0]).toMatchObject({ soc: 99, coulombAh: 0, balancing: false, voltage: 3.458 });
    expect(cells[12]!.voltage).toBeCloseTo(3.445);
  });

  it('folds D/C temperature states into temp, reporting the non-Normal one', () => {
    const raw = fixture('bat-dtemp-ctemp-1.txt').replace(
      /^(0\s+3455.*?Normal\s+Normal\s+)Normal(\s+Normal\s+99%)/m,
      '$1High$2',
    );
    const cells = parseBat(raw);
    expect(cells[0]!.states).toMatchObject({ dtemp: 'High', ctemp: 'Normal', temp: 'High' });
    expect(cells[1]!.states.temp).toBe('Normal');
  });
});
