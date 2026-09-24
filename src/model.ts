/** Shared types for the pylontech-health node. */

export type StateName = string;

export interface CellStates {
  base: StateName;
  volt: StateName;
  curr: StateName;
  temp: StateName;
}

export interface Cell {
  /** Cell index as reported by the battery (0-based). */
  index: number;
  /** Volts. */
  voltage: number;
  /** Amps (negative = discharge). */
  current: number;
  /** Degrees Celsius. */
  temperature: number;
  /** Percent 0..100. */
  soc: number | undefined;
  /** Remaining charge in Ah. */
  coulombAh: number | undefined;
  /** Balancing active (BAL column), undefined if the firmware doesn't report it. */
  balancing: boolean | undefined;
  /** State of health in percent (soh command), if read. */
  soh?: number;
  states: CellStates;
  /** Any columns we did not recognise, keyed by normalised header name. */
  extra: Record<string, string>;
}

export interface BatteryStates extends CellStates {
  /** B.V.St – battery voltage state. */
  bv?: StateName;
  /** B.T.St – battery temperature state. */
  bt?: StateName;
  /** M.T.St – MOSFET temperature state. */
  mt?: StateName;
}

/** One row of `pwr`. */
export interface PowerRow {
  /** 1-based position in the stack (== argument of `bat N` / `info N`). */
  position: number;
  voltage: number;
  current: number;
  temperature: number;
  tempLow: number | undefined;
  tempHigh: number | undefined;
  voltLow: number | undefined;
  voltHigh: number | undefined;
  soc: number | undefined;
  /** Battery-reported timestamp, raw string. */
  time: string | undefined;
  mosTemperature: number | undefined;
  states: BatteryStates;
  extra: Record<string, string>;
}

/** Parsed `info N`. */
export interface BatteryInfo {
  deviceAddress: number | undefined;
  manufacturer: string | undefined;
  deviceName: string | undefined;
  barcode: string | undefined;
  pcbaBarcode: string | undefined;
  specification: string | undefined;
  cellNumber: number | undefined;
  firmware: {
    board: string | undefined;
    main: string | undefined;
    soft: string | undefined;
    boot: string | undefined;
    comm: string | undefined;
    releaseDate: string | undefined;
  };
  /** Every key/value line as reported. */
  raw: Record<string, string>;
}

/** Parsed `stat N` – lifetime statistics kept by the BMS. */
export interface BatteryStat {
  /** State of health in percent. */
  soh: number | undefined;
  /** Full equivalent cycles. */
  cycles: number | undefined;
  /** Total powered-on time in hours. */
  powerOnHours: number | undefined;
  shutdowns: number | undefined;
  resets: number | undefined;
  /** Largest cell voltage difference seen while charging, in volts. */
  maxChargeVoltDiff: number | undefined;
  /** Largest cell voltage difference seen while discharging, in volts. */
  maxDischargeVoltDiff: number | undefined;
  batteryHighVoltageEvents: number | undefined;
  batteryLowVoltageEvents: number | undefined;
  batteryOverVoltageEvents: number | undefined;
  batteryUnderVoltageEvents: number | undefined;
  lifeWarnings: number | undefined;
  lifeAlarms: number | undefined;
  /** Every key/value line as reported. */
  raw: Record<string, string>;
}

export interface CellStats {
  min: number;
  max: number;
  /** max - min in volts. */
  spread: number;
  /** Index (as emitted, see cellIndexBase) of min/max cell. */
  minCell: number;
  maxCell: number;
  count: number;
}

export interface Battery {
  position: number;
  info: BatteryInfo | undefined;
  stat: BatteryStat | undefined;
  power: PowerRow;
  cells: Cell[];
  cellStats: CellStats | undefined;
}

export interface StackReading {
  chain: number;
  polledAt: Date;
  durationMs: number;
  batteries: Battery[];
  errors: string[];
  /** Set when the firmware rejected `soh N`; callers should stop asking. */
  sohUnsupported?: boolean;
  /** Set when the firmware rejected `stat N`; callers should stop asking. */
  statUnsupported?: boolean;
}

/** Point shape accepted by node-red-contrib-influxdb "influxdb batch" nodes. */
export interface InfluxPoint {
  measurement: string;
  tags: Record<string, string>;
  fields: Record<string, number | string | boolean>;
  timestamp: Date;
}

export interface PointOptions {
  measurementPrefix: string;
  cellIndexBase: 0 | 1;
  includeStates: boolean;
}
