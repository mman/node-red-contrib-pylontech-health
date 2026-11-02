import { describe, expect, it } from 'vitest';
import {
  alarmPair,
  decodeFrame,
  extendedAddress,
  formatCanId,
  parseAsciiAddress,
  REQUEST_MODULE_DATA,
  REQUEST_MODULE_IDENTITY,
  requestPayload,
  type CanFrame,
} from '../src/can/frames.js';

const bytes = (hex: string): number[] =>
  hex
    .trim()
    .split(/\s+/)
    .map((b) => Number.parseInt(b, 16));

const std = (id: number, hex: string): CanFrame => ({ id, ext: false, data: bytes(hex) });
const ext = (id: number, hex: string): CanFrame => ({ id, ext: true, data: bytes(hex) });

describe('decodeFrame, standard frames', () => {
  // Payloads below are the real ones from test/fixtures/candump-us3000d-can1.txt,
  // a 6x US3000D stack on firmware 1.4. Expected values are cross-checked against
  // what can-bus-bms published on D-Bus at the same moment.
  it('decodes 0x351 charge and discharge limits', () => {
    expect(decodeFrame(std(0x351, '14 02 AC 08 AC 08 C2 01')).fields).toEqual({
      charge_voltage_limit: 53.2,
      charge_current_limit: 222,
      discharge_current_limit: 222,
      discharge_voltage_limit: 45,
    });
  });

  it('decodes 0x355 SOC and SOH', () => {
    expect(decodeFrame(std(0x355, '13 00 64 00')).fields).toEqual({ soc: 19, soh: 100 });
  });

  it('decodes 0x356 measurements', () => {
    expect(decodeFrame(std(0x356, '22 13 64 00 F9 00')).fields).toEqual({
      voltage: 48.98,
      current: 10,
      temperature: 24.9,
    });
  });

  it('reads a negative current as discharge', () => {
    // -10.0 A is 0xFF9C little-endian.
    expect(decodeFrame(std(0x356, '22 13 9C FF F9 00')).fields['current']).toBe(-10);
  });

  it('decodes 0x359 with no protections and the module count', () => {
    const d = decodeFrame(std(0x359, '00 00 00 00 06 50 4E'));
    expect(d.name).toBe('protect_and_alarm');
    expect(d.fields['module_count']).toBe(6);
    expect(Object.entries(d.fields).filter(([, v]) => v === true)).toEqual([]);
  });

  it('decodes set protection and warning bits in 0x359', () => {
    const d = decodeFrame(std(0x359, '02 00 04 00 06 50 4E'));
    expect(d.fields['protect_cell_or_module_over_voltage']).toBe(true);
    expect(d.fields['warn_cell_or_module_low_voltage']).toBe(true);
    expect(d.fields['protect_cell_over_temperature']).toBe(false);
  });

  it('reads 0x35A two-bit alarm encoding as inactive', () => {
    // 0xAA sets every odd bit, so each (bit N, bit N+1) pair is 0,1 = inactive.
    // can-bus-bms reported every Alarms/* as 0 for this same capture.
    const d = decodeFrame(std(0x35a, 'AA AA AA 02 00 00 00 00'));
    expect(d.fields['alarm_battery_high_voltage']).toBe(false);
    expect(d.fields['alarm_cell_imbalance']).toBe(false);
  });

  it('reads an active 0x35A alarm pair', () => {
    // bit 2 set, bit 3 clear -> battery high voltage active.
    expect(decodeFrame(std(0x35a, '04 00 00 00')).fields['alarm_battery_high_voltage']).toBe(true);
  });

  it('reports the reserved 0x35A encodings as unknown, not OK', () => {
    const d = decodeFrame(std(0x35a, '00 00 00 00'));
    expect(d.fields).not.toHaveProperty('alarm_battery_high_voltage');
  });

  it('decodes 0x35C charge and discharge enable', () => {
    expect(decodeFrame(std(0x35c, 'C0 00')).fields).toEqual({
      charge_enable: true,
      discharge_enable: true,
      force_charge_request: false,
      full_charge_request: false,
    });
  });

  it('decodes the 0x35E brand from bytes 0..4 only', () => {
    // Bytes 5..7 are outside the spec's definition; keep them raw rather than guessing.
    expect(decodeFrame(std(0x35e, '50 59 4C 4F 4E 01 04 20')).fields).toEqual({
      manufacturer: 'PYLON',
      trailing_bytes: '01 04 20',
    });
  });

  it('decodes 0x35F version and capacity', () => {
    expect(decodeFrame(std(0x35f, '00 00 01 04 BC 01 00 00')).fields).toEqual({
      hardware_version: '0.0',
      firmware_version: '1.4',
      online_capacity: 444,
    });
  });

  it('decodes 0x372 module counters', () => {
    expect(decodeFrame(std(0x372, '06 00 00 00 00 00 00 00')).fields).toEqual({
      modules_online: 6,
      modules_blocking_charge: 0,
      modules_blocking_discharge: 0,
      modules_offline: 0,
    });
  });

  it('decodes 0x373 cell extremes, converting Kelvin to Celsius', () => {
    expect(decodeFrame(std(0x373, 'A8 0C D1 0C 28 01 2B 01')).fields).toEqual({
      min_cell_voltage: 3.24,
      max_cell_voltage: 3.281,
      min_cell_temperature: 23,
      max_cell_temperature: 26,
    });
  });

  it('decodes the 0x374..0x377 ASCII module addresses', () => {
    expect(decodeFrame(std(0x374, '30 31 30 33 00 00 00 00'))).toMatchObject({
      name: 'min_voltage_module',
      fields: { address: '0103', group: 1, module: 3 },
    });
    expect(decodeFrame(std(0x376, '30 31 30 36 00 00 00 00')).fields['module']).toBe(6);
  });

  it('decodes 0x379 installed capacity as 32 bits', () => {
    expect(decodeFrame(std(0x379, 'BC 01 00 00')).fields).toEqual({ installed_capacity: 444 });
  });

  it('decodes the 0x382 model string', () => {
    expect(decodeFrame(std(0x382, '55 53 33 30 30 30 44 00')).fields).toEqual({
      model: 'US3000D',
    });
  });

  it('marks the inverter frames as coming from the inverter', () => {
    expect(decodeFrame(std(0x305, '00 00 00 00 00 00 00 00')).origin).toBe('inverter');
    expect(decodeFrame(std(0x307, '12 34 56 78 56 49 43 00'))).toMatchObject({
      origin: 'inverter',
      fields: { inverter_brand: 'VIC' },
    });
  });

  it('keeps an unknown id inspectable instead of dropping it', () => {
    const d = decodeFrame(std(0x385, '01 00 00 00 00 00 00 00'));
    expect(d.name).toBe('unknown');
    expect(d.hex).toBe('01 00 00 00 00 00 00 00');
  });

  it('tolerates a short payload', () => {
    expect(decodeFrame(std(0x373, 'A8 0C')).fields).toEqual({ min_cell_voltage: 3.24 });
  });
});

