/**
 * Pure decoders for the Pylontech low-voltage CAN bus protocol.
 *
 * Reference: "PYLON low voltage CAN Bus Protocol V2.0", rev 2.0.1 of 2021-04-02.
 * See docs/can-bus.md for the frame tables, where the numbers below come from and
 * which ones are inferred rather than documented.
 *
 * Values come out in the same SI units the console parsers use (V, A, °C, Ah).
 */
import type { CanModuleRef } from '../model.js';

/** One CAN frame, as read off the bus. */
export interface CanFrame {
  /** 11-bit identifier, or 29-bit when {@link CanFrame.ext} is set. */
  id: number;
  /** True for extended (29-bit) identifiers. */
  ext: boolean;
  /** Payload bytes, 0..8 of them. */
  data: number[];
}

/** Which side of the bus a frame comes from. */
export type FrameOrigin = 'battery' | 'inverter' | 'unknown';

export interface DecodedFrame {
  id: number;
  ext: boolean;
  /** Frame name from the spec, or `unknown` when we have no definition for the id. */
  name: string;
  origin: FrameOrigin;
  /** Decoded fields; empty when the frame is known but carries nothing we read. */
  fields: Record<string, number | string | boolean>;
  /** Set for the extended per-module responses. */
  address?: CanModuleRef;
  /** Raw payload as uppercase hex, always present so undecoded frames stay inspectable. */
  hex: string;
}

/** Extended request that asks every module for its analog values (`0x4000001`..`0x4000004`). */
export const REQUEST_MODULE_DATA = 0x4000000;
/** Extended request that asks every module for serial number and firmware version. */
export const REQUEST_MODULE_IDENTITY = 0x5000000;
/** The spec requires at least this long between two extended requests. */
export const REQUEST_MIN_INTERVAL_MS = 2000;

const MODULE_DATA_BASE = 0x04000000;
const MODULE_IDENTITY_BASE = 0x05000000;

const u16 = (d: number[], i: number): number | undefined => {
  const lo = d[i];
  const hi = d[i + 1];
  if (lo === undefined || hi === undefined) return undefined;
  return (hi << 8) | lo;
};
const s16 = (d: number[], i: number): number | undefined => {
  const v = u16(d, i);
  if (v === undefined) return undefined;
  return v >= 0x8000 ? v - 0x10000 : v;
};
const u32 = (d: number[], i: number): number | undefined => {
  const lo = u16(d, i);
  const hi = u16(d, i + 2);
  if (lo === undefined || hi === undefined) return undefined;
  return hi * 0x10000 + lo;
};
/** Round the way the console parsers do, so CAN and console values compare cleanly. */
const r3 = (n: number): number => Number(n.toFixed(3));
const scale = (v: number | undefined, factor: number): number | undefined =>
  v === undefined ? undefined : r3(v * factor);

/**
 * A field the spec defines but this firmware does not implement reads as all-ones
 * ("For defined byte, 0xFF, not support"). Treat that as absent rather than as 65535.
 */
const UNSUPPORTED_16 = 0xffff;
const defined16 = (v: number | undefined): number | undefined =>
  v === undefined || v === UNSUPPORTED_16 ? undefined : v;

/** Spec: cell temperatures in 0x373 are whole Kelvin, `Kel = °C + 273`. */
const kelvinToCelsius = (v: number | undefined): number | undefined =>
  v === undefined ? undefined : v - 273;

/** Printable-ASCII prefix of a payload, used for the brand / model / address strings. */
const ascii = (d: number[], from = 0, to = d.length): string => {
  let s = '';
  for (const b of d.slice(from, to)) {
    if (b === 0x00) break;
    if (b < 0x20 || b > 0x7e) break;
    s += String.fromCharCode(b);
  }
  return s;
};

const hex = (d: number[]): string =>
  d.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const put = (
  fields: Record<string, number | string | boolean>,
  key: string,
  value: number | string | boolean | undefined,
): void => {
  if (value !== undefined) fields[key] = value;
};

/**
 * `0x35A` encodes each alarm in the bit pair (bit N, bit N+1): `1,0` is active,
 * `0,1` is inactive, and `0,0` / `1,1` are reserved. Read as a little-endian
 * 2-bit value that makes active 1 and inactive 2. Returns undefined for the
 * reserved encodings so an alarm this firmware does not implement is not
 * reported as OK.
 */
