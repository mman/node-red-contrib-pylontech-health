import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs, runCli, USAGE } from '../src/cli.js';
import type { InfluxPoint, StackReading } from '../src/model.js';
import { FakePort, type FakePortOptions } from './fake-port.js';

function run(argv: string[], portOpts: FakePortOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ports: FakePort[] = [];
  const code = runCli(
    argv,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    { createPort: (path, baud) => (ports[ports.length] = new FakePort(path, baud, portOpts)) },
  );
  return { code, out, err, ports };
}

describe('parseCliArgs', () => {
  it('applies node defaults', () => {
    const o = parseCliArgs(['poll']);
    expect(o).toMatchObject({
      port: '/dev/ttyPYLON',
      baud: 115200,
      wakeup: true,
      chain: 1,
      timeoutMs: 3000,
      readSoh: false,
      command: 'poll',
      positionals: [],
      format: 'json',
      only: [],
    });
    expect(o.points).toEqual({
      measurementPrefix: 'pylontech',
      cellIndexBase: 1,
      includeStates: true,
    });
  });

  it('parses all options', () => {
    const o = parseCliArgs([
      '-p',
      '/dev/serial/by-id/x',
      '-b',
      '9600',
      '--no-wakeup',
      '--chain',
      '2',
      '--prefix',
      'bms',
      '--cell-base',
      '0',
      '--no-states',
      '--soh',
      '--timeout',
      '500',
      '--only',
      'cell',
      '--only',
      'stack',
      '--format',
      'line',
      'raw',
      'bat',
      '2',
    ]);
    expect(o).toMatchObject({
      port: '/dev/serial/by-id/x',
      baud: 9600,
      wakeup: false,
      chain: 2,
      timeoutMs: 500,
      readSoh: true,
      only: ['cell', 'stack'],
      format: 'line',
      command: 'raw',
      positionals: ['bat', '2'],
    });
    expect(o.points).toEqual({ measurementPrefix: 'bms', cellIndexBase: 0, includeStates: false });
  });

  it('rejects bad values', () => {
    expect(() => parseCliArgs(['--baud', 'fast', 'poll'])).toThrow(/--baud/);
    expect(() => parseCliArgs(['--only', 'cells', 'points'])).toThrow(/--only/);
    expect(() => parseCliArgs(['--format', 'csv', 'points'])).toThrow(/--format/);
  });
});

describe('runCli', () => {
  it('prints usage without a command or with --help', async () => {
    const a = run([]);
    expect(await a.code).toBe(2);
    expect(a.out[0]).toBe(USAGE);
    const b = run(['--help']);
    expect(await b.code).toBe(0);
    expect(a.ports).toHaveLength(0);
  });

  it('probe wakes the console and prints master info', async () => {
    const r = run(['-p', '/dev/ttyFAKE', 'probe'], {
      requireWake: true,
      responses: { info: 'info-us3000c.txt' },
    });
    expect(await r.code).toBe(0);
    expect(r.ports[0]!.baudRate).toBe(115200);
    const res = JSON.parse(r.out[0]!) as {
      port: string;
      batteries: number[];
      master: { barcode: string };
    };
    expect(res.port).toBe('/dev/ttyFAKE');
    expect(res.batteries).toEqual([1, 2]);
    expect(res.master.barcode).toBe('PPTBH02212345678');
    expect(r.err.join('\n')).toMatch(/console answered with prompt/);
    expect(r.ports[0]!.isOpen).toBe(false);
  });

  it('poll prints the model as JSON', async () => {
    const r = run(['poll', '--chain', '3']);
    expect(await r.code).toBe(0);
    const reading = JSON.parse(r.out[0]!) as StackReading;
    expect(reading.chain).toBe(3);
    expect(reading.batteries).toHaveLength(2);
    expect(reading.batteries[0]!.cells).toHaveLength(15);
    expect(r.ports[0]!.commands.slice(1)).toEqual([
      'pwr',
      'info 1',
      'stat 1',
      'bat 1',
      'info 2',
      'stat 2',
      'bat 2',
    ]);
    expect(reading.batteries[0]!.stat?.soh).toBe(94);
  });

  it('points filters by --only and emits line protocol', async () => {
    const r = run([
      'points',
      '--only',
      'stack',
      '--only',
      'battery',
      '--format',
      'line',
      '--prefix',
      'bms',
    ]);
    expect(await r.code).toBe(0);
    const lines = r.out[0]!.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^bms\/stack,chain=1 battery_count=2,/);
    expect(lines[1]).toMatch(
      /^bms\/battery,barcode=PPTBH02212345678,battery=1,chain=1 voltage=49.64,/,
    );
    expect(r.err.at(-1)).toMatch(/3 point\(s\), timestamps in ms/);
  });

  it('points defaults to all measurements as JSON', async () => {
    const r = run(['points', '--soh']);
    expect(await r.code).toBe(0);
    const pts = JSON.parse(r.out[0]!) as InfluxPoint[];
    expect(pts).toHaveLength(33);
    expect(pts[3]!.fields['soh']).toBe(100);
    expect(r.ports[0]!.commands).toContain('soh 1');
  });

  it('returns 1 when the poll had errors', async () => {
    const r = run(['points'], { silent: ['bat 2'] });
    expect(await r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/warning: bat 2: Timeout/);
  });

  it('raw runs a command and prints its output', async () => {
    const r = run(['raw', 'bat', '2']);
    expect(await r.code).toBe(0);
    expect(r.out[0]).toContain('Battery  Volt');
    expect(r.out[0]).not.toContain('\r');
    expect(r.ports[0]!.commands).toEqual(['', 'bat 2']);
  });

  it('prints partial output when a command times out', async () => {
    const r = run(['--timeout', '300', 'raw', 'help'], {
      responses: { help: 'help\r\n@\r\nsome commands...\r\n' },
      silent: ['help'],
      partial: { help: 'help\r\n@\r\nsome commands...\r\n' },
    });
    expect(await r.code).toBe(1);
    const err = r.err.join('\n');
    expect(err).toMatch(/error: Timeout after 300 ms/);
    expect(err).toMatch(/received before the timeout/);
    expect(err).toContain('some commands...');
  });

  it('fails cleanly when the port cannot be opened', async () => {
    const r = run(['probe'], {
      openError: new Error('ENOENT: no such file or directory, cannot open /dev/ttyPYLON'),
    });
    expect(await r.code).toBe(1);
    expect(r.err.at(-1)).toMatch(/error: ENOENT/);
  });

  describe('capture', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('writes one fixture file per command', async () => {
      dir = mkdtempSync(join(tmpdir(), 'pyl-'));
      const r = run(['capture', dir, '--soh'], { responses: { info: 'info-us3000c.txt' } });
      expect(await r.code).toBe(0);
      expect(readdirSync(dir).sort()).toEqual([
        'bat-1.txt',
        'bat-2.txt',
        'info-1.txt',
        'info-2.txt',
        'info.txt',
        'pwr.txt',
        'soh-1.txt',
        'soh-2.txt',
        'stat-1.txt',
        'stat-2.txt',
      ]);
      expect(readFileSync(join(dir, 'bat-1.txt'), 'utf8')).toMatch(/pylon>$/);
    });
  });
});