describe('decodeFrame, extended per-module frames', () => {
  // 0x4000001 + N * 0x100 + M * 0x10000 with group 1, module 3 is 0x04010301.
  it('derives the group and module from the response id', () => {
    expect(extendedAddress(0x04010301)).toEqual({ group: 1, module: 3 });
    expect(extendedAddress(0x04020b02)).toEqual({ group: 2, module: 11 });
  });

  it('decodes module voltages and current', () => {
    expect(decodeFrame(ext(0x04010301, 'A8 0C D1 0C 64 00 22 13'))).toMatchObject({
      name: 'module_voltages',
      address: { group: 1, module: 3 },
      fields: {
        min_cell_voltage: 3.24,
        max_cell_voltage: 3.281,
        current: 10,
        voltage: 48.98,
      },
    });
  });

  it('decodes module temperatures, including a negative one', () => {
    expect(decodeFrame(ext(0x04010102, '2B 01 FE FF 0E 01 60 01')).fields).toEqual({
      max_cell_temperature: 29.9,
      min_cell_temperature: -0.2,
      mos_temperature: 27,
      bms_temperature: 35.2,
    });
  });

  it('decodes module SOC and SOH, with bytes 0..1 reserved', () => {
    // Spec table leaves bytes 0..1 undefined; SOC starts at byte 2.
    expect(decodeFrame(ext(0x04010103, '00 00 13 00 64 00 4A 00')).fields).toEqual({
      soc: 19,
      soh: 100,
      nominal_capacity: 74,
    });
  });

  it('treats an all-ones field as unsupported rather than 65535', () => {
    const f = decodeFrame(ext(0x04010103, '00 00 13 00 FF FF 4A 00')).fields;
    expect(f['soc']).toBe(19);
    expect(f).not.toHaveProperty('soh');
  });

  it('decodes module status and flag bitfields', () => {
    // status bit 1 = cell or module high voltage; flags 0x6000 = both MOSFETs on.
    const f = decodeFrame(ext(0x04010104, '02 00 00 60 00 00 00 00')).fields;
    expect(f['status']).toBe(2);
    expect(f['status_cell_or_module_high_voltage']).toBe(true);
    expect(f['status_cell_or_module_low_voltage']).toBe(false);
    expect(f['flag_charge_mos_on']).toBe(true);
    expect(f['flag_discharge_mos_on']).toBe(true);
    expect(f['flag_communication_offline']).toBe(false);
    expect(f['error_code']).toBe(0);
  });

  it('decodes a serial number chunk and the firmware version', () => {
    expect(decodeFrame(ext(0x05010101, '32 30 32 31 30 39 32 33'))).toMatchObject({
      name: 'module_serial',
      fields: { serial_part: '20210923', serial_index: 1 },
    });
    expect(decodeFrame(ext(0x05010105, '01 04 00 00 38 03 00 00')).fields).toEqual({
      firmware_version: '1.4',
      internal_version: '56.3',
    });
  });

  it('names the two requests and marks them as ours', () => {
    expect(decodeFrame(ext(REQUEST_MODULE_DATA, '00 00 00 00 00 00 00 00'))).toMatchObject({
      name: 'request_module_data',
      origin: 'inverter',
    });
    expect(decodeFrame(ext(REQUEST_MODULE_IDENTITY, '00 00 00 00 00 00 00 00')).name).toBe(
      'request_module_identity',
    );
  });
});

describe('helpers', () => {
  it('returns undefined for the reserved alarm encodings', () => {
    expect(alarmPair(0b00, 0)).toBeUndefined();
    expect(alarmPair(0b11, 0)).toBeUndefined();
    expect(alarmPair(0b01, 0)).toBe(true);
    expect(alarmPair(0b10, 0)).toBe(false);
  });

  it('parses and rejects ASCII addresses', () => {
    expect(parseAsciiAddress('0105')).toEqual({ group: 1, module: 5 });
    expect(parseAsciiAddress('')).toBeUndefined();
    expect(parseAsciiAddress('01')).toBeUndefined();
  });

  it('pads ids to 3 or 8 hex digits for cansend', () => {
    expect(formatCanId(0x373, false)).toBe('373');
    expect(formatCanId(REQUEST_MODULE_DATA, true)).toBe('04000000');
  });

  it('builds the 8 zero byte request payload the spec prescribes', () => {
    expect(requestPayload()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