export function alarmPair(byte: number, bit: number): boolean | undefined {
  const pair = (byte >> bit) & 0b11;
  if (pair === 0b01) return true;
  if (pair === 0b10) return false;
  return undefined;
}

const ALARM_BITS: Array<[byte: number, bit: number, name: string]> = [
  [0, 2, 'battery_high_voltage'],
  [0, 4, 'battery_low_voltage'],
  [0, 6, 'battery_high_temperature'],
  [1, 0, 'battery_low_temperature'],
  [1, 2, 'battery_high_charge_temperature'],
  [1, 4, 'battery_low_charge_temperature'],
  [1, 6, 'battery_high_current'],
  [2, 0, 'battery_high_charge_current'],
  [2, 2, 'contactor_error'],
  [2, 4, 'short_circuit'],
  [2, 6, 'bms_error'],
  [3, 0, 'cell_imbalance'],
];

/** `0x4000004` byte 0..1, "Status of this module". */
export const MODULE_STATUS_BITS: Record<number, string> = {
  0: 'cell_or_module_low_voltage',
  1: 'cell_or_module_high_voltage',
  2: 'cell_low_temperature',
  3: 'cell_high_temperature',
  4: 'charge_high_current',
  5: 'discharge_high_current',
  6: 'reserved_6',
  7: 'refer_to_error_code',
  8: 'cell_or_module_over_voltage',
  9: 'cell_or_module_under_voltage',
  10: 'cell_over_temperature',
  11: 'cell_under_temperature',
  12: 'charge_over_current',
  13: 'discharge_over_current_or_short_circuit',
  14: 'lock_charge_and_discharge_forbidden',
  15: 'reserved_15',
};

/** `0x4000004` byte 2..3, "Flag of this module". */
export const MODULE_FLAG_BITS: Record<number, string> = {
  0: 'force_charge',
  1: 'full_charge',
  2: 'balance_charge',
  3: 'cell_voltage_difference',
  13: 'discharge_mos_on',
  14: 'charge_mos_on',
  15: 'communication_offline',
};

function bitFields(
  fields: Record<string, number | string | boolean>,
  prefix: string,
  value: number,
  names: Record<number, string>,
): void {
  for (const [bit, name] of Object.entries(names)) {
    if (name.startsWith('reserved_')) continue;
    fields[`${prefix}${name}`] = ((value >> Number(bit)) & 1) === 1;
  }
}

/** Module/group address encoded into an extended response id. */
export function extendedAddress(id: number): CanModuleRef {
  return { group: (id >>> 16) & 0xff, module: (id >>> 8) & 0xff };
}

/** `0x374`..`0x377` carry the address as four ASCII digits, e.g. `"0103"` = group 1, module 3. */
export function parseAsciiAddress(s: string): CanModuleRef | undefined {
  const m = /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return undefined;
  return { group: Number.parseInt(m[1]!, 10), module: Number.parseInt(m[2]!, 10) };
}

