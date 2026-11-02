/** Shared types for the pylontech-health node. */

export type StateName = string;

export interface CellStates {
  base: StateName;
  volt: StateName;
  curr: StateName;
  /** Temperature verdict; on firmware with separate discharge/charge columns the first non-Normal one. */
  temp: StateName;
  /** Discharge / charge temperature states, only on firmware that prints them. */
  dtemp?: StateName;
  ctemp?: StateName;
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
  /**
   * Cell index (as reported, 0-based) of the coldest / warmest / lowest / highest cell.
   * Only on firmware that prints the `Tlow.Id` … `Vhigh.Id` columns (e.g. US3000D).
   */
  tempLowCell: number | undefined;
  tempHighCell: number | undefined;
  voltLowCell: number | undefined;
  voltHighCell: number | undefined;
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
  /** Mean cell voltage in volts. */
  mean: number;
  /** max - min in volts. */
  spread: number;
  /** Index (as emitted, see cellIndexBase) of min/max cell. */
  minCell: number;
  maxCell: number;
  count: number;
  /** Cell temperature statistics in degrees Celsius. */
  tempMin: number;
  tempMax: number;
  tempMean: number;
  /** tempMax - tempMin. */
  tempSpread: number;
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
  /**
   * Set when the firmware rejected `stat N` but answered the bare `stat` (US3000D: `stat [detail]`),
   * which describes the master only; callers should pass it back so slaves are not asked again.
   */
  statMasterOnly?: boolean;
  /** Same for `info N` vs the bare `info` (US3000D): barcode and firmware known for the master only. */
  infoMasterOnly?: boolean;
}

/**
 * Address of a module as the CAN protocol reports it: group M, module N within the group.
 * Pylontech prints it as four ASCII digits, e.g. `"0103"` = group 1, module 3.
 */
export interface CanModuleRef {
  /** Group number, 1-based. */
  group: number;
  /** Module address within the group, 1-based; the master battery is 1. */
  module: number;
}

/**
 * Per-module values from the extended (29-bit) CAN responses. Every field is optional:
 * the modules answer in four separate frames and a run may capture only some of them.
 */
export interface CanModuleReading extends CanModuleRef {
  /** Volts. */
  minCellVoltage?: number;
  maxCellVoltage?: number;
  /** max - min in volts, derived. */
  cellVoltageSpread?: number;
  /** Module terminal voltage in volts. */
  voltage?: number;
  /** Amps (negative = discharge). */
  current?: number;
  /** Degrees Celsius. */
  minCellTemperature?: number;
  maxCellTemperature?: number;
  mosTemperature?: number;
  bmsTemperature?: number;
  /** Percent 0..100. */
  soc?: number;
  soh?: number;
  /** Nameplate capacity of this module in Ah. */
  nominalCapacity?: number;
  /** Raw status / flag bitfields and error code from `0x4000004`. */
  status?: number;
  flag?: number;
  errorCode?: number;
  /** Names of the set status and flag bits, for display. */
  statusBits?: string[];
  flagBits?: string[];
  serial?: string;
  firmwareVersion?: string;
}

/** Stack-level values, all from the standard (11-bit) frames the battery broadcasts unasked. */
export interface CanStackSummary {
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  /** Module count from `0x359` byte 4, and the `0x372` counters. */
  moduleCount?: number;
  modulesOnline?: number;
  modulesOffline?: number;
  modulesBlockingCharge?: number;
  modulesBlockingDischarge?: number;
  /** Volts, amps, degrees Celsius. */
  voltage?: number;
  current?: number;
  temperature?: number;
  /** Percent 0..100. */
  soc?: number;
  soh?: number;
  minCellVoltage?: number;
  maxCellVoltage?: number;
  cellVoltageSpread?: number;
  minCellTemperature?: number;
  maxCellTemperature?: number;
  /** Which module holds the extreme cell, from `0x374`..`0x377`. */
  minVoltageModule?: CanModuleRef;
  maxVoltageModule?: CanModuleRef;
  minTemperatureModule?: CanModuleRef;
  maxTemperatureModule?: CanModuleRef;
  /** Installed capacity in Ah. */
  installedCapacity?: number;
  chargeVoltageLimit?: number;
  chargeCurrentLimit?: number;
  dischargeCurrentLimit?: number;
  dischargeVoltageLimit?: number;
  chargeEnabled?: boolean;
  dischargeEnabled?: boolean;
  /** Names of the active protection, warning and alarm bits. */
  protections: string[];
  warnings: string[];
  alarms: string[];
}

/** One `can-probe` run. */
export interface CanStackReading {
  /** SocketCAN interface the frames were read from, e.g. `can1`. */
  interface: string;
  polledAt: Date;
  durationMs: number;
  stack: CanStackSummary;
  /** Populated only when extended responses were seen, i.e. after a request was sent. */
  modules: CanModuleReading[];
  /** How many frames of each id arrived, keyed by the id as hex. */
  frameCounts: Record<string, number>;
  /** Number of extended (29-bit) frames seen; zero unless something requested them. */
  extendedFrames: number;
  /** Ids we have no definition for, as hex, so new firmware shows up instead of being hidden. */
  unknownFrames: string[];
  errors: string[];
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
