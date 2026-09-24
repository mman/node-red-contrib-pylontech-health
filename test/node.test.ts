import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import helper from 'node-red-node-test-helper';
import { registerPylontechHealth, setPortFactory, readSettings } from '../src/index.js';
import type { InfluxPoint, StackReading } from '../src/model.js';
import { FakePort, type FakePortOptions } from './fake-port.js';

helper.init(require.resolve('node-red'));

let ports: FakePort[] = [];
function usePorts(opts: FakePortOptions = {}) {
  ports = [];
  setPortFactory((path, baud) => {
    const p = new FakePort(path, baud, opts);
    ports.push(p);
    return p;
  });
}

const flow = (extra: Record<string, unknown> = {}) => [
  {
    id: 'n1',
    type: 'pylontech-health',
    name: 'stack',
    port: '/dev/ttyFAKE',
    wires: [['p'], ['h']],
    commandTimeout: 300,
    ...extra,
  },
  { id: 'p', type: 'helper' },
  { id: 'h', type: 'helper' },
];

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface StatusEvent {
  fill?: string;
  shape?: string;
  text?: string;
}
function trackStatus(node: {
  on: (ev: string, cb: (s: StatusEvent) => void) => void;
}): StatusEvent[] {
  const events: StatusEvent[] = [];
  node.on('call:status', (call: unknown) => {
    const c = call as { args: StatusEvent[] };
    if (c.args[0]) events.push(c.args[0]);
  });
  return events;
}

function received<T = unknown>(node: {
  on: (ev: string, cb: (m: { payload: T } & Record<string, unknown>) => void) => void;
}) {
  const msgs: ({ payload: T } & Record<string, unknown>)[] = [];
  node.on('input', (m) => msgs.push(m));
  return msgs;
}

describe('readSettings', () => {
  it('applies defaults and coerces editor strings', () => {
    const s = readSettings({ id: 'x', type: 'pylontech-health', name: '', z: '' });
    expect(s).toMatchObject({
      port: '/dev/ttyPYLON',
      baud: 115200,
      wakeup: true,
      chain: 1,
      readSoh: false,
    });
    expect(s.points).toEqual({
      measurementPrefix: 'pylontech',
      cellIndexBase: 1,
      includeStates: true,
    });
    expect(s.infoTtlMs).toBe(3_600_000);
    const t = readSettings({
      id: 'x',
      type: 'pylontech-health',
      name: '',
      z: '',
      port: ' /dev/serial/by-id/usb-x ',
      baud: '9600',
      wakeup: 'false',
      chain: '3',
      cellIndexBase: '0',
      includeStates: 'false',
      refreshInfoEvery: '0',
      measurementPrefix: ' bms ',
      readSoh: 'true',
    });
    expect(t).toMatchObject({
      port: '/dev/serial/by-id/usb-x',
      baud: 9600,
      wakeup: false,
      chain: 3,
      readSoh: true,
      infoTtlMs: 0,
    });
    expect(t.points).toEqual({ measurementPrefix: 'bms', cellIndexBase: 0, includeStates: false });
  });
});

