// Self-check of Web/pcg_audio.js, driven the way the page (480-sample pushes) and the audio thread
// (128-sample pulls) drive it. From the project folder: node Tests/pcg_audio_test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, RATE, TARGET, LOW, HIGH, MAX, CAP, FADE } from '../Web/pcg_audio.js';

const Q = 128;
const A = 24000 / 32768; // the user's measured peak at volume 1
const VOL1 = new Float32Array([1]);
const EPS = 1e-6; // float32 rounding of the output

// Sample i plays as (i mod 65536) - 32768, so a full-gain output gives back i mod 65536
const num = (i) => (i & 0xffff) - 32768;
const unnum = (x) => Math.round(x * 32768) + 32768;
const tone = (i) => Math.round(24000 * Math.sin((2 * Math.PI * 200 * i) / RATE));
const dc = (v) => () => v;
const frame = (src, from, len = 480) => Int16Array.from({ length: len }, (_, j) => src(from + j));

let seed = 1;
const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n;

function pushAll(p, src, from, count) {
  for (let i = from; i < from + count; i += 480) p.push(frame(src, i, Math.min(480, from + count - i)));
}

function pull(p, quanta, volume = VOL1) {
  const out = new Float32Array(quanta * Q);
  for (let m = 0; m < quanta; m++) p.pull(out.subarray(m * Q, (m + 1) * Q), volume);
  return out;
}

// Simulated clock: before each 128-sample pull at RATE, push every chunk due by then. Chunk k (samples of src
// from `from` on) is due at k * chunk / (RATE * (1 + ppm / 1e6)) + delay(k) ms, never before chunk k - 1.
function play(p, { seconds, src = null, from = 0, chunk = 480, ppm = 0, delay = () => 0, onFill = () => {} }) {
  const out = new Float32Array(Math.round((seconds * RATE) / Q) * Q);
  const rate = RATE * (1 + ppm / 1e6);
  let k = 0, i = from;
  const due = (prev) => Math.max(prev, (k * chunk) / rate + delay(k) / 1000);
  let at = src ? due(0) : Infinity;
  for (let m = 0; m * Q < out.length; m++) {
    const now = (m * Q) / RATE;
    while (at <= now) {
      p.push(frame(src, i, chunk));
      i += chunk;
      k++;
      at = due(at);
      onFill(now, p.stats.fill);
    }
    p.pull(out.subarray(m * Q, (m + 1) * Q), VOL1);
    onFill(now, p.stats.fill);
  }
  return { out, next: i };
}

function cat(...parts) {
  const out = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of parts) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function maxStep(out, from = 0) {
  let m = 0;
  for (let j = from + 1; j < out.length; j++) m = Math.max(m, Math.abs(out[j] - out[j - 1]));
  return m;
}

// From index `from` on, out[j] must be numbered sample first + j
function expectNumbered(out, from, first) {
  const bad = out.findIndex((x, j) => j >= from && unnum(x) !== ((first + j) & 0xffff));
  assert.equal(bad, -1, `first wrong sample at ${bad}`);
}

test('silent until primed, then fades in with no click when audio starts mid-stream', () => {
  const p = createPlayer();
  pushAll(p, dc(24000), 0, TARGET - 1);
  assert.ok(pull(p, 40).every((x) => x === 0), 'exact zeros with 4799 buffered');
  assert.equal(p.stats.fill, TARGET - 1);
  p.push(frame(dc(24000), 0));
  const out = pull(p, 8);
  assert.ok(out[0] > 0 && out[0] <= A / FADE + EPS, `first output ${out[0]}`);
  assert.ok(maxStep(out) <= A / FADE + EPS, `largest step ${maxStep(out)}`);
  assert.ok(Math.abs(out[FADE - 1] - A) < EPS, 'reaches A within 480 samples');
});

test('a numbered ramp comes out in order at equal rates', () => {
  const p = createPlayer();
  const { out } = play(p, { seconds: 10, src: num });
  const bad = out.findIndex((x, j) => j > RATE && unnum(x) !== ((unnum(out[j - 1]) + 1) & 0xffff));
  assert.equal(bad, -1, `gap or reorder at ${bad}`);
  assert.equal(p.stats.slips, 0);
  assert.equal(p.stats.underruns, 0);
});

for (const ppm of [1000, -1000]) {
  test(`${ppm} ppm drift stays in the band without underruns or big steps`, () => {
    const p = createPlayer();
    let lo = Infinity, hi = -Infinity;
    const onFill = (t, n) => t >= 2 && ((lo = Math.min(lo, n)), (hi = Math.max(hi, n)));
    const { out } = play(p, { seconds: 120, src: tone, ppm, onFill });
    assert.equal(p.stats.underruns, 0);
    // The band +- one frame and one quantum; without correction +1000 ppm would reach 4800 + 120 * 48 = 10 560
    assert.ok(lo >= LOW - 480 - Q && hi <= HIGH + 480 + Q, `fill ${lo}-${hi}`);
    assert.ok(p.stats.slips > 0);
    let toneStep = 0;
    for (let i = 0; i < RATE; i++) toneStep = Math.max(toneStep, Math.abs(tone(i + 1) - tone(i)));
    const step = maxStep(out, 2 * RATE) * 32768;
    assert.ok(step <= 2.05 * toneStep, `largest step ${step} vs the tone's ${toneStep}`);
  });
}

