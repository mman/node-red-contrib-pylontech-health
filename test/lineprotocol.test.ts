import { describe, expect, it } from 'vitest';
import { toLineProtocol, toLineProtocolBatch } from '../src/lineprotocol.js';

const ts = new Date('2026-09-23T12:00:00Z');

describe('toLineProtocol', () => {
  it('escapes measurement, sorts tags and types fields', () => {
    const line = toLineProtocol({
      measurement: 'pylontech/cell',
      tags: { cell: '1', battery: '2', chain: '1' },
      fields: { voltage: 3.305, soc: 87, balancing: false, base_state: 'Dischg' },
      timestamp: ts,
    });
    expect(line).toBe(
      `pylontech/cell,battery=2,cell=1,chain=1 voltage=3.305,soc=87,balancing=false,base_state="Dischg" ${ts.getTime()}`,
    );
  });

  it('escapes spaces, commas and quotes', () => {
    const line = toLineProtocol({
      measurement: 'my stack,x',
      tags: { 'bar code': 'a b=c' },
      fields: { firmware: 'V2 "beta"' },
      timestamp: ts,
    });
    expect(line).toBe(
      `my\\ stack\\,x,bar\\ code=a\\ b\\=c firmware="V2 \\"beta\\"" ${ts.getTime()}`,
    );
  });

  it('joins a batch with newlines', () => {
    const p = { measurement: 'm', tags: {}, fields: { a: 1 }, timestamp: ts };
    expect(toLineProtocolBatch([p, p]).split('\n')).toHaveLength(2);
  });
});
