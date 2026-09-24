/** Convert a StackReading into InfluxDB points for node-red-contrib-influxdb batch nodes. */
import type { Battery, InfluxPoint, PointOptions, StackReading } from './model.js';

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

function batteryTags(chain: number, b: Battery): Record<string, string> {
  const tags: Record<string, string> = { chain: String(chain), battery: String(b.position) };
  if (b.info?.barcode) tags['barcode'] = b.info.barcode;
  return tags;
}

export function cellPoints(reading: StackReading, opts: PointOptions): InfluxPoint[] {
  const measurement = `${opts.measurementPrefix}/cell`;
  const points: InfluxPoint[] = [];
  for (const b of reading.batteries) {
    const base = batteryTags(reading.chain, b);
    for (const c of b.cells) {
      const fields = defined({
        voltage: r3(c.voltage),
        current: r3(c.current),
        temperature: r3(c.temperature),
        soc: c.soc,
        coulomb: c.coulombAh === undefined ? undefined : r3(c.coulombAh),
        balancing: c.balancing,
        soh: c.soh,
        ...(opts.includeStates
          ? {
              base_state: c.states.base,
              volt_state: c.states.volt,
              curr_state: c.states.curr,
              temp_state: c.states.temp,
            }
          : {}),
      });
      points.push({
        measurement,
        tags: { ...base, cell: String(c.index + opts.cellIndexBase) },
        fields,
        timestamp: reading.polledAt,
      });
    }
  }
  return points;
}

export function batteryPoints(reading: StackReading, opts: PointOptions): InfluxPoint[] {
  const measurement = `${opts.measurementPrefix}/battery`;
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
      soc: p.soc,
      mos_temperature: p.mosTemperature === undefined ? undefined : r3(p.mosTemperature),
      cell_min_voltage: s?.min,
      cell_max_voltage: s?.max,
      cell_spread: s?.spread,
      cell_min_index: s?.minCell,
      cell_max_index: s?.maxCell,
      cell_count: s?.count,
      coulomb:
        b.cells.length > 0 && b.cells.every((c) => c.coulombAh !== undefined)
          ? r3(Math.min(...b.cells.map((c) => c.coulombAh!)))
          : undefined,
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
    cell_spread: cells.length
      ? r3(Math.max(...cells.map((c) => c.voltage)) - Math.min(...cells.map((c) => c.voltage)))
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
