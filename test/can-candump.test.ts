import { describe, expect, it } from 'vitest';
import {
  formatCansendArg,
  parseCandumpLine,
  replayReader,
  type CanReader,
} from '../src/can/candump.js';
import { REQUEST_MODULE_DATA } from '../src/can/frames.js';
import { effectiveDurationMs, probeCan } from '../src/can/reading.js';
import { formatCanReading, runCli } from '../src/cli.js';
import type { CanFrame } from '../src/can/frames.js';
import { fixture } from './helpers.js';

const CAPTURE = 'candump-us3000d-can1.txt';

describe('parseCandumpLine', () => {
  it('parses the bare candump form', () => {
    expect(parseCandumpLine('  can1  373   [8]  A8 0C D1 0C 28 01 2B 01')).toEqual({
      id: 0x373,
      ext: false,
      data: [0xa8, 0x0c, 0xd1, 0x0c, 0x28, 0x01, 0x2b, 0x01],
    });
  });

  it('parses the -t d timestamped form', () => {
    expect(parseCandumpLine(' (000.000266)  can1  355   [4]  13 00 64 00')).toEqual({
      id: 0x355,
      ext: false,
      data: [0x13, 0x00, 0x64, 0x00],
    });
  });

  it('parses the absolute timestamp form', () => {
    expect(parseCandumpLine(' (1761564000.123456)  can1  35C   [2]  C0 00')?.id).toBe(0x35c);
  });

  it('treats an id longer than three hex digits as extended', () => {
    expect(parseCandumpLine('  can1  04010301   [8]  A8 0C D1 0C 64 00 22 13')).toMatchObject({
      id: 0x04010301,
      ext: true,
    });
  });

  it('accepts a zero-length frame', () => {
    expect(parseCandumpLine('  can1  123   [0] ')).toEqual({ id: 0x123, ext: false, data: [] });
  });

  it('skips error frames, remote requests and noise', () => {
    expect(parseCandumpLine('  can1  20000004   [8]  00 00 00 04 00 00 00 00   ERRORFRAME')).toBeUndefined();
    expect(parseCandumpLine('  can1  123   [8]  remote request')).toBeUndefined();
    expect(parseCandumpLine('')).toBeUndefined();
    expect(parseCandumpLine('interface can9 not found')).toBeUndefined();
  });
});

describe('formatCansendArg', () => {
  it('formats an extended request the way cansend wants it', () => {
    expect(
      formatCansendArg({ id: REQUEST_MODULE_DATA, ext: true, data: [0, 0, 0, 0, 0, 0, 0, 0] }),
    ).toBe('04000000#0000000000000000');
  });

  it('formats a standard frame', () => {
    expect(formatCansendArg({ id: 0x305, ext: false, data: [1, 0xab] })).toBe('305#01AB');
  });
});

