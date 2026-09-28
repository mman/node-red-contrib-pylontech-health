/** Convert a StackReading into InfluxDB points for node-red-contrib-influxdb batch nodes. */
import type { Battery, Cell, InfluxPoint, PointOptions, StackReading } from './model.js';

const r3 = (n: number): number => Number(n.toFixed(3));

function defined<T extends Record<string, unknown>>(
  obj: T,
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    if (typeof v === 'string' && v === '') continue;
    out[k] = v as number | string | boolean;
  }
  return out;
}

function firmwareString(b: Battery): string | undefined {
  const fw = b.info?.firmware;
  if (!fw) return undefined;
  return [fw.main, fw.soft].filter(Boolean).join('/') || undefined;
}

/** Shift a battery-reported (0-based) cell index to the configured numbering. */
const cellIndex = (i: number | undefined, base: 0 | 1): number | undefined =>
  i === undefined ? undefined : i + base;

/**
 * Coulomb counter of a cell, or undefined when the firmware did not really report it.
 * A US3000D master prints `0 mAH` for every cell of its slave batteries while their SOC
 * is 99 %; a zero counter next to a non-zero SOC is impossible, so treat it as missing.
 */
const reportedCoulomb = (c: Cell): number | undefined =>
  c.coulombAh === undefined || (c.coulombAh === 0 && (c.soc ?? 0) > 0) ? undefined : c.coulombAh;