test('frames delayed 0-60 ms at random, in order, never underrun', () => {
  const p = createPlayer();
  seed = 1;
  play(p, { seconds: 120, src: tone, delay: () => rnd(6001) / 100 });
  assert.equal(p.stats.underruns, 0);
});

test('an underrun fades to exact silence, then fades in the new samples only', () => {
  const p = createPlayer();
  const a = play(p, { seconds: 1, src: dc(24000) }).out;
  const b = play(p, { seconds: 1.5 }).out; // pushes stop
  assert.ok(maxStep(cat(a, b)) <= A / FADE + EPS, `largest step ${maxStep(cat(a, b))}`);
  const z = b.indexOf(0);
  assert.ok(z >= 0 && z < RATE / 2, `silent from ${z}`);
  assert.ok(b.length - z >= RATE && b.subarray(z).every((x) => x === 0), 'exact zeros for 1 s, no stale loop');
  assert.equal(p.stats.underruns, 1);
  const c = play(p, { seconds: 1, src: dc(-24000), chunk: 37 }).out;
  assert.ok(maxStep(cat(b, c)) <= A / FADE + EPS, `largest step ${maxStep(cat(b, c))}: old samples spliced on`);
  assert.ok(Math.abs(c.at(-1) + A) < EPS, 'faded in to the new level');
  assert.equal(p.stats.underruns, 1);
});

test('after an underrun, a 1 s burst resumes from its newest 100 ms', () => {
  const p = createPlayer();
  const { next } = play(p, { seconds: 1, src: num });
  play(p, { seconds: 0.5 });
  assert.equal(p.stats.underruns, 1);
  pushAll(p, num, next, RATE);
  const out = pull(p, 10);
  assert.ok(Math.abs(out[0]) <= 1 / FADE + EPS, 'fades in');
  expectNumbered(out, FADE, next + RATE - TARGET);
});

test('a 400 ms burst while playing fades out and re-primes on the newest 100 ms', () => {
  const p = createPlayer();
  const { next } = play(p, { seconds: 1, src: num });
  pushAll(p, num, next, 0.4 * RATE);
  assert.ok(p.stats.fill > MAX);
  const quanta = [];
  while (p.stats.fill > TARGET + Q && quanta.length < 20) quanta.push(pull(p, 1));
  assert.ok(Math.abs(p.stats.fill - TARGET) <= Q, `fill ${p.stats.fill}`);
  assert.equal(quanta.at(-2).at(-1), 0, 'faded out before re-priming');
  const out = cat(quanta.at(-1), pull(p, 9));
  assert.ok(Math.abs(out[0]) <= 1 / FADE + EPS, 'fades in');
  expectNumbered(out, FADE, next + 0.4 * RATE - TARGET);
});

test('holds the newest 1 s when nothing pulls', () => {
  const p = createPlayer();
  pushAll(p, num, 0, 2 * RATE);
  assert.equal(p.stats.fill, CAP);
  expectNumbered(pull(p, 10), FADE, 2 * RATE - TARGET);
});

test('the output never leaves [-1, 1], and volume applies per sample', () => {
  const alt = (i) => (i % 2 ? -32768 : 32767);
  const primed = (src) => {
    const p = createPlayer();
    pushAll(p, src, 0, TARGET);
    return p;
  };
  assert.ok(pull(primed(alt), 10).every((x) => x >= -1 && x <= 1));
  const loud = pull(primed(alt), 10, new Float32Array([8]));
  assert.ok(loud.every((x) => x >= -1 && x <= 1), 'clamped at volume 8');
  assert.ok(loud.some((x) => Math.abs(x) === 1), 'reaches the clamp at volume 8');
  assert.ok(pull(primed(alt), 10, new Float32Array([0])).every((x) => x === 0), 'volume 0 is silent');
  const p = primed(dc(24000));
  pull(p, 4); // past the fade-in
  const ramp = Float32Array.from({ length: Q }, (_, i) => i / (Q - 1));
  const out = pull(p, 1, ramp);
  assert.ok(out.every((x, i) => Math.abs(x - A * ramp[i]) < EPS), 'per-sample volume');
});

test('registers the pcg-player worklet processor', async () => {
  const registered = {};
  const posted = [];
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: (m) => posted.push(m) };
    }
  };
  globalThis.registerProcessor = (name, cls) => (registered[name] = cls);
  try {
    await import('../Web/pcg_audio.js?worklet'); // the query gives a fresh module instance
  } finally {
    delete globalThis.AudioWorkletProcessor;
    delete globalThis.registerProcessor;
  }
  const Proc = registered['pcg-player'];
  assert.ok(Proc, 'registered');
  assert.deepEqual(Proc.parameterDescriptors, [{ name: 'volume', defaultValue: 0.1, minValue: 0, maxValue: 1 }]);
  const node = new Proc();
  node.port.onmessage({ data: frame(dc(24000), 0, TARGET) });
  const out = new Float32Array(Q);
  assert.equal(node.process([], [[out]], { volume: VOL1 }), true);
  assert.ok(out[Q - 1] > 0, 'fills outputs[0][0]');
  for (let m = 1; m < RATE / Q; m++) node.process([], [[new Float32Array(Q)]], { volume: VOL1 });
  assert.equal(posted.length, 1, 'posts stats once per 48 000 samples');
  assert.deepEqual(Object.keys(posted[0]), ['fill', 'underruns', 'slips']);
});
