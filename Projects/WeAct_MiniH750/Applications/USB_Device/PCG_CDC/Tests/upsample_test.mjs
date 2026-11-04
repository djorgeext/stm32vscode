// Self-check of Web/upsample.js, at L = 2 (ECG) and L = 48 (audio).
// From the project folder: node Tests/upsample_test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpsampler } from '../Web/upsample.js';

function upsample(xs, L) {
  const up = createUpsampler(L);
  return xs.flatMap((x) => up(x));
}

test('count: N inputs give 2N - 1 outputs at L = 2 and 1 + 48(N - 1) at L = 48', () => {
  for (const N of [1, 2, 3, 1000]) {
    const xs = Array.from({ length: N }, (_, m) => m);
    assert.equal(upsample(xs, 2).length, 2 * N - 1);
    assert.equal(upsample(xs, 48).length, 1 + 48 * (N - 1));
  }
});

test('fixed map at L = 2: y[2m] is x[m] and y[2m+1] is the midpoint', () => {
  // Integer counts, so the midpoint is exact; the 40 Hz test covers originals that are not
  const xs = Array.from({ length: 500 }, (_, m) => ((m * 7919) % 65535) - 32767);
  const y = upsample(xs, 2);
  xs.forEach((x, m) => {
    assert.equal(y[2 * m], x);
    if (m + 1 < xs.length) assert.equal(y[2 * m + 1], (x + xs[m + 1]) / 2);
  });
});

test('a constant stays exact and a ramp stays a ramp', () => {
  for (const L of [2, 48]) assert.ok(upsample(Array(100).fill(0.1), L).every((v) => v === 0.1));
  const a = -1234.5, b = 0.37;
  const y = upsample(Array.from({ length: 1000 }, (_, m) => a + b * m), 2);
  y.forEach((v, j) => assert.ok(Math.abs(v - (a + (b * j) / 2)) <= 1e-9, `j ${j}`));
});

test('40 Hz at 500 Hz against the true sine: midpoints about 3 % low, originals exact', () => {
  // Input and reference share one expression, so an even j can be exact
  const sine = (ms) => Math.sin((2 * Math.PI * 40 * ms) / 1000);
  const y = upsample(Array.from({ length: 5000 }, (_, m) => sine(2 * m)), 2);
  let max = 0, sum = 0;
  y.forEach((v, j) => {
    const e = Math.abs(v - sine(j));
    if (j % 2 === 0) assert.equal(e, 0, `j ${j}`);
    max = Math.max(max, e);
    sum += e * e;
  });
  assert.ok(max >= 0.03 && max <= 0.0315, `largest error ${max}`);
  assert.ok(Math.sqrt(sum / y.length) <= 0.016, `RMS ${Math.sqrt(sum / y.length)}`);
});

test('audio use: 10-sample frames at L = 48 give 480 outputs per frame after the first', () => {
  const up = createUpsampler(48);
  const frame = (k) => Int16Array.from({ length: 10 }, (_, j) => 100 * k + j);
  const sizes = Array.from({ length: 5 }, (_, k) => Array.from(frame(k)).flatMap((v) => up(v)).length);
  assert.deepEqual(sizes, [1 + 9 * 48, 480, 480, 480, 480]);
});