describe('pylontech-health node', () => {
  beforeAll(() => helper.startServer());
  afterAll(() => helper.stopServer());
  afterEach(async () => {
    await helper.unload();
    setPortFactory(undefined);
  });

  it('connects on deploy and reports ready', async () => {
    usePorts({ requireWake: true });
    await helper.load(registerPylontechHealth, flow());
    const n1 = helper.getNode('n1');
    const statuses = trackStatus(n1);
    await waitFor(() => statuses.find((s) => s.text === 'ready'));
    expect(ports).toHaveLength(1);
    expect(ports[0]!.baudRate).toBe(115200);
    expect(statuses[0]!.fill).toBe('yellow');
    expect(statuses.at(-1)).toMatchObject({ fill: 'green', shape: 'dot', text: 'ready' });
  });

  it('polls on input and emits influx points and the health model', async () => {
    usePorts();
    await helper.load(registerPylontechHealth, flow({ chain: 2, measurementPrefix: 'bms' }));
    const n1 = helper.getNode('n1');
    const points = received<InfluxPoint[]>(helper.getNode('p'));
    const health = received<StackReading>(helper.getNode('h'));
    const statuses = trackStatus(n1);
    await waitFor(() => statuses.find((s) => s.text === 'ready'));

    n1.receive({ payload: Date.now() });
    await waitFor(() => (points.length && health.length ? true : undefined));

    expect(ports[0]!.commands.slice(1)).toEqual([
      'pwr',
      'info 1',
      'stat 1',
      'bat 1',
      'info 2',
      'stat 2',
      'bat 2',
    ]);
    const pts = points[0]!.payload;
    expect(pts[1]!.fields).toMatchObject({ soh: 94, cycle_count: 686 });
    expect(pts).toHaveLength(1 + 2 + 30);
    expect(pts[0]).toMatchObject({ measurement: 'bms/stack', tags: { chain: '2' } });
    expect(pts[3]).toMatchObject({
      measurement: 'bms/cell',
      tags: {
        chain: '2',
        battery: '1',
        battery_id: 'B01',
        cell: '1',
        cell_id: 'B01/C01',
        barcode: 'PPTBH02212345678',
      },
    });
    expect(pts[3]!.timestamp).toBeInstanceOf(Date);
    expect(points[0]!.topic).toBe('bms/points'.replace('bms', 'pylontech'));

    const h = health[0]!.payload;
    expect(h.chain).toBe(2);
    expect(h.batteries).toHaveLength(2);
    expect(h.errors).toEqual([]);
    expect(statuses.at(-1)!.text).toMatch(/^2 batt · 30 cells · \d+\.\ds$/);

    // Second poll uses the info cache.
    n1.receive({ payload: 1 });
    await waitFor(() => (points.length === 2 ? true : undefined));
    expect(ports[0]!.commands.slice(8)).toEqual(['pwr', 'bat 1', 'bat 2']);

    // Forced refresh re-reads info and stat.
    n1.receive({ payload: 1, refresh: true });
    await waitFor(() => (points.length === 3 ? true : undefined));
    expect(ports[0]!.commands.slice(11)).toEqual([
      'pwr',
      'info 1',
      'stat 1',
      'bat 1',
      'info 2',
      'stat 2',
      'bat 2',
    ]);
  });

  it('runs a raw command passthrough on output 2 only', async () => {
    usePorts();
    await helper.load(registerPylontechHealth, flow());
    const n1 = helper.getNode('n1');
    const points = received(helper.getNode('p'));
    const health = received<{ command: string; raw: string }>(helper.getNode('h'));
    const statuses = trackStatus(n1);
    await waitFor(() => statuses.find((s) => s.text === 'ready'));

    n1.receive({ payload: 'x', command: ' info 2 ' });
    await waitFor(() => (health.length ? true : undefined));
    expect(points).toHaveLength(0);
    expect(health[0]!.payload.command).toBe('info 2');
    expect(health[0]!.payload.raw).toContain('Barcode');
    expect(health[0]!.topic).toBe('pylontech/raw');
  });

  it('reports an error when the port cannot be opened and retries', async () => {
    usePorts({ openError: new Error('ENOENT: no such file or directory') });
    await helper.load(registerPylontechHealth, flow());
    const n1 = helper.getNode('n1');
    const statuses = trackStatus(n1);
    const errors: string[] = [];
    n1.on('call:error', (c: { args: unknown[] }) => errors.push(String(c.args[0])));
    await waitFor(() => statuses.find((s) => s.fill === 'red'));
    expect(statuses.at(-1)!.text).toMatch(/retry in 5s/);
    expect(errors[0]).toMatch(/cannot open \/dev\/ttyFAKE: ENOENT/);

    // Input while disconnected fails the message.
    const done = new Promise<string>((r) =>
      n1.on('call:error', (c: { args: unknown[] }) => r(String(c.args[0]))),
    );
    n1.receive({ payload: 1 });
    expect(await done).toMatch(/not connected/);
  });

  it('emits an error message on output 2 when the poll fails', async () => {
    usePorts({ silent: ['pwr'] });
    await helper.load(registerPylontechHealth, flow({ pollTimeout: 1000 }));
    const n1 = helper.getNode('n1');
    const health = received<null>(helper.getNode('h'));
    const statuses = trackStatus(n1);
    await waitFor(() => statuses.find((s) => s.text === 'ready'));
    n1.receive({ payload: 1 });
    await waitFor(() => (health.length ? true : undefined));
    expect(health[0]!.payload).toBeNull();
    expect(health[0]!.error).toMatch(/Timeout/);
    expect(statuses.some((s) => s.fill === 'red' && s.text === 'poll failed')).toBe(true);
    // Timeout triggers a reconnect → a second port is created.
    await waitFor(() => (ports.length === 2 ? true : undefined));
  });

  it('disables soh after the firmware rejects it, with one warning', async () => {
    usePorts({ responses: { 'soh 1': 'soh-unsupported.txt', 'soh 2': 'soh-unsupported.txt' } });
    await helper.load(registerPylontechHealth, flow({ readSoh: true }));
    const n1 = helper.getNode('n1');
    const points = received<InfluxPoint[]>(helper.getNode('p'));
    const statuses = trackStatus(n1);
    const warnings: string[] = [];
    n1.on('call:warn', (c: { args: unknown[] }) => warnings.push(String(c.args[0])));
    await waitFor(() => statuses.find((s) => s.text === 'ready'));
    n1.receive({ payload: 1 });
    await waitFor(() => (points.length === 1 ? true : undefined));
    n1.receive({ payload: 1 });
    await waitFor(() => (points.length === 2 ? true : undefined));
    expect(ports[0]!.commands.filter((c) => c.startsWith('soh'))).toEqual(['soh 1']);
    expect(warnings.filter((w) => /state of health disabled/.test(w))).toHaveLength(1);
    expect(statuses.at(-1)!.text).toMatch(/^2 batt · 30 cells/); // second poll clean, no err suffix
  });

  it('reconnects when the port disappears', async () => {
    usePorts();
    await helper.load(registerPylontechHealth, flow());
    const n1 = helper.getNode('n1');
    const statuses = trackStatus(n1);
    await waitFor(() => statuses.find((s) => s.text === 'ready'));
    ports[0]!.disconnect();
    await waitFor(() => statuses.find((s) => s.text?.startsWith('port closed')));
    expect(statuses.at(-1)).toMatchObject({ fill: 'red', shape: 'ring' });
  });
});
