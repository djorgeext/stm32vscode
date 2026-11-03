// Self-check of Web/ecg_dsp.js against synthetic frames built as in Biomedic_ECG_USB_protocol.md §8.
// From the project folder: node Tests/ecg_dsp_test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser, createEcgFilter, electrodeLine, FRAME_BYTES, RATE } from '../Web/ecg_dsp.js';

// One frame: blocks 01/02/03 C0, status A1 B1, then V5 I II III big-endian. Lead II defaults to ~leadI, which is never
// leadI and stays inside int16 (~-32768 = 32767), so a swapped or wrong offset shows. m replaces the C0 marker bytes
// for the start-up junk.
function frame(leadI, { leadII = ~leadI, a1 = 0xc0, b1 = 0x00, m = [0xc0, 0xc0, 0xc0] } = {}) {
  const f = new Uint8Array(FRAME_BYTES);
  const dv = new DataView(f.buffer);
  m.forEach((c, k) => f.set([k + 1, c], 12 * k));
  f.set([a1, b1], 2);
  [0x1234, leadI, leadII, 0x3456].forEach((v, k) => dv.setInt16(4 + 2 * k, v));
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
const pairs = (vals) => vals.map((v) => [v, ~v]);
const valid = (vals) => cat(...vals.map((v) => frame(v)));
// The module's first blocks: 01 00 / 02 00 / 03 00, then 01 00 with 02 C0 and 03 C0, then a partial frame.
// 25 bytes is the longest partial the marker check rejects: from 26 bytes on, all six markers fit inside it.
const junk = cat(frame(111, { m: [0, 0, 0] }), frame(222, { m: [0, 0xc0, 0xc0] }), frame(333).subarray(0, 25));

test('leads I and II are the big-endian int16 at offsets 6 and 8', () => {
  const { values, stats } = run(valid(LEAD_I));
  assert.deepEqual(values, pairs(LEAD_I));
  assert.equal(stats.frames, LEAD_I.length);
  assert.equal(stats.skipped, 0);
});

test('gives the same output for any chunking', () => {
  const vals = Array.from({ length: 60 }, (_, k) => k * 977 - 29000);
  const bytes = cat(junk, valid(vals.slice(0, 30)), frame(444).subarray(0, 20), valid(vals.slice(30)));
  const whole = run(bytes);
  assert.deepEqual(whole.values, pairs(vals));
  for (const size of [() => 1, (k) => [39, 40, 41][k % 3], () => rnd(200) + 1]) {
    const { values, stats } = run(bytes, size);
    assert.deepEqual(values, whole.values);
    assert.deepEqual(stats, whole.stats);
  }
});

test('skips the start-up junk and emits the first valid frame first', () => {
  const { values, stats } = run(cat(junk, valid(LEAD_I)));
  assert.deepEqual(values, pairs(LEAD_I));
  assert.equal(stats.skipped, junk.length);
  assert.equal(stats.frames, LEAD_I.length);
});

test('re-syncs after random bytes and after a cut frame', () => {
  const garbage = Uint8Array.from({ length: 333 }, () => rnd(256));
  for (const inserted of [garbage, frame(555).subarray(0, 20)]) {
    const { values, stats } = run(cat(valid(LEAD_I.slice(0, 2)), inserted, valid(LEAD_I.slice(2))));
    assert.deepEqual(values, pairs(LEAD_I));
    assert.equal(stats.skipped, inserted.length);
  }
});

test('electrode-off flags of the last frame: RA from B1 & 0x60, LA from A1 & 0x20, LL from A1 & 0xC0', () => {
  const p = createParser();
  const flags = (a1, b1) => {
    assert.equal(p.push(frame(0, { a1, b1 })).length, 1);
    return { raOff: p.stats.raOff, laOff: p.stats.laOff, llOff: p.stats.llOff };
  };
  assert.deepEqual(flags(0xc0, 0x00), { raOff: false, laOff: false, llOff: true }); // the real module without LL (E1)
  assert.deepEqual(flags(0x40, 0x00), { raOff: false, laOff: false, llOff: true });
  assert.deepEqual(flags(0x80, 0x00), { raOff: false, laOff: false, llOff: true });
  assert.deepEqual(flags(0x20, 0x00), { raOff: false, laOff: true, llOff: false });
  assert.deepEqual(flags(0x10, 0x00), { raOff: false, laOff: false, llOff: false }); // the V5 bit is not a lead I/II flag
  assert.deepEqual(flags(0xe0, 0x00), { raOff: false, laOff: true, llOff: true });
  assert.deepEqual(flags(0xc0, 0x20), { raOff: true, laOff: false, llOff: true });
  assert.deepEqual(flags(0x00, 0x40), { raOff: true, laOff: false, llOff: false });
  assert.deepEqual(flags(0xe0, 0x60), { raOff: true, laOff: true, llOff: true });
  assert.deepEqual(flags(0x00, 0x00), { raOff: false, laOff: false, llOff: false }); // all on
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

// A forward-backward chain gives about twice these dB values (-29 dB at 0.5 Hz), so the zero-phase passes cannot come back
test('frequency response of one forward pass through the §12 chain', () => {
  const near = { 0.3: [-33.55, 0.1], 0.5: [-14.52, 0.1], 0.7: [-4.44, 0.05], 1: [-0.43, 0.05], 10: [-0.18, 0.05],
    25: [-1.15, 0.05], 40: [-3.22, 0.05], 46: [-5.12, 0.05], 54: [-7.07, 0.05], 150: [-40.24, 0.2] };
  for (const [hz, [db, tol]] of Object.entries(near)) {
    const g = gainDb(Number(hz));
    assert.ok(Math.abs(g - db) <= tol, `${hz} Hz ${g} dB, expected ${db} ± ${tol}`);
  }
  for (const [hz, below] of [[50, -38], [100, -60]]) {
    const g = gainDb(hz);
    assert.ok(g < below, `${hz} Hz ${g} dB, expected below ${below}`);
  }
});

test('a constant gives exact zeros, a ramp and a step settle', () => {
  const run10s = (x) => {
    const f = createEcgFilter();
    return Array.from({ length: 10 * RATE }, (_, k) => f(x(k)));
  };
  const worstFrom = (y, s) => Math.max(...y.slice(s * RATE).map(Math.abs));
  assert.equal(run10s(() => 3000).filter((y) => y !== 0).length, 0); // !== so that -0 counts as 0
  const ramp = worstFrom(run10s((k) => 3000 + 0.7 * k), 3);
  assert.ok(ramp <= 0.5, `ramp ${ramp} counts from 3 s on`);
  const step = worstFrom(run10s((k) => (k < RATE ? 3000 : 3100)), 4);
  assert.ok(step <= 1, `step ${step} counts from 4 s on`);
});

test('no display delay: each QRS comes out 10 ms late, with wander and hum removed', () => {
  const g = (d, s) => Math.exp(-(d * d) / (2 * s * s));
  const f = createEcgFilter();
  const y = Array.from({ length: 40 * RATE }, (_, k) => {
    const t = k / RATE;
    const d = t - 0.3 - 0.85 * Math.round((t - 0.3) / 0.85);
    const beat = 40 * g(d, 0.012) - 8 * g(d - 0.03, 0.01) + 10 * g(d - 0.28, 0.05);
    return f(beat + 30 * Math.sin(2 * Math.PI * 0.3 * t) + 10 * Math.sin(2 * Math.PI * 50 * t));
  });
  let beats = 0;
  for (let i = 0; ; i++) {
    const c = Math.round((0.3 + 0.85 * i) * RATE);
    if (c > 39 * RATE) break;
    if (c < 10 * RATE) continue;
    let m = c - 20;
    for (let k = c - 20; k <= c + 30; k++) if (y[k] > y[m]) m = k;
    assert.ok(m - c >= 0 && m - c <= 8, `beat at ${c}: peak ${m - c} samples late`);
    assert.ok(y[m] >= 28 && y[m] <= 36, `beat at ${c}: peak ${y[m]} counts`);
    beats++;
  }
  assert.ok(beats >= 30, `${beats} beats checked`);
});

test('electrode line names the invalid leads', () => {
  const texts = [
    [false, false, false, 'RA, LA and LL electrodes on.'],
    [false, true, false, 'Lead I not valid: LA electrode off.'],
    [false, false, true, 'Lead II not valid: LL electrode off.'],
    [true, false, false, 'Leads I and II not valid: RA electrode off.'],
    [false, true, true, 'Leads I and II not valid: LA and LL electrodes off.'],
    [true, true, false, 'Leads I and II not valid: RA and LA electrodes off.'],
    [true, false, true, 'Leads I and II not valid: RA and LL electrodes off.'],
    [true, true, true, 'Leads I and II not valid: RA, LA and LL electrodes off.'],
  ];
  for (const [raOff, laOff, llOff, text] of texts) assert.equal(electrodeLine({ raOff, laOff, llOff }), text);
  const p = createParser();
  p.push(frame(0));
  assert.equal(electrodeLine(p.stats), 'Lead II not valid: LL electrode off.');
});
