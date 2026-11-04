// Self-check of Web/pcg_parser.js against frames built the way Src/main.c sends them.
// From the project folder: node Tests/pcg_parser_test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser, FRAME_BYTES, SAMPLES_PER_FRAME } from '../Web/pcg_parser.js';

// Sample j of frame seq: depends on seq so each frame is recognisable, and covers both clamp limits
const tagged = (seq, j) => (j === 0 ? -32767 : j === 1 ? 32767 : ((seq * 131 + j * 977) % 65535) - 32767);

function frame(seq, fill = tagged) {
  const f = new Uint8Array(FRAME_BYTES);
  const dv = new DataView(f.buffer);
  dv.setInt16(0, -32768, true);
  dv.setUint16(2, seq, true);
  for (let j = 0; j < SAMPLES_PER_FRAME; j++) dv.setInt16(4 + 2 * j, fill(seq, j), true);
  return f;
}

// The parser emits a frame once the next frame's sync and seq arrive
const head = (seq) => frame(seq).subarray(0, 4);

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
  const frames = [];
  for (let i = 0, k = 0; i < bytes.length; k++) {
    const n = size(k);
    frames.push(...p.push(bytes.subarray(i, i + n)));
    i += n;
  }
  return { frames, stats: p.stats };
}

function expectFrames(frames, seqs, fill = tagged) {
  assert.equal(frames.length, seqs.length, 'frame count');
  seqs.forEach((seq, k) =>
    assert.deepEqual(Array.from(frames[k]), Array.from({ length: SAMPLES_PER_FRAME }, (_, j) => fill(seq, j)), `frame ${k} (seq ${seq})`));
}

const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

let seed = 1;
const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n;

test('locks after a partial first frame', () => {
  const { frames, stats } = run(cat(frame(0).subarray(FRAME_BYTES - 14), frame(1), frame(2), frame(3), head(4)));
  expectFrames(frames, [1, 2, 3]);
  assert.equal(stats.drops, 0);
});

test('a single sync does not lock: the next one must follow 24 bytes later', () => {
  const p = createParser();
  assert.equal(p.push(frame(5)).length, 0);
  assert.equal(p.push(new Uint8Array([0x12, 0x34, 0x56, 0x78])).length, 0);
  const q = createParser();
  assert.equal(q.push(frame(5)).length, 0);
  expectFrames(q.push(head(6)), [5]);
});

test('gives the same frames for any chunking', () => {
  const bytes = cat(frame(0).subarray(7), ...range(1, 30).map((s) => frame(s)), head(30));
  const sizings = [() => 1, (k) => [23, 24, 25][k % 3], () => rnd(51), () => rnd(64) + 1, (k) => (k % 2 ? 2 : 1)];
  for (const size of sizings) {
    const { frames, stats } = run(bytes, size);
    expectFrames(frames, range(1, 30));
    assert.equal(stats.drops, 0);
  }
});

test('re-syncs after injected garbage', () => {
  const garbage = Uint8Array.from({ length: 333 }, () => rnd(256));
  garbage.set([0x00, 0x80, 0x05, 0x00], 40); // look-alike syncs inside the garbage
  garbage.set([0x00, 0x80, 0x07, 0x00], 200);
  const { frames, stats } = run(cat(frame(0), frame(1), frame(2), garbage, frame(3), frame(4), frame(5), head(6)));
  // Frame 2 is intact, but no sync follows it, so it cannot be verified and counts as dropped
  expectFrames(frames, [0, 1, 3, 4, 5]);
  assert.equal(stats.drops, 1);
});

test('drops a truncated frame instead of emitting a mixed one', () => {
  const { frames, stats } = run(cat(frame(0), frame(1), frame(2).subarray(0, 12), frame(3), frame(4), head(5)));
  expectFrames(frames, [0, 1, 3, 4]);
  assert.equal(stats.drops, 1);
});

// Samples 4 and 5 are 0x0012 and 0x0580, so the bytes 12 00 80 05 hold a 00 80 pair across them,
// and sample 6 = 3 makes the fake seq high byte valid too
const fake = (j, other) => (j === 4 ? 0x0012 : j === 5 ? 0x0580 : j === 6 ? 3 : other);

test('a 00 80 pair across two samples in one frame does not lock', () => {
  const fill = (seq, j) => fake(j, tagged(seq, j));
  // The fragment starts before the fake pair, so the search meets it first
  const { frames, stats } = run(cat(frame(0, fill).subarray(8), frame(1), frame(2), head(3)));
  expectFrames(frames, [1, 2]);
  assert.equal(stats.drops, 0);
});

test('a 00 80 pair across two samples repeated in every frame does not lock', () => {
  // Identical samples in every frame: the fake sync recurs 24 bytes later with the same fake seq
  const fill = (seq, j) => fake(j, j * 37 - 9000);
  const f = (s) => frame(s, fill);
  const { frames, stats } = run(cat(f(0).subarray(8), f(1), f(2), f(3), f(4).subarray(0, 4)));
  expectFrames(frames, [1, 2, 3], fill);
  assert.equal(stats.drops, 0);
});

test('seq wrap 32767 -> 0 is not a drop', () => {
  const { frames, stats } = run(cat(frame(32765), frame(32766), frame(32767), frame(0), frame(1), head(2)));
  expectFrames(frames, [32765, 32766, 32767, 0, 1]);
  assert.equal(stats.drops, 0);
});

test('counts real drops, across the wrap too', () => {
  const seqs = [32766, 32767, 1, 2, 4, 7];
  const { frames, stats } = run(cat(...seqs.map((s) => frame(s)), head(8)));
  expectFrames(frames, seqs);
  assert.equal(stats.drops, 1 + 1 + 2);
});

test('ignores the gap after the stale frame queued while the port was closed', () => {
  const { frames, stats } = run(cat(frame(500), frame(9000), frame(9001), frame(9003), head(9004)));
  expectFrames(frames, [500, 9000, 9001, 9003]);
  assert.equal(stats.drops, 1);
});