describe('probeCan over the recorded US3000D capture', () => {
  const probe = () =>
    probeCan(replayReader(fixture(CAPTURE)), {
      interface: 'can1',
      durationMs: 60_000,
    });

  it('builds the stack summary', async () => {
    const r = await probe();
    expect(r.interface).toBe('can1');
    expect(r.stack).toMatchObject({
      manufacturer: 'PYLON',
      model: 'US3000D',
      firmwareVersion: '1.4',
      moduleCount: 6,
      modulesOnline: 6,
      modulesOffline: 0,
      modulesBlockingCharge: 0,
      modulesBlockingDischarge: 0,
      soc: 20,
      soh: 100,
      installedCapacity: 444,
      chargeVoltageLimit: 53.2,
      dischargeVoltageLimit: 45,
      chargeEnabled: true,
      dischargeEnabled: true,
    });
  });

  it('locates the extreme cells by module, as 0x374..0x377 reports them', async () => {
    const { stack } = await probe();
    expect(stack.minVoltageModule).toEqual({ group: 1, module: 3 });
    expect(stack.maxVoltageModule).toEqual({ group: 1, module: 3 });
    expect(stack.minTemperatureModule).toEqual({ group: 1, module: 6 });
    expect(stack.maxTemperatureModule).toEqual({ group: 1, module: 1 });
  });

  it('derives the cell voltage spread', async () => {
    const { stack } = await probe();
    expect(stack.minCellVoltage).toBeCloseTo(3.239, 3);
    expect(stack.maxCellVoltage).toBeCloseTo(3.279, 3);
    expect(stack.cellVoltageSpread).toBeCloseTo(0.04, 3);
    expect(stack.minCellTemperature).toBe(23);
    expect(stack.maxCellTemperature).toBe(26);
  });

  it('reports no protections, warnings or alarms for a healthy stack', async () => {
    const { stack } = await probe();
    expect(stack.protections).toEqual([]);
    expect(stack.warnings).toEqual([]);
    expect(stack.alarms).toEqual([]);
  });

  it('counts frames and finds no extended ones, because nothing asked for them', async () => {
    const r = await probe();
    expect(r.extendedFrames).toBe(0);
    expect(r.modules).toEqual([]);
    expect(Object.keys(r.frameCounts)).toContain('373');
    expect(r.frameCounts['373']).toBeGreaterThan(1);
    // 0x37A..0x37F and 0x385 are on the bus but absent from the published V2.0 tables.
    expect(r.unknownFrames).toContain('385');
    expect(r.errors).toEqual([]);
  });

  it('ignores the inverter-side frames when summarising the battery', async () => {
    const r = await probe();
    // 0x305/0x307 come from the GX device, so they must not be listed as undecoded.
    expect(r.frameCounts['305']).toBeGreaterThan(0);
    expect(r.unknownFrames).not.toContain('305');
    expect(r.unknownFrames).not.toContain('307');
  });
});

describe('probeCan with extended responses', () => {
  /** Reader that answers a 0x4000000 request the way the spec says a module should. */
  function requestableReader(): CanReader {
    const queue: CanFrame[] = [];
    let notify: (() => void) | undefined;
    const push = (id: number, data: number[]) => {
      queue.push({ id, ext: true, data });
      notify?.();
    };
    return {
      frames: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length === 0) {
              const waited = await new Promise<boolean>((resolve) => {
                notify = () => resolve(true);
                setTimeout(() => resolve(false), 2600);
              });
              if (!waited && queue.length === 0) return;
            }
            const next = queue.shift();
            if (next) yield next;
          }
        },
      }),
      send: (frame) => {
        if (frame.id === 0x4000000) {
          push(0x04010101, [0xa8, 0x0c, 0xd1, 0x0c, 0x64, 0x00, 0x22, 0x13]);
          push(0x04010102, [0x2b, 0x01, 0x28, 0x01, 0x0e, 0x01, 0x60, 0x01]);
          push(0x04010103, [0x00, 0x00, 0x13, 0x00, 0x64, 0x00, 0x4a, 0x00]);
          push(0x04010104, [0x00, 0x00, 0x00, 0x60, 0x00, 0x00, 0x00, 0x00]);
        }
        if (frame.id === 0x5000000) {
          push(0x05010101, [0x32, 0x30, 0x32, 0x31, 0x30, 0x39, 0x32, 0x33]);
          push(0x05010102, [0x30, 0x30, 0x31, 0x32, 0x00, 0x00, 0x00, 0x00]);
          push(0x05010105, [0x01, 0x04, 0x00, 0x00, 0x38, 0x03, 0x00, 0x00]);
        }
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
  }

  it('assembles one module from the four analog frames plus identity', async () => {
    const r = await probeCan(requestableReader(), {
      interface: 'can1',
      durationMs: 1000,
      request: true,
    });
    expect(r.extendedFrames).toBe(7);
    expect(r.modules).toHaveLength(1);
    expect(r.modules[0]).toMatchObject({
      group: 1,
      module: 1,
      minCellVoltage: 3.24,
      maxCellVoltage: 3.281,
      cellVoltageSpread: 0.041,
      voltage: 48.98,
      current: 10,
      maxCellTemperature: 29.9,
      minCellTemperature: 29.6,
      mosTemperature: 27,
      bmsTemperature: 35.2,
      soc: 19,
      soh: 100,
      nominalCapacity: 74,
      // The serial arrives in separate chunks and is concatenated in index order.
      serial: '202109230012',
      firmwareVersion: '1.4',
      flagBits: ['discharge_mos_on', 'charge_mos_on'],
      statusBits: [],
    });
  }, 10_000);

  it('stretches a short duration so both requests get answered', () => {
    // Read-only runs keep the duration they were given; requesting needs 2 s between
    // the two transmits, so a 1 s run would otherwise end before the second one.
    expect(effectiveDurationMs(1000, false)).toBe(1000);
    expect(effectiveDurationMs(1000, true)).toBe(4000);
    expect(effectiveDurationMs(30_000, true)).toBe(30_000);
  });

  it('records a failed transmit as an error instead of throwing', async () => {
    const reader = replayReader(fixture(CAPTURE));
    const r = await probeCan(reader, { interface: 'can1', durationMs: 50, request: true });
    expect(r.errors.join(' ')).toMatch(/cannot transmit/);
  });
});