function decodeStandard(id: number, d: number[]): Omit<DecodedFrame, 'id' | 'ext' | 'hex'> {
  const fields: Record<string, number | string | boolean> = {};
  switch (id) {
    case 0x305:
      return { name: 'inverter_heartbeat', origin: 'inverter', fields };
    case 0x307:
      put(fields, 'inverter_brand', ascii(d, 4, 8));
      return { name: 'inverter_identification', origin: 'inverter', fields };
    case 0x351:
      put(fields, 'charge_voltage_limit', scale(u16(d, 0), 0.1));
      put(fields, 'charge_current_limit', scale(s16(d, 2), 0.1));
      put(fields, 'discharge_current_limit', scale(s16(d, 4), 0.1));
      put(fields, 'discharge_voltage_limit', scale(u16(d, 6), 0.1));
      return { name: 'charge_discharge_limits', origin: 'battery', fields };
    case 0x355:
      put(fields, 'soc', defined16(u16(d, 0)));
      put(fields, 'soh', defined16(u16(d, 2)));
      return { name: 'soc_soh', origin: 'battery', fields };
    case 0x356:
      // Spec calls byte 0..1 the average module voltage; with modules in parallel
      // that is also the stack voltage.
      put(fields, 'voltage', scale(s16(d, 0), 0.01));
      put(fields, 'current', scale(s16(d, 2), 0.1));
      put(fields, 'temperature', scale(s16(d, 4), 0.1));
      return { name: 'measurements', origin: 'battery', fields };
    case 0x359: {
      const b0 = d[0] ?? 0;
      const b1 = d[1] ?? 0;
      const b2 = d[2] ?? 0;
      const b3 = d[3] ?? 0;
      fields['protect_cell_or_module_over_voltage'] = ((b0 >> 1) & 1) === 1;
      fields['protect_cell_or_module_under_voltage'] = ((b0 >> 2) & 1) === 1;
      fields['protect_cell_over_temperature'] = ((b0 >> 3) & 1) === 1;
      fields['protect_cell_under_temperature'] = ((b0 >> 4) & 1) === 1;
      fields['protect_discharge_over_current'] = ((b0 >> 7) & 1) === 1;
      fields['protect_charge_over_current'] = (b1 & 1) === 1;
      fields['protect_system_error'] = ((b1 >> 3) & 1) === 1;
      fields['warn_cell_or_module_high_voltage'] = ((b2 >> 1) & 1) === 1;
      fields['warn_cell_or_module_low_voltage'] = ((b2 >> 2) & 1) === 1;
      fields['warn_cell_high_temperature'] = ((b2 >> 3) & 1) === 1;
      fields['warn_cell_low_temperature'] = ((b2 >> 4) & 1) === 1;
      fields['warn_discharge_high_current'] = ((b2 >> 7) & 1) === 1;
      fields['warn_charge_high_current'] = (b3 & 1) === 1;
      fields['warn_slave_communication_offline'] = ((b3 >> 3) & 1) === 1;
      put(fields, 'module_count', d[4]);
      return { name: 'protect_and_alarm', origin: 'battery', fields };
    }
    case 0x35a: {
      for (const [byte, bit, name] of ALARM_BITS) {
        const b = d[byte];
        if (b === undefined) continue;
        put(fields, `alarm_${name}`, alarmPair(b, bit));
      }
      return { name: 'alarm_details', origin: 'battery', fields };
    }
    case 0x35c: {
      const b0 = d[0] ?? 0;
      fields['charge_enable'] = ((b0 >> 7) & 1) === 1;
      fields['discharge_enable'] = ((b0 >> 6) & 1) === 1;
      fields['force_charge_request'] = ((b0 >> 4) & 1) === 1;
      fields['full_charge_request'] = ((b0 >> 3) & 1) === 1;
      return { name: 'charge_discharge_flags', origin: 'battery', fields };
    }
    case 0x35e:
      // Spec defines bytes 0..4 as the brand only. This firmware also fills bytes
      // 5..7; see docs/can-bus.md, the reading of those bytes is an inference.
      put(fields, 'manufacturer', ascii(d, 0, 5));
      put(fields, 'trailing_bytes', hex(d.slice(5)));
      return { name: 'manufacturer', origin: 'battery', fields };
    case 0x35f:
      // Not in the published V2.0 tables ("under develop"); the decode below is
      // cross-checked against the D-Bus values can-bus-bms publishes.
      put(fields, 'hardware_version', `${d[0] ?? 0}.${d[1] ?? 0}`);
      put(fields, 'firmware_version', `${d[2] ?? 0}.${d[3] ?? 0}`);
      put(fields, 'online_capacity', u16(d, 4));
      return { name: 'version_and_capacity', origin: 'battery', fields };
    case 0x372:
      put(fields, 'modules_online', u16(d, 0));
      put(fields, 'modules_blocking_charge', u16(d, 2));
      put(fields, 'modules_blocking_discharge', u16(d, 4));
      put(fields, 'modules_offline', u16(d, 6));
      return { name: 'module_counts', origin: 'battery', fields };
    case 0x373:
      put(fields, 'min_cell_voltage', scale(u16(d, 0), 0.001));
      put(fields, 'max_cell_voltage', scale(u16(d, 2), 0.001));
      put(fields, 'min_cell_temperature', kelvinToCelsius(u16(d, 4)));
      put(fields, 'max_cell_temperature', kelvinToCelsius(u16(d, 6)));
      return { name: 'cell_min_max', origin: 'battery', fields };
    case 0x374:
    case 0x375:
    case 0x376:
    case 0x377: {
      const names: Record<number, string> = {
        0x374: 'min_voltage_module',
        0x375: 'max_voltage_module',
        0x376: 'min_temperature_module',
        0x377: 'max_temperature_module',
      };
      const raw = ascii(d);
      const addr = parseAsciiAddress(raw);
      put(fields, 'address', raw);
      if (addr) {
        fields['group'] = addr.group;
        fields['module'] = addr.module;
      }
      return { name: names[id]!, origin: 'battery', fields };
    }
    case 0x379:
      put(fields, 'installed_capacity', u32(d, 0));
      return { name: 'total_capacity', origin: 'battery', fields };
    case 0x382:
      // Not in the published V2.0 tables; matches the D-Bus `Family` value.
      put(fields, 'model', ascii(d));
      return { name: 'battery_model', origin: 'battery', fields };
    default:
      return { name: 'unknown', origin: 'unknown', fields };
  }
}

