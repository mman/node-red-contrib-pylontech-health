/**
 * Collects decoded CAN frames into one {@link CanStackReading}.
 *
 * Listening is passive and safe to run alongside Venus OS' own `can-bus-bms`.
 * The extended per-module frames are a different matter: since rev 2.0.1 of the spec
 * the BMS only answers them when an upper device asks, so they appear on the bus only
 * if {@link ProbeOptions.request} is set and we transmit. That writes to the bus the
 * battery uses to talk to the GX device, which is why it is never the default.
 */
import type { CanModuleReading, CanStackReading, CanStackSummary } from '../model.js';
import type { CanReader } from './candump.js';
import {
  decodeFrame,
  formatCanId,
  requestPayload,
  REQUEST_MIN_INTERVAL_MS,
  REQUEST_MODULE_DATA,
  REQUEST_MODULE_IDENTITY,
  MODULE_FLAG_BITS,
  MODULE_STATUS_BITS,
  type CanFrame,
  type DecodedFrame,
} from './frames.js';

export interface ProbeOptions {
  /** Interface name, recorded in the reading. */
  interface: string;
  /** How long to listen, in milliseconds. */
  durationMs: number;
  /** Transmit the extended requests. Writes to the shared BMS-Can bus. Default false. */
  request?: boolean;
  /** Injected clock, for tests. */
  now?: () => number;
  /** Called for every decoded frame, for verbose output. */
  onFrame?: (frame: DecodedFrame) => void;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const r3 = (n: number): number => Number(n.toFixed(3));

const moduleRef = (f: DecodedFrame) => {
  const group = num(f.fields['group']);
  const module = num(f.fields['module']);
  return group !== undefined && module !== undefined ? { group, module } : undefined;
};

/** Names of the set bits in a `0x4000004` bitfield, skipping the reserved ones. */
function setBits(value: number, names: Record<number, string>): string[] {
  return Object.entries(names)
    .filter(([bit, name]) => !name.startsWith('reserved_') && ((value >> Number(bit)) & 1) === 1)
    .map(([, name]) => name);
}

/** Active flags out of a `0x359` / `0x35A` decode, by key prefix. */
function activeFlags(fields: DecodedFrame['fields'], prefix: string): string[] {
  return Object.entries(fields)
    .filter(([key, value]) => key.startsWith(prefix) && value === true)
    .map(([key]) => key.slice(prefix.length));
}

class Collector {
  readonly stack: CanStackSummary = { protections: [], warnings: [], alarms: [] };
  readonly frameCounts: Record<string, number> = {};
  readonly unknown = new Set<string>();
  readonly modules = new Map<string, CanModuleReading>();
  /** Serial number chunks per module, keyed `group/module` then by chunk index 1..4. */
  private readonly serialParts = new Map<string, Map<number, string>>();
  extendedFrames = 0;

  add(frame: CanFrame): DecodedFrame {
    const decoded = decodeFrame(frame);
    const key = formatCanId(frame.id, frame.ext);
    this.frameCounts[key] = (this.frameCounts[key] ?? 0) + 1;
    if (frame.ext) this.extendedFrames += 1;
    if (decoded.name === 'unknown') this.unknown.add(key);
    if (decoded.origin === 'battery') this.apply(decoded);
    return decoded;
  }

  private module(decoded: DecodedFrame): CanModuleReading | undefined {
    const addr = decoded.address;
    if (!addr) return undefined;
    const key = `${addr.group}/${addr.module}`;
    let mod = this.modules.get(key);
    if (!mod) {
      mod = { group: addr.group, module: addr.module };
      this.modules.set(key, mod);
    }
    return mod;
  }