describe('formatCanReading', () => {
  it('renders the summary and explains why there are no module frames', async () => {
    const reading = await probeCan(replayReader(fixture(CAPTURE)), {
      interface: 'can1',
      durationMs: 60_000,
    });
    const text = formatCanReading(reading);
    expect(text).toContain('PYLON US3000D');
    expect(text).toContain('6 module(s) online');
    expect(text).toContain('SOC 20 %');
    expect(text).toContain('SOH 100 %');
    expect(text).toContain('min V module 1/3');
    expect(text).toContain('no protections, warnings or alarms');
    expect(text).toContain('no extended (29-bit) frames seen');
    expect(text).toContain('--request');
  });
});

describe('can-probe via the CLI', () => {
  function run(argv: string[], reader: CanReader) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      result: runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, {
        createCanReader: () => reader,
      }),
      out,
      err,
    };
  }

  it('defaults to a read-only text report on can1', async () => {
    const r = run(['can-probe'], replayReader(fixture(CAPTURE)));
    expect(await r.result).toBe(0);
    expect(r.err.join('\n')).toContain('listening on can1 for 10 s (read-only)');
    expect(r.err.join('\n')).not.toContain('WARNING');
    expect(r.out.join('\n')).toContain('PYLON US3000D');
  });

  it('emits JSON with --format json', async () => {
    const r = run(['can-probe', '--format', 'json'], replayReader(fixture(CAPTURE)));
    expect(await r.result).toBe(0);
    const parsed = JSON.parse(r.out.join('\n')) as { stack: { model: string }; interface: string };
    expect(parsed.stack.model).toBe('US3000D');
    expect(parsed.interface).toBe('can1');
  });

  it('warns on stderr before transmitting with --request', async () => {
    const r = run(
      ['can-probe', '-i', 'can0', '--duration', '1', '--request'],
      replayReader(fixture(CAPTURE)),
    );
    await r.result;
    const err = r.err.join('\n');
    expect(err).toContain('WARNING: --request transmits 0x4000000 and 0x5000000 onto can0');
    expect(err).toContain('(transmitting requests)');
  });

  it('fails with advice when the interface produced nothing', async () => {
    const r = run(['can-probe', '--duration', '1'], replayReader(''));
    expect(await r.result).toBe(1);
    expect(r.err.join('\n')).toContain('BMS-Can is usually can1');
    // No point printing a summary of nothing.
    expect(r.out).toEqual([]);
  });

  it('surfaces a reader error for a silent interface', async () => {
    const broken: CanReader = {
      frames: () => ({
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error('candump can9 exited with code 1: interface can9 not found');
        },
      }),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const r = run(['can-probe', '-i', 'can9', '--duration', '1'], broken);
    expect(await r.result).toBe(1);
    expect(r.err.join('\n')).toContain('error: candump can9 exited with code 1');
  });

  it('rejects --format line for can-probe and text for points', () => {
    const io = { out: () => undefined, err: () => undefined };
    return Promise.all([
      expect(runCli(['can-probe', '--format', 'line'], io, {})).resolves.toBe(2),
      expect(runCli(['points', '--format', 'text'], io, {})).resolves.toBe(2),
    ]);
  });
});