function decodeExtended(id: number, d: number[]): Omit<DecodedFrame, 'id' | 'ext' | 'hex'> {
  const fields: Record<string, number | string | boolean> = {};
  const base = id & 0xff000000;
  const kind = id & 0xff;
  const address = extendedAddress(id);

  if (id === REQUEST_MODULE_DATA || id === REQUEST_MODULE_IDENTITY) {
    return {
      name: id === REQUEST_MODULE_DATA ? 'request_module_data' : 'request_module_identity',
      origin: 'inverter',
      fields,
    };
  }

  if (base === MODULE_DATA_BASE) {
    switch (kind) {
      case 1:
        put(fields, 'min_cell_voltage', scale(u16(d, 0), 0.001));
        put(fields, 'max_cell_voltage', scale(u16(d, 2), 0.001));
        put(fields, 'current', scale(s16(d, 4), 0.1));
        put(fields, 'voltage', scale(u16(d, 6), 0.01));
        return { name: 'module_voltages', origin: 'battery', fields, address };
      case 2:
        put(fields, 'max_cell_temperature', scale(s16(d, 0), 0.1));
        put(fields, 'min_cell_temperature', scale(s16(d, 2), 0.1));
        put(fields, 'mos_temperature', scale(s16(d, 4), 0.1));
        put(fields, 'bms_temperature', scale(s16(d, 6), 0.1));
        return { name: 'module_temperatures', origin: 'battery', fields, address };
      case 3:
        // Bytes 0..1 are undefined in the spec table; SOC starts at byte 2.
        put(fields, 'soc', defined16(u16(d, 2)));
        put(fields, 'soh', defined16(u16(d, 4)));
        put(fields, 'nominal_capacity', defined16(u16(d, 6)));
        return { name: 'module_soc_soh', origin: 'battery', fields, address };
      case 4: {
        const status = u16(d, 0);
        const flag = u16(d, 2);
        if (status !== undefined) {
          fields['status'] = status;
          bitFields(fields, 'status_', status, MODULE_STATUS_BITS);
        }
        if (flag !== undefined) {
          fields['flag'] = flag;
          bitFields(fields, 'flag_', flag, MODULE_FLAG_BITS);
        }
        put(fields, 'error_code', u32(d, 4));
        return { name: 'module_status', origin: 'battery', fields, address };
      }
      default:
        return { name: 'unknown', origin: 'unknown', fields, address };
    }
  }

  if (base === MODULE_IDENTITY_BASE) {
    if (kind >= 1 && kind <= 4) {
      put(fields, 'serial_part', ascii(d));
      fields['serial_index'] = kind;
      return { name: 'module_serial', origin: 'battery', fields, address };
    }
    if (kind === 5) {
      put(fields, 'firmware_version', `${d[0] ?? 0}.${d[1] ?? 0}`);
      put(fields, 'internal_version', `${d[4] ?? 0}.${d[5] ?? 0}`);
      return { name: 'module_firmware', origin: 'battery', fields, address };
    }
  }

  return { name: 'unknown', origin: 'unknown', fields };
}

/** Decode one frame. Unknown ids come back named `unknown` with their payload in {@link DecodedFrame.hex}. */
export function decodeFrame(frame: CanFrame): DecodedFrame {
  const { id, ext, data } = frame;
  const decoded = ext ? decodeExtended(id, data) : decodeStandard(id, data);
  return { id, ext, hex: hex(data), ...decoded };
}

/** Build the 8-zero-byte request payload the spec prescribes for both extended requests. */
export const requestPayload = (): number[] => [0, 0, 0, 0, 0, 0, 0, 0];

/** Format an id the way `cansend` wants it: 3 hex digits standard, 8 extended. */
export function formatCanId(id: number, ext: boolean): string {
  return id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0');
}
