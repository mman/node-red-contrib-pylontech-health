import { describe, expect, it } from 'vitest';
import { ConsoleTimeoutError, PylontechConsole, WAKE_SEQUENCE } from '../src/console.js';
import { FakePort, type FakePortOptions } from './fake-port.js';
import { fixture } from './helpers.js';

function make(
  opts: FakePortOptions = {},
  consoleOpts: Partial<ConstructorParameters<typeof PylontechConsole>[0]> = {},
) {
  let port: FakePort | undefined;
  const con = new PylontechConsole({
    path: '/dev/ttyFAKE',
    wakeDelayMs: 1,
    commandTimeoutMs: 200,
    createPort: (path, baud) => (port = new FakePort(path, baud, opts)),
    ...consoleOpts,
  });
  return { con, port: () => port! };
}

describe('PylontechConsole', () => {
  it('wakes the console at 1200 baud, switches to 115200 and probes the prompt', async () => {
    const { con, port } = make({ requireWake: true });
    await con.open();
    expect(con.isOpen).toBe(true);
    expect(port().writes[0]).toBe(WAKE_SEQUENCE);
    expect(port().baudRate).toBe(115200);
    expect(port().commands).toEqual(['']);
    await con.close();
    expect(con.isOpen).toBe(false);
  });

  it('skips the wake sequence when disabled', async () => {
    const { con, port } = make({}, { wakeup: false });
    await con.open();
    expect(port().writes).toEqual(['\n']);
    expect(port().baudRate).toBe(115200);
    await con.close();
  });

  it('fails open() when the console never answers and closes the port', async () => {
    const { con, port } = make({ silent: [''] });
    await expect(con.open()).rejects.toBeInstanceOf(ConsoleTimeoutError);
    expect(port().isOpen).toBe(false);
    expect(con.isOpen).toBe(false);
  });

  it('propagates open errors', async () => {
    const { con } = make({ openError: new Error('ENOENT: no such device') });
    await expect(con.open()).rejects.toThrow(/ENOENT/);
  });

  it('returns the response body without the prompt and serialises commands', async () => {
    const { con, port } = make({ latencyMs: 5 });
    await con.open();
    const [pwr, bat] = await Promise.all([con.command('pwr'), con.command('bat 1')]);
    expect(pwr).toMatch(/^pwr\r\n@/);
    expect(pwr).toMatch(/\$\$\r\n$/);
    expect(pwr).not.toContain('pylon>');
    expect(bat).toContain('Battery  Volt');
    expect(port().commands).toEqual(['', 'pwr', 'bat 1']);
    await con.close();
  });

  it('times out a hung command with partial output and keeps working afterwards', async () => {
    const { con } = make({ silent: ['bat 3'] });
    await con.open();
    await expect(con.command('bat 3')).rejects.toBeInstanceOf(ConsoleTimeoutError);
    await expect(con.command('pwr')).resolves.toContain('Power Volt');
    await con.close();
  });

  it('answers the pager prompt with Enter and returns the whole output', async () => {
    const { con, port } = make({
      pageLines: { help: 4 },
      responses: { help: fixture('help-us3000c.txt').replace(/pylon>$/, '') },
    });
    await con.open();
    const out = await con.command('help');
    expect(out).toContain('bat      Battery data show');
    expect(out).toContain('euro     dsplay Euro stat list');
    expect(out).not.toMatch(/Press \[Enter\]/);
    // one Enter per extra page, none recorded as commands
    expect(port().writes.filter((w) => w === '\n').length).toBeGreaterThan(2);
    expect(port().commands).toEqual(['', 'help']);
    await con.close();
  });

  it('treats the timeout as inactivity, not total duration', async () => {
    const { con } = make({ latencyMs: 150 }, { commandTimeoutMs: 200 });
    await con.open();
    // Each response arrives after 150 ms (< 200 ms timeout) even though several commands take > 200 ms total.
    const t0 = Date.now();
    await con.command('pwr');
    await con.command('bat 1');
    expect(Date.now() - t0).toBeGreaterThan(250);
    await con.close();
  });

  it('emits close and rejects pending commands when the port disappears', async () => {
    const { con, port } = make({ silent: ['pwr'] });
    await con.open();
    const closed = new Promise<void>((r) => con.once('close', () => r()));
    const pending = con.command('pwr');
    await new Promise((r) => setTimeout(r, 10)); // let the write happen
    expect(port().commands).toContain('pwr');
    port().disconnect();
    await expect(pending).rejects.toThrow(/closed/);
    await closed;
    expect(con.isOpen).toBe(false);
    await expect(con.command('pwr')).rejects.toThrow(/not open/);
  });
});
