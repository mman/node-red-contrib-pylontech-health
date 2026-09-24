/** Serialise InfluxPoints to InfluxDB line protocol (millisecond precision). */
import type { InfluxPoint } from './model.js';

const escKey = (s: string): string => s.replace(/[,= ]/g, (c) => `\\${c}`);
const escMeasurement = (s: string): string => s.replace(/[, ]/g, (c) => `\\${c}`);
const escString = (s: string): string => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;

function fieldValue(v: number | string | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? `${v}` : String(v);
  return escString(v);
}

export function toLineProtocol(point: InfluxPoint): string {
  const tags = Object.entries(point.tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `,${escKey(k)}=${escKey(v)}`)
    .join('');
  const fields = Object.entries(point.fields)
    .map(([k, v]) => `${escKey(k)}=${fieldValue(v)}`)
    .join(',');
  return `${escMeasurement(point.measurement)}${tags} ${fields} ${point.timestamp.getTime()}`;
}

export function toLineProtocolBatch(points: InfluxPoint[]): string {
  return points.map(toLineProtocol).join('\n');
}
