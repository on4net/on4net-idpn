import { describe, expect, it } from 'vitest';

import { rewrapTarget, type RewrapTarget } from '../../scripts/ops/rewrap-secrets.js';
import { createKeyringSecretBox, createSecretBox } from './secret-box.js';

const oldKey = Buffer.alloc(32, 7);
const newKey = Buffer.alloc(32, 9);
const box = createKeyringSecretBox({
  current: { id: 2, key: newKey },
  previous: [{ id: 1, key: oldKey }],
});

function memoryTarget(initial: Record<string, Buffer>): {
  target: RewrapTarget;
  rows: Map<string, Buffer>;
} {
  const rows = new Map(Object.entries(initial));
  const target: RewrapTarget = {
    name: 'memory',
    box,
    list: async (after, take) =>
      [...rows.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .filter(([id]) => after === null || id > after)
        .slice(0, take)
        .map(([id, envelope]) => ({ id, envelope })),
    write: async (id, envelope) => {
      rows.set(id, envelope);
    },
  };
  return { target, rows };
}

describe('rewrapTarget', () => {
  it('moves v1 and previous-key envelopes to the current key and leaves current ones alone', async () => {
    const current = box.encrypt('c');
    const { target, rows } = memoryTarget({
      a: createSecretBox(oldKey).encrypt('a'),
      b: createKeyringSecretBox({ current: { id: 1, key: oldKey }, previous: [] }).encrypt('b'),
      c: current,
    });

    const summary = await rewrapTarget(target, false);

    expect(summary).toEqual({ name: 'memory', scanned: 3, rewrapped: 2, failed: 0 });
    for (const [id, expected] of [
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'c'],
    ] as const) {
      const envelope = rows.get(id) ?? Buffer.alloc(0);
      expect(box.needsRewrap(envelope)).toBe(false);
      expect(box.decrypt(envelope)).toBe(expected);
    }
    expect(rows.get('c')).toBe(current);
    // A second run is a no-op.
    expect((await rewrapTarget(target, false)).rewrapped).toBe(0);
  });

  it('counts but does not write in a dry run, and reports envelopes no key opens', async () => {
    const stranger = createKeyringSecretBox({
      current: { id: 5, key: Buffer.alloc(32, 1) },
      previous: [],
    }).encrypt('x');
    const legacy = createSecretBox(oldKey).encrypt('y');
    const { target, rows } = memoryTarget({ a: legacy, z: stranger });

    const summary = await rewrapTarget(target, true);

    expect(summary).toMatchObject({ scanned: 2, rewrapped: 1, failed: 1 });
    expect(rows.get('a')).toBe(legacy);
  });
});