/** Battery coulomb = min over cells, only when every cell reported one. */
function batteryCoulomb(cells: Cell[]): number | undefined {
  if (cells.length === 0) return undefined;
  const values = cells.map(reportedCoulomb);
  if (values.some((v) => v === undefined)) return undefined;
  return r3(Math.min(...(values as number[])));
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Zero-padded identifiers that sort correctly as strings: B01, C07. Combine them in aliases. */
export const batteryId = (position: number): string => `B${pad2(position)}`;
export const cellId = (cell: number): string => `C${pad2(cell)}`;

function batteryTags(chain: number, b: Battery): Record<string, string> {
  const tags: Record<string, string> = {
    chain: String(chain),
    battery: String(b.position),
    battery_id: batteryId(b.position),
  };
  if (b.info?.barcode) tags['barcode'] = b.info.barcode;
  return tags;
}

export function cellPoints(reading: StackReading, opts: PointOptions): InfluxPoint[] {
  const measurement = `${opts.measurementPrefix}/cell`;
  const points: InfluxPoint[] = [];
  for (const b of reading.batteries) {
    const base = batteryTags(reading.chain, b);
    const s = b.cellStats;
    for (const c of b.cells) {
      const fields = defined({
        voltage: r3(c.voltage),
        current: r3(c.current),
        temperature: r3(c.temperature),
        voltage_delta: s ? r3(c.voltage - s.mean) : undefined,
        temperature_delta: s ? r3(c.temperature - s.tempMean) : undefined,
        soc: c.soc,
        coulomb: reportedCoulomb(c) === undefined ? undefined : r3(reportedCoulomb(c)!),
        balancing: c.balancing,
        soh: c.soh,
        ...(opts.includeStates
          ? {
              base_state: c.states.base,
              volt_state: c.states.volt,
              curr_state: c.states.curr,
              temp_state: c.states.temp,
              dtemp_state: c.states.dtemp,
              ctemp_state: c.states.ctemp,
            }
          : {}),
      });
      points.push({
        measurement,
        tags: {
          ...base,
          cell: String(c.index + opts.cellIndexBase),
          cell_id: cellId(c.index + opts.cellIndexBase),
        },
        fields,
        timestamp: reading.polledAt,
      });
    }
  }
  return points;
}

export function batteryPoints(reading: StackReading, opts: PointOptions): InfluxPoint[] {
  const measurement = `${opts.measurementPrefix}/battery`;
  const stackTempMean = reading.batteries.length
    ? reading.batteries.reduce((a, b) => a + b.power.temperature, 0) / reading.batteries.length
    : undefined;
  return reading.batteries.map((b) => {
    const p = b.power;
    const s = b.cellStats;
    const fields = defined({
      voltage: r3(p.voltage),
      current: r3(p.current),
      temperature: r3(p.temperature),
      temp_low: p.tempLow === undefined ? undefined : r3(p.tempLow),
      temp_high: p.tempHigh === undefined ? undefined : r3(p.tempHigh),
      volt_low: p.voltLow === undefined ? undefined : r3(p.voltLow),
      volt_high: p.voltHigh === undefined ? undefined : r3(p.voltHigh),
      temp_low_index: cellIndex(p.tempLowCell, opts.cellIndexBase),
      temp_high_index: cellIndex(p.tempHighCell, opts.cellIndexBase),
      volt_low_index: cellIndex(p.voltLowCell, opts.cellIndexBase),
      volt_high_index: cellIndex(p.voltHighCell, opts.cellIndexBase),
      soc: p.soc,
      mos_temperature: p.mosTemperature === undefined ? undefined : r3(p.mosTemperature),
      temperature_delta:
        stackTempMean === undefined ? undefined : r3(p.temperature - stackTempMean),
      cell_min_voltage: s?.min,
      cell_max_voltage: s?.max,
      cell_voltage_spread: s?.spread,
      cell_min_index: s?.minCell,
      cell_max_index: s?.maxCell,
      cell_count: s?.count,
      cell_min_temperature: s?.tempMin,
      cell_max_temperature: s?.tempMax,
      cell_temperature_spread: s?.tempSpread,
      coulomb: batteryCoulomb(b.cells),
      firmware: firmwareString(b),
      soh: b.stat?.soh,
      cycle_count: b.stat?.cycles,
      power_on_hours: b.stat?.powerOnHours,
      shutdown_count: b.stat?.shutdowns,
      reset_count: b.stat?.resets,
      max_charge_volt_diff: b.stat?.maxChargeVoltDiff,
      max_discharge_volt_diff: b.stat?.maxDischargeVoltDiff,
      bat_hv_count: b.stat?.batteryHighVoltageEvents,
      bat_lv_count: b.stat?.batteryLowVoltageEvents,
      bat_ov_count: b.stat?.batteryOverVoltageEvents,
      bat_uv_count: b.stat?.batteryUnderVoltageEvents,
      life_warn_count: b.stat?.lifeWarnings,
      life_alarm_count: b.stat?.lifeAlarms,
      ...(opts.includeStates
        ? {
            base_state: p.states.base,
            volt_state: p.states.volt,
            curr_state: p.states.curr,
            temp_state: p.states.temp,
            dtemp_state: p.states.dtemp,
            ctemp_state: p.states.ctemp,
            bv_state: p.states.bv,
            bt_state: p.states.bt,
            mt_state: p.states.mt,
          }
        : {}),
    });
    return {
      measurement,
      tags: batteryTags(reading.chain, b),
      fields,
      timestamp: reading.polledAt,
    };
  });
}

export function stackPoint(reading: StackReading, opts: PointOptions): InfluxPoint {
  const bs = reading.batteries;
  const cells = bs.flatMap((b) => b.cells);
  const socs = bs.map((b) => b.power.soc).filter((v): v is number => v !== undefined);
  const temps = bs.map((b) => b.power.temperature);
  const fields = defined({
    battery_count: bs.length,
    cell_count: cells.length,
    voltage: bs.length ? r3(bs.reduce((a, b) => a + b.power.voltage, 0) / bs.length) : undefined,
    current: bs.length ? r3(bs.reduce((a, b) => a + b.power.current, 0)) : undefined,
    soc: socs.length ? Math.min(...socs) : undefined,
    cell_min_voltage: cells.length ? Math.min(...cells.map((c) => c.voltage)) : undefined,
    cell_max_voltage: cells.length ? Math.max(...cells.map((c) => c.voltage)) : undefined,
    cell_voltage_spread: cells.length
      ? r3(Math.max(...cells.map((c) => c.voltage)) - Math.min(...cells.map((c) => c.voltage)))
      : undefined,
    cell_temperature_spread: cells.length
      ? r3(
          Math.max(...cells.map((c) => c.temperature)) -
            Math.min(...cells.map((c) => c.temperature)),
        )
      : undefined,
    temp_min: temps.length ? Math.min(...temps) : undefined,
    temp_max: temps.length ? Math.max(...temps) : undefined,
    poll_duration_ms: reading.durationMs,
    error_count: reading.errors.length,
  });
  return {
    measurement: `${opts.measurementPrefix}/stack`,
    tags: { chain: String(reading.chain) },
    fields,
    timestamp: reading.polledAt,
  };
}

/** All points for one poll: stack, batteries, cells. */
export function toPoints(reading: StackReading, opts: PointOptions): InfluxPoint[] {
  return [stackPoint(reading, opts), ...batteryPoints(reading, opts), ...cellPoints(reading, opts)];
}
