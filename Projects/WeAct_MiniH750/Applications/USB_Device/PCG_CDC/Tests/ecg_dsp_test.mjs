// Self-check of Web/ecg_dsp.js against synthetic frames built as in Biomedic_ECG_USB_protocol.md §8.
// From the project folder: node Tests/ecg_dsp_test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser, createEcgFilter, FRAME_BYTES, RATE } from '../Web/ecg_dsp.js';

// One frame: blocks 01/02/03 C0, status A1 B1, then V5 I II III big-endian. V5, II and III differ from every
// lead I value used here, so a wrong offset shows. m replaces the C0 marker bytes for the start-up junk.
function frame(leadI, { a1 = 0xc0, b1 = 0x00, m = [0xc0, 0xc0, 0xc0] } = {}) {
  const f = new Uint8Array(FRAME_BYTES);
  const dv = new DataView(f.buffer);
  m.forEach((c, k) => f.set([k + 1, c], 12 * k));
  f.set([a1, b1], 2);
  [0x1234, leadI, 0x2345, 0x3456].forEach((v, k) => dv.setInt16(4 + 2 * k, v));
  return f;
}

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Feeds bytes in chunks of size(k) for the k-th chunk (the whole buffer at once by default)
function run(bytes, size = () => bytes.length) {
  const p = createParser();
  const values = [];
  for (let i = 0, k = 0; i < bytes.length; k++) {
    const n = size(k);
    values.push(...p.push(bytes.subarray(i, i + n)));
    i += n;
  }
  return { values, stats: p.stats };
}

let seed = 1;
const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n;

const LEAD_I = [-32768, -1, 0, 32767, -4488];
const valid = (vals) => cat(...vals.map((v) => frame(v)));
// The module's first blocks: 01 00 / 02 00 / 03 00, then 01 00 with 02 C0 and 03 C0, then a partial frame.
// 25 bytes is the longest partial the marker check rejects: from 26 bytes on, all six markers fit inside it.
const junk = cat(frame(111, { m: [0, 0, 0] }), frame(222, { m: [0, 0xc0, 0xc0] }), frame(333).subarray(0, 25));

test('lead I is the big-endian int16 at offset 6', () => {
  const { values, stats } = run(valid(LEAD_I));
  assert.deepEqual(values, LEAD_I);
  assert.equal(stats.frames, LEAD_I.length);
  assert.equal(stats.skipped, 0);
});

test('gives the same output for any chunking', () => {
  const vals = Array.from({ length: 60 }, (_, k) => k * 977 - 29000);
  const bytes = cat(junk, valid(vals.slice(0, 30)), frame(444).subarray(0, 20), valid(vals.slice(30)));
  const whole = run(bytes);
  assert.deepEqual(whole.values, vals);
  for (const size of [() => 1, (k) => [39, 40, 41][k % 3], () => rnd(200) + 1]) {
    const { values, stats } = run(bytes, size);
    assert.deepEqual(values, whole.values);
    assert.deepEqual(stats, whole.stats);
  }
});

test('skips the start-up junk and emits the first valid frame first', () => {
  const { values, stats } = run(cat(junk, valid(LEAD_I)));
  assert.deepEqual(values, LEAD_I);
  assert.equal(stats.skipped, junk.length);
  assert.equal(stats.frames, LEAD_I.length);
});

test('re-syncs after random bytes and after a cut frame', () => {
  const garbage = Uint8Array.from({ length: 333 }, () => rnd(256));
  for (const inserted of [garbage, frame(555).subarray(0, 20)]) {
    const { values, stats } = run(cat(valid(LEAD_I.slice(0, 2)), inserted, valid(LEAD_I.slice(2))));
    assert.deepEqual(values, LEAD_I);
    assert.equal(stats.skipped, inserted.length);
  }
});

test('electrode-off flags of the last frame: RA from B1 & 0x60, LA from A1 & 0x20, LL ignored', () => {
  const p = createParser();
  const flags = (a1, b1) => {
    assert.equal(p.push(frame(0, { a1, b1 })).length, 1);
    return { raOff: p.stats.raOff, laOff: p.stats.laOff };
  };
  assert.deepEqual(flags(0xc0, 0x00), { raOff: false, laOff: false }); // the real device: LL off, RA and LA on
  assert.deepEqual(flags(0x20, 0x00), { raOff: false, laOff: true });
  assert.deepEqual(flags(0xe0, 0x00), { raOff: false, laOff: true });
  assert.deepEqual(flags(0xc0, 0x20), { raOff: true, laOff: false });
  assert.deepEqual(flags(0xc0, 0x40), { raOff: true, laOff: false });
  assert.deepEqual(flags(0xe0, 0x60), { raOff: true, laOff: true });
  assert.deepEqual(flags(0xc0, 0x00), { raOff: false, laOff: false });
});

// RMS gain over the last 10 s of a 30 s sine of amplitude 1000: at 150 Hz the samples fall on only 10 phases
function gainDb(hz) {
  const f = createEcgFilter();
  let sx = 0, sy = 0;
  for (let k = 0; k < 30 * RATE; k++) {
    const x = 1000 * Math.sin((2 * Math.PI * hz * k) / RATE);
    const y = f(x);
    if (k >= 20 * RATE) [sx, sy] = [sx + x * x, sy + y * y];
  }
  return 10 * Math.log10(sy / sx);
}

test('frequency response: 0.5-150 Hz band-pass and 50 Hz notch', () => {
  const g = Object.fromEntries([0.5, 10, 48, 50, 52, 150].map((hz) => [hz, gainDb(hz)]));
  assert.ok(Math.abs(g[10]) <= 0.1, `10 Hz ${g[10]} dB`);
  assert.ok(Math.abs(g[0.5] + 3.01) <= 0.1, `0.5 Hz ${g[0.5]} dB`);
  assert.ok(Math.abs(g[150] + 3.01) <= 0.1, `150 Hz ${g[150]} dB`);
  assert.ok(g[50] < -40, `50 Hz ${g[50]} dB`);
  assert.ok(g[48] > -1, `48 Hz ${g[48]} dB`);
  assert.ok(g[52] > -1, `52 Hz ${g[52]} dB`);
});

test('a constant gives exact zeros, and a step settles', () => {
  const f = createEcgFilter();
  const flat = Array.from({ length: 10 * RATE }, () => f(3000));
  assert.equal(flat.filter((y) => y !== 0).length, 0); // !== so that -0 counts as 0
  const g = createEcgFilter();
  const step = Array.from({ length: 10 * RATE }, (_, k) => g(k < RATE ? 3000 : 3100));
  const worst = Math.max(...step.slice(4 * RATE).map(Math.abs));
  assert.ok(worst <= 1, `${worst} counts from 4 s on`);
});
