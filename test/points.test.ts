import { describe, expect, it } from 'vitest';
import type { PointOptions, StackReading } from '../src/model.js';
import { assembleBattery, parseBat, parseInfo, parsePwr, parseStat } from '../src/parsers.js';
import { batteryPoints, cellPoints, stackPoint, toPoints } from '../src/points.js';
import { fixture } from './helpers.js';

function reading(indexBase: 0 | 1 = 1): StackReading {
  const pwr = parsePwr(fixture('pwr-us3000c.txt'));
  const info = parseInfo(fixture('info-us3000c.txt'));
  const cells = parseBat(fixture('bat-us3000c.txt'));
  const stat = parseStat(fixture('stat-us3000c-b69.txt'));
  return {
    chain: 1,
    polledAt: new Date('2026-09-23T12:00:00Z'),
    durationMs: 3210,
    batteries: pwr.map((p, i) =>
      assembleBattery(p, i === 0 ? info : undefined, cells, indexBase, i === 0 ? stat : undefined),
    ),
    errors: [],
  };
}

const opts: PointOptions = {
  measurementPrefix: 'pylontech',
  cellIndexBase: 1,
  includeStates: true,
};

describe('cellPoints', () => {
  it('emits one point per cell with slash measurement name, tags and SI fields', () => {
    const pts = cellPoints(reading(), opts);
    expect(pts).toHaveLength(30);
    const p = pts[0]!;
    expect(p.measurement).toBe('pylontech/cell');
    expect(p.tags).toEqual({
      chain: '1',
      battery: '1',
      battery_id: 'B01',
      barcode: 'PPTBH02212345678',
      cell: '1',
      cell_id: 'C01',
    });
    expect(pts[14]!.tags['cell_id']).toBe('C15');
    expect(pts[15]!.tags).toMatchObject({ battery_id: 'B02', cell_id: 'C01' });
    expect(p.fields).toMatchObject({
      voltage: 3.305,
      current: -1.876,
      temperature: 22,
      soc: 87,
      coulomb: 43.247,
      balancing: false,
      voltage_delta: -0.001,
      temperature_delta: 0,
      base_state: 'Dischg',
      volt_state: 'Normal',
      curr_state: 'Normal',
      temp_state: 'Normal',
    });
    expect(p.timestamp).toEqual(new Date('2026-09-23T12:00:00Z'));
  });

  it('omits barcode tag when info is unknown and states when disabled', () => {
    const pts = cellPoints(reading(), { ...opts, includeStates: false, cellIndexBase: 0 });
    const p = pts[15]!; // first cell of battery 2
    expect(p.tags).toEqual({
      chain: '1',
      battery: '2',
      battery_id: 'B02',
      cell: '0',
      cell_id: 'C00',
    });
    expect(p.fields).not.toHaveProperty('base_state');
  });

  it('includes soh when present', () => {
    const r = reading();
    r.batteries[0]!.cells[0]!.soh = 98;
    expect(cellPoints(r, opts)[0]!.fields['soh']).toBe(98);
  });
});

describe('batteryPoints', () => {
  it('emits module level fields and cell statistics', () => {
    const pts = batteryPoints(reading(), opts);
    expect(pts).toHaveLength(2);
    const p = pts[0]!;
    expect(p.measurement).toBe('pylontech/battery');
    expect(p.tags).toEqual({
      chain: '1',
      battery: '1',
      battery_id: 'B01',
      barcode: 'PPTBH02212345678',
    });
    expect(p.fields).toMatchObject({
      voltage: 49.64,
      current: -1.876,
      temperature: 25,
      temp_low: 22,
      temp_high: 23,
      volt_low: 3.308,
      volt_high: 3.31,
      soc: 87,
      mos_temperature: 23,
      cell_min_voltage: 3.305,
      cell_max_voltage: 3.308,
      cell_voltage_spread: 0.003,
      cell_min_temperature: 22,
      cell_max_temperature: 22,
      cell_temperature_spread: 0,
      temperature_delta: 0,
      cell_min_index: 1,
      cell_max_index: 4,
      cell_count: 15,
      coulomb: 43.247,
      firmware: 'B76.28/V2.3',
      soh: 94,
      cycle_count: 686,
      power_on_hours: 754.08,
      shutdown_count: 662,
      reset_count: 78,
      max_charge_volt_diff: 0.237,
      max_discharge_volt_diff: 0,
      bat_hv_count: 3,
      bat_lv_count: 1,
      life_warn_count: 0,
      life_alarm_count: 0,
      base_state: 'Dischg',
      bv_state: 'Normal',
      mt_state: 'Normal',
    });
    expect(pts[1]!.fields).not.toHaveProperty('firmware');
    expect(pts[1]!.fields).not.toHaveProperty('soh');
  });
});