  private apply(decoded: DecodedFrame): void {
    const f = decoded.fields;
    const s = this.stack;
    switch (decoded.name) {
      case 'charge_discharge_limits':
        s.chargeVoltageLimit = num(f['charge_voltage_limit']);
        s.chargeCurrentLimit = num(f['charge_current_limit']);
        s.dischargeCurrentLimit = num(f['discharge_current_limit']);
        s.dischargeVoltageLimit = num(f['discharge_voltage_limit']);
        return;
      case 'soc_soh':
        s.soc = num(f['soc']);
        s.soh = num(f['soh']);
        return;
      case 'measurements':
        s.voltage = num(f['voltage']);
        s.current = num(f['current']);
        s.temperature = num(f['temperature']);
        return;
      case 'protect_and_alarm':
        s.moduleCount = num(f['module_count']);
        s.protections = activeFlags(f, 'protect_');
        s.warnings = activeFlags(f, 'warn_');
        return;
      case 'alarm_details':
        s.alarms = activeFlags(f, 'alarm_');
        return;
      case 'charge_discharge_flags':
        s.chargeEnabled = bool(f['charge_enable']);
        s.dischargeEnabled = bool(f['discharge_enable']);
        return;
      case 'manufacturer':
        s.manufacturer = str(f['manufacturer']);
        return;
      case 'version_and_capacity':
        s.hardwareVersion = str(f['hardware_version']);
        s.firmwareVersion = str(f['firmware_version']);
        return;
      case 'module_counts':
        s.modulesOnline = num(f['modules_online']);
        s.modulesBlockingCharge = num(f['modules_blocking_charge']);
        s.modulesBlockingDischarge = num(f['modules_blocking_discharge']);
        s.modulesOffline = num(f['modules_offline']);
        return;
      case 'cell_min_max': {
        s.minCellVoltage = num(f['min_cell_voltage']);
        s.maxCellVoltage = num(f['max_cell_voltage']);
        s.minCellTemperature = num(f['min_cell_temperature']);
        s.maxCellTemperature = num(f['max_cell_temperature']);
        if (s.minCellVoltage !== undefined && s.maxCellVoltage !== undefined)
          s.cellVoltageSpread = r3(s.maxCellVoltage - s.minCellVoltage);
        return;
      }
      case 'min_voltage_module':
        s.minVoltageModule = moduleRef(decoded);
        return;
      case 'max_voltage_module':
        s.maxVoltageModule = moduleRef(decoded);
        return;
      case 'min_temperature_module':
        s.minTemperatureModule = moduleRef(decoded);
        return;
      case 'max_temperature_module':
        s.maxTemperatureModule = moduleRef(decoded);
        return;
      case 'total_capacity':
        s.installedCapacity = num(f['installed_capacity']);
        return;
      case 'battery_model':
        s.model = str(f['model']);
        return;
      case 'module_voltages': {
        const m = this.module(decoded);
        if (!m) return;
        m.minCellVoltage = num(f['min_cell_voltage']);
        m.maxCellVoltage = num(f['max_cell_voltage']);
        m.current = num(f['current']);
        m.voltage = num(f['voltage']);
        if (m.minCellVoltage !== undefined && m.maxCellVoltage !== undefined)
          m.cellVoltageSpread = r3(m.maxCellVoltage - m.minCellVoltage);
        return;
      }
      case 'module_temperatures': {
        const m = this.module(decoded);
        if (!m) return;
        m.maxCellTemperature = num(f['max_cell_temperature']);
        m.minCellTemperature = num(f['min_cell_temperature']);
        m.mosTemperature = num(f['mos_temperature']);
        m.bmsTemperature = num(f['bms_temperature']);
        return;
      }
      case 'module_soc_soh': {
        const m = this.module(decoded);
        if (!m) return;
        m.soc = num(f['soc']);
        m.soh = num(f['soh']);
        m.nominalCapacity = num(f['nominal_capacity']);
        return;
      }
      case 'module_status': {
        const m = this.module(decoded);
        if (!m) return;
        m.status = num(f['status']);
        m.flag = num(f['flag']);
        m.errorCode = num(f['error_code']);
        if (m.status !== undefined) m.statusBits = setBits(m.status, MODULE_STATUS_BITS);
        if (m.flag !== undefined) m.flagBits = setBits(m.flag, MODULE_FLAG_BITS);
        return;
      }
      case 'module_serial': {
        const m = this.module(decoded);
        if (!m) return;
        // The serial arrives in up to four 8-byte chunks, each in its own frame;
        // collect them by index and concatenate once the run is over.
        const part = str(f['serial_part']);
        const index = num(f['serial_index']);
        if (part === undefined || index === undefined) return;
        const key = `${m.group}/${m.module}`;
        const parts = this.serialParts.get(key) ?? new Map<number, string>();
        parts.set(index, part);
        this.serialParts.set(key, parts);
        return;
      }
      case 'module_firmware': {
        const m = this.module(decoded);
        if (!m) return;
        m.firmwareVersion = str(f['firmware_version']);
        return;
      }
      default:
        return;
    }
  }

  finish(iface: string, polledAt: Date, durationMs: number, errors: string[]): CanStackReading {
    const modules = [...this.modules.values()]
      .map((m) => {
        const parts = this.serialParts.get(`${m.group}/${m.module}`);
        if (!parts) return m;
        const serial = [...parts.keys()]
          .sort((a, b) => a - b)
          .map((i) => parts.get(i) ?? '')
          .join('');
        return serial ? { ...m, serial } : m;
      })
      .sort((a, b) => a.group - b.group || a.module - b.module);
    return {
      interface: iface,
      polledAt,
      durationMs,
      stack: this.stack,
      modules,
      frameCounts: this.frameCounts,
      extendedFrames: this.extendedFrames,
      unknownFrames: [...this.unknown].sort(),
      errors,
    };
  }
}

/**
 * How long a probe really listens. Requesting takes two transmits spaced by the spec's
 * minimum interval, so a short `--duration` is stretched to cover both and their replies;
 * otherwise we would put frames on the bus after we had stopped listening for answers.
 */
export function effectiveDurationMs(durationMs: number, request = false): number {
  return request ? Math.max(durationMs, REQUEST_MIN_INTERVAL_MS * 2) : durationMs;
}

/** Listen on `reader` for the configured duration and build one reading. */
export async function probeCan(reader: CanReader, opts: ProbeOptions): Promise<CanStackReading> {
  const now = opts.now ?? Date.now;
  const started = now();
  const polledAt = new Date();
  const deadline = started + effectiveDurationMs(opts.durationMs, opts.request);
  const collector = new Collector();
  const errors: string[] = [];

  const requests = opts.request ? sendRequests(reader, errors) : undefined;

  try {
    const iterator = reader.frames()[Symbol.asyncIterator]();
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), remaining);
      });
      let next: 'expired' | IteratorResult<CanFrame>;
      try {
        next = await Promise.race([iterator.next(), expired]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (next === 'expired') break;
      if (next.done) break;
      const decoded = collector.add(next.value);
      opts.onFrame?.(decoded);
    }
  } catch (err) {
    errors.push((err as Error).message);
  } finally {
    await requests?.catch(() => undefined);
    await reader.close().catch(() => undefined);
  }

  return collector.finish(opts.interface, polledAt, now() - started, errors);
}

/**
 * Ask for the per-module data and then, after the spec's minimum interval, the identity.
 * Failures are recorded rather than thrown: a probe that could not transmit is still a
 * useful read-only reading.
 */
async function sendRequests(reader: CanReader, errors: string[]): Promise<void> {
  const ask = async (id: number, label: string): Promise<void> => {
    try {
      await reader.send({ id, ext: true, data: requestPayload() });
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`);
    }
  };
  await ask(REQUEST_MODULE_DATA, 'request module data');
  await new Promise((resolve) => setTimeout(resolve, REQUEST_MIN_INTERVAL_MS));
  await ask(REQUEST_MODULE_IDENTITY, 'request module identity');
}