describe('stackPoint', () => {
  it('aggregates across batteries', () => {
    const p = stackPoint(reading(), opts);
    expect(p.measurement).toBe('pylontech/stack');
    expect(p.tags).toEqual({ chain: '1' });
    expect(p.fields).toMatchObject({
      battery_count: 2,
      cell_count: 30,
      voltage: 49.635,
      current: -3.788,
      soc: 87,
      cell_min_voltage: 3.305,
      cell_max_voltage: 3.308,
      cell_voltage_spread: 0.003,
      cell_temperature_spread: 0,
      temp_min: 25,
      temp_max: 25,
      poll_duration_ms: 3210,
      error_count: 0,
    });
  });

  it('handles an empty reading', () => {
    const p = stackPoint(
      { chain: 2, polledAt: new Date(), durationMs: 1, batteries: [], errors: ['x'] },
      opts,
    );
    expect(p.fields).toEqual({
      battery_count: 0,
      cell_count: 0,
      poll_duration_ms: 1,
      error_count: 1,
    });
  });
});

describe('toPoints', () => {
  it('orders stack, battery, cell and honours the prefix', () => {
    const pts = toPoints(reading(), { ...opts, measurementPrefix: 'bms' });
    expect(pts).toHaveLength(1 + 2 + 30);
    expect(pts.map((p) => p.measurement).slice(0, 4)).toEqual([
      'bms/stack',
      'bms/battery',
      'bms/battery',
      'bms/cell',
    ]);
  });
});

describe('delta and spread fields', () => {
  it('computes cell deltas against the battery mean and temperature spread from the real capture', () => {
    const pwr = parsePwr(fixture('pwr-us3000c-b69.txt'));
    const cells = parseBat(fixture('bat-us3000c-b69.txt'));
    const r: StackReading = {
      chain: 1,
      polledAt: new Date(),
      durationMs: 1,
      batteries: [assembleBattery(pwr[0]!, undefined, cells, 1)],
      errors: [],
    };
    const cellPts = cellPoints(r, opts);
    // mean of the 15 cells is 3.385 V; cell 0 = 3.493, cell 9 = 3.340
    expect(cellPts[0]!.fields['voltage_delta']).toBeCloseTo(0.108, 3);
    expect(cellPts[9]!.fields['voltage_delta']).toBeCloseTo(-0.045, 3);
    // temperatures: 25.9 (x5), 25.2 (x5), 25.0 (x5) -> mean 25.367
    expect(cellPts[0]!.fields['temperature_delta']).toBeCloseTo(0.533, 3);
    expect(cellPts[14]!.fields['temperature_delta']).toBeCloseTo(-0.367, 3);
    const sum = cellPts.reduce((a, p) => a + (p.fields['voltage_delta'] as number), 0);
    expect(Math.abs(sum)).toBeLessThan(0.01); // deltas centre on zero

    const bat = batteryPoints(r, opts)[0]!;
    expect(bat.fields).toMatchObject({
      cell_voltage_spread: 0.155,
      cell_min_temperature: 25,
      cell_max_temperature: 25.9,
      cell_temperature_spread: 0.9,
      temperature_delta: 0, // single battery: equals the stack mean
    });
    expect(bat.fields).not.toHaveProperty('cell_spread');
    expect(stackPoint(r, opts).fields).toMatchObject({
      cell_voltage_spread: 0.155,
      cell_temperature_spread: 0.9,
    });
  });

  it('computes battery temperature_delta against the stack mean', () => {
    const r = reading();
    r.batteries[1]!.power.temperature = 27; // battery 1 is 25 -> mean 26
    const pts = batteryPoints(r, opts);
    expect(pts[0]!.fields['temperature_delta']).toBe(-1);
    expect(pts[1]!.fields['temperature_delta']).toBe(1);
  });
});
