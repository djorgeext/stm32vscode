// Self-check of Web/recorder.js, on synthetic data only: a recording of a person never goes into a test or a fixture.
// From the project folder: node Tests/recorder_test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PCG, ECG, EVENT, ECG_1K, HEADER_BYTES, SEGMENT_BYTES, ECG_PORT, PCG_PORT, ALIGN_NOTE,
  record, createLog, createEcgChain, leadIILine, findPorts, startSession,
} from '../Web/recorder.js';
import { createEcgFilter, createParser as createEcgParser, START, STOP, KEEP_ALIVE } from '../Web/ecg_dsp.js';
import { createParser as createPcgParser } from '../Web/pcg_parser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what = 'condition') {
  for (let i = 0; i < 5000 && !cond(); i++) await sleep(1);
  assert.ok(cond(), `timed out waiting for ${what}`);
}

let seed = 1;
const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n;

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// One 40-byte frame as in Biomedic_ECG_USB_protocol.md §8: blocks 01/02/03 C0, status A1 B1, then V5 I II III big-endian
function ecgFrame(leadII, leadI = 0, a1 = 0, b1 = 0) {
  const f = new Uint8Array(40);
  const dv = new DataView(f.buffer);
  [1, 2, 3].forEach((n, k) => f.set([n, 0xc0], 12 * k));
  f.set([a1, b1], 2);
  [0x1234, leadI, leadII, 0x3456].forEach((v, k) => dv.setInt16(4 + 2 * k, v));
  return f;
}
const leadII = (m) => Math.round(3000 * Math.sin(m / 7));
const ecgFrames = (from, n) => cat(...Array.from({ length: n }, (_, k) => ecgFrame(leadII(from + k))));

// One 24-byte frame as Src/main.c sends it
function pcgFrame(seq) {
  const f = new Uint8Array(24);
  const dv = new DataView(f.buffer);
  dv.setInt16(0, -32768, true);
  dv.setUint16(2, seq, true);
  for (let j = 0; j < 10; j++) dv.setInt16(4 + 2 * j, seq * 3 + j, true);
  return f;
}

function parseRecords(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    const n = dv.getUint32(i + 8, true);
    assert.ok(i + HEADER_BYTES + n <= bytes.length, 'a record runs past the end of its file');
    out.push({ t: dv.getFloat64(i, true), kind: bytes[i + 12], payload: bytes.subarray(i + HEADER_BYTES, i + HEADER_BYTES + n) });
    i += HEADER_BYTES + n;
  }
  return out;
}

// failures: how many saves reject first
function memoryLog(failures = 0) {
  const files = [];
  const log = createLog(async (index, blob) => {
    if (failures-- > 0) throw new Error('disk full');
    files.push({ index, bytes: new Uint8Array(await blob.arrayBuffer()) });
  });
  return { log, files, records: () => files.flatMap((f) => parseRecords(f.bytes)) };
}

const eventsOf = (records) => records.filter((r) => r.kind === EVENT).map((r) => JSON.parse(new TextDecoder().decode(r.payload)));
const payloadOf = (records, kind) => cat(...records.filter((r) => r.kind === kind).map((r) => r.payload));

// Built on web streams, so locks, queues and errors behave as they do on a real SerialPort
function fakePort(name, ops, info = {}) {
  const port = { writes: [], closed: 0, getInfo: () => info };
  let rc, wc;
  const readable = () => new ReadableStream({ start: (c) => { rc = c; }, cancel: () => { ops.push(`${name} cancel`); } });
  port.readable = readable();
  port.writable = new WritableStream({
    start: (c) => { wc = c; },
    write: (b) => { ops.push(`${name} write`); port.writes.push(Array.from(b)); },
    close: () => { ops.push(`${name} writable.close`); },
  });
  port.close = async () => {
    if (port.readable?.locked) throw new TypeError('locked');
    port.closed++;
  };
  port.feed = (bytes) => rc.enqueue(bytes);
  // Like an overrun: this stream errors, which drops what is queued in it, and the port offers a new one
  port.overrun = (message) => { rc.error(new Error(message)); port.readable = readable(); };
  // Like an unplug: both streams error and both attributes become null
  port.lose = (message) => { const e = new Error(message); rc.error(e); wc.error(e); port.readable = port.writable = null; };
  return port;
}

function session(failures) {
  const ops = [];
  const ecg = fakePort('ecg', ops), pcg = fakePort('pcg', ops);
  const mem = memoryLog(failures);
  const h = { ops, ecg, pcg, ...mem, clock: 0, ecgSeen: [], pcgSeen: [], lost: [] };
  h.s = startSession({
    ecgPort: ecg, pcgPort: pcg, log: mem.log, now: () => h.clock,
    onPcg: (frames) => h.pcgSeen.push(...frames), onEcg: (y) => h.ecgSeen.push(...y), onLost: (...a) => h.lost.push(a),
  });
  h.startDone = () => until(() => ecg.writes.length === 5, 'START');
  return h;
}

const commandBytes = (steps) => steps.filter((s) => typeof s !== 'number');

test('record layout: f64 at 0, u32 at 8, u8 at 12, payload at 13, little-endian', () => {
  assert.equal(HEADER_BYTES, 13);
  const r = record(ECG, 1234.5, Uint8Array.of(9, 8, 7));
  assert.deepEqual(Array.from(r), [0, 0, 0, 0, 0, 0x4a, 0x93, 0x40, 3, 0, 0, 0, ECG, 9, 8, 7]);
});

test('segments end on a record boundary, a group is never split, and they are saved one at a time, in order', async () => {
  const files = [];
  let active = 0, most = 0;
  const log = createLog(async (index, blob) => {
    most = Math.max(most, ++active);
    await sleep(5);
    files.push({ index, bytes: new Uint8Array(await blob.arrayBuffer()) });
    active--;
  });
  const expected = [];
  for (let t = 0; t < 400; t++) {
    const raw = new Uint8Array(rnd(5000) + 1).fill(t), y = new Uint8Array(rnd(3000)).fill(255 - (t & 127));
    log.add(t, [ECG, raw], [ECG_1K, y]);
    expected.push(record(ECG, t, raw), record(ECG_1K, t, y));
    if (t % 50 === 0) await new Promise(setImmediate); // saves are still running when the next roll comes, as in a live session
  }
  assert.equal(await log.flush(), true);
  assert.ok(files.length >= 3, `${files.length} files`);
  assert.equal(most, 1, 'two saves ran at once');
  assert.deepEqual(files.map((f) => f.index), files.map((_, k) => k + 1));
  files.slice(0, -1).forEach((f) => assert.ok(f.bytes.length >= SEGMENT_BYTES, 'a file rolled early'));
  for (const f of files) {
    const kinds = parseRecords(f.bytes).map((r) => r.kind);
    assert.ok(kinds.length % 2 === 0 && kinds.every((k, i) => k === (i % 2 ? ECG_1K : ECG)), `file ${f.index} splits a group`);
  }
  assert.deepEqual(cat(...files.map((f) => f.bytes)), cat(...expected));
  assert.deepEqual(log.stats, { saved: files.length, unsaved: 0, error: '' });
});

test('a failed save stays first in line and nothing is lost or reordered', async () => {
  // rolls = 1 is the plan's "rejects twice": once at the roll, once at the flush. rolls = 2 retries at the next roll as well
  for (const rolls of [1, 2]) {
    const { log, files } = memoryLog(rolls + 1);
    const expected = [];
    for (let k = 0; k < rolls; k++) {
      const chunk = new Uint8Array(SEGMENT_BYTES).fill(k + 1);
      log.add(k, [PCG, chunk]);
      expected.push(record(PCG, k, chunk));
      await until(() => log.stats.error, 'the failed save');
      await sleep(1);
    }
    assert.match(log.stats.error, /disk full/);
    assert.equal(log.stats.unsaved, rolls);
    log.event(9, { e: 'stop' });
    assert.equal(await log.flush(), false);
    assert.match(log.stats.error, /disk full/);
    assert.equal(files.length, 0);
    assert.equal(await log.flush(), true);
    assert.equal(log.stats.error, '');
    assert.equal(log.stats.unsaved, 0);
    assert.equal(log.stats.saved, rolls + 1);
    assert.deepEqual(files.map((f) => f.index), Array.from({ length: rolls + 1 }, (_, k) => k + 1));
    assert.deepEqual(files.slice(0, rolls).map((f) => f.bytes), expected);

    assert.equal(await log.flush(), true); // nothing to do, and the log must still work after it
    log.event(10, { e: 'stop' });
    assert.equal(await log.flush(), true);
    assert.equal(files.length, rolls + 2);
  }
});

test('createEcgChain gives one output for any chunking', () => {
  const F = 1500, cut = 700, junk = cat(new Uint8Array(40).fill(0x11), ecgFrame(5).subarray(0, 25));
  const left = 23; // 17 bytes of frame `cut` are lost, so the 23 left are skipped and the frame is gone
  const stream = cat(junk, ecgFrames(0, cut), ecgFrames(cut, 1).subarray(0, left), ecgFrames(cut + 1, F - cut));
  const ii = Array.from({ length: F + 1 }, (_, m) => leadII(m)).filter((_, m) => m !== cut);
  const f = createEcgFilter();
  const kept = ii.map((v) => Math.fround(f(v)));

  const sizings = [() => 1, () => 41, () => rnd(97) + 1, () => stream.length];
  let sample = null;
  for (const size of sizings) {
    const chain = createEcgChain();
    const y = [];
    for (let i = 0; i < stream.length; ) {
      const n = size();
      y.push(...chain.push(stream.subarray(i, i + n)));
      i += n;
    }
    sample ??= y;
    assert.deepEqual(y, sample);
    assert.equal(y.length, 2 * F - 1);
    assert.deepEqual(y.filter((_, j) => j % 2 === 0), kept);
    assert.equal(chain.stats.frames, F);
    assert.equal(chain.stats.skippedAfterLock, left);
    assert.equal(chain.stats.skipped, junk.length + left);
  }
});

test('leadIILine gives the four texts, and LA changes nothing', () => {
  for (const laOff of [false, true]) {
    assert.equal(leadIILine({ raOff: false, laOff, llOff: false }), 'RA and LL electrodes on.');
    assert.equal(leadIILine({ raOff: true, laOff, llOff: false }), 'Lead II not valid: RA electrode off.');
    assert.equal(leadIILine({ raOff: false, laOff, llOff: true }), 'Lead II not valid: LL electrode off.');
    assert.equal(leadIILine({ raOff: true, laOff, llOff: true }), 'Lead II not valid: RA and LL electrodes off.');
  }
});

test('findPorts finds each device in either order, ignores others, and gives null when absent', () => {
  const dev = (info) => ({ getInfo: () => info });
  const e = dev(ECG_PORT), p = dev(PCG_PORT), other = dev({ usbVendorId: 0x1234, usbProductId: 0x00df }), noUsb = dev({});
  for (const list of [[e, p], [p, e], [other, e, noUsb, p]]) {
    const found = findPorts(list);
    assert.equal(found.ecg, e);
    assert.equal(found.pcg, p);
  }
  assert.deepEqual(findPorts([p, other]), { ecg: null, pcg: p });
  assert.deepEqual(findPorts([]), { ecg: null, pcg: null });
});

test('normal session: START, STOP, the writable closes, then the readers are cancelled, and nothing is lost', async () => {
  // failures = 1: the final save fails, stop() says so, and everything is still there for the retry
  for (const failures of [0, 1]) {
    const h = session(failures);
    const { ecg, pcg, log, records } = h;
    h.clock = 5000;
    const before = [pcgFrame(1), pcgFrame(2), ecgFrames(0, 4)];
    pcg.feed(before[0]);
    pcg.feed(before[1]);
    ecg.feed(before[2]);
    await until(() => h.ecgSeen.length === 7, 'the first ECG samples');
    assert.equal(h.pcgSeen.length, 1, 'frame 1 completes when the sync of frame 2 arrives');
    await h.startDone();

    h.clock = 6000;
    const stopping = h.s.stop();
    await until(() => ecg.writes.length === 6, 'the first stop byte');
    const during = [pcgFrame(3), ecgFrames(4, 2)];
    pcg.feed(during[0]);
    ecg.feed(during[1]);
    await until(() => h.ecgSeen.length === 11 && h.pcgSeen.length === 2, 'the chunks fed during the stop');
    h.clock = 7000;
    const saved = await stopping;

    assert.equal(saved, failures === 0);
    assert.equal(await h.s.done, saved);
    assert.deepEqual(Object.keys(h.s).sort(), ['done', 'ecgStats', 'pcgStats', 'stop']);
    assert.deepEqual([h.s.ecgStats.frames, h.s.ecgStats.skippedAfterLock, h.s.pcgStats.frames, h.s.pcgStats.drops], [6, 0, 2, 0]);
    if (!saved) {
      assert.match(log.stats.error, /disk full/);
      assert.equal(h.files.length, 0);
      assert.equal(await log.flush(), true);
    }
    assert.deepEqual(ecg.writes, [...commandBytes(START), ...commandBytes(STOP)]);
    assert.deepEqual(pcg.writes, []);
    assert.deepEqual(h.ops.slice(-3), ['ecg writable.close', 'ecg cancel', 'pcg cancel']);
    assert.deepEqual([ecg.closed, pcg.closed], [1, 1]);

    const all = records();
    assert.deepEqual(payloadOf(all, PCG), cat(before[0], before[1], during[0]));
    assert.deepEqual(payloadOf(all, ECG), cat(before[2], during[1]));
    assert.deepEqual(all.filter((r) => r.kind === PCG).map((r) => r.t), [5000, 5000, 6000]);
    assert.equal(all.filter((r) => r.kind === ECG)[0].t, 5000);
    assert.equal(all.filter((r) => r.kind === ECG_1K)[0].t, 5000);
    assert.deepEqual(new Float32Array(payloadOf(all, ECG_1K).slice().buffer), Float32Array.from(h.ecgSeen));

    const events = eventsOf(all);
    assert.deepEqual(events.map((e) => e.e), ['start', 'ecg-start-sent', 'stop']);
    const { wall, ...start } = events[0];
    assert.ok(wall > 0);
    assert.deepEqual(start, { e: 'start', format: 1, note: ALIGN_NOTE, pcg_hz: 1000, ecg_frame_hz: 500, ecg_1k_hz: 1000 });
    assert.equal(all.at(0).kind, EVENT);
    assert.equal(all.at(-1).kind, EVENT);
    assert.equal(all.at(-1).t, 7000);
  }
});

test('keep-alive is counted at 30 000 frames, and none follows Stop', async () => {
  const h = session();
  const { ecg, pcg, records } = h;
  await h.startDone();
  ecg.feed(ecgFrames(0, 29999));
  await until(() => h.ecgSeen.length === 2 * 29999 - 1, 'frame 29 999');
  await sleep(20);
  assert.equal(ecg.writes.length, 5, 'no keep-alive before frame 30 000');
  ecg.feed(ecgFrames(29999, 1));
  await until(() => ecg.writes.length === 7, 'the keep-alive');
  assert.deepEqual(ecg.writes.slice(5), commandBytes(KEEP_ALIVE));

  ecg.feed(ecgFrames(30000, 29999));
  await until(() => h.ecgSeen.length === 2 * 59999 - 1, 'frame 59 999');
  await sleep(20);
  assert.equal(ecg.writes.length, 7, 'the next keep-alive comes 30 000 frames later, not sooner');
  ecg.feed(ecgFrames(59999, 1));
  await until(() => ecg.writes.length === 9, 'the second keep-alive');

  const stopping = h.s.stop();
  await until(() => ecg.writes.length === 10, 'the first stop byte');
  ecg.feed(ecgFrames(60000, 30000)); // past the next threshold, during the stop
  await until(() => h.ecgSeen.length === 2 * 90000 - 1, 'frame 90 000');
  pcg.feed(pcgFrame(1));
  await stopping;
  assert.deepEqual(ecg.writes.slice(5), [...commandBytes(KEEP_ALIVE), ...commandBytes(KEEP_ALIVE), ...commandBytes(STOP)]);
  assert.deepEqual(eventsOf(records()).filter((e) => e.e === 'keep-alive'), [{ e: 'keep-alive', frames: 30000 }, { e: 'keep-alive', frames: 60000 }]);
});

test('one device lost: one lost event, the other stream keeps logging, and Stop writes nothing to the dead port', async () => {
  const h = session();
  const { ecg, pcg, records } = h;
  await h.startDone();
  pcg.feed(pcgFrame(1));
  ecg.feed(ecgFrames(0, 3));
  await until(() => h.ecgSeen.length === 5, 'the first samples');
  ecg.lose('The device has been lost.');
  await until(() => h.lost.length === 1, 'onLost');
  assert.deepEqual(h.lost, [['ecg', 'The device has been lost.']]);
  await until(() => eventsOf(records()).some((e) => e.e === 'lost'), 'the lost event on disk, before any Stop');
  assert.deepEqual(payloadOf(records(), ECG), ecgFrames(0, 3));

  const after = [pcgFrame(2), pcgFrame(3)];
  pcg.feed(after[0]);
  pcg.feed(after[1]);
  await until(() => h.pcgSeen.length === 2, 'PCG after the loss');
  assert.equal(await h.s.stop(), true);
  assert.equal(await h.s.done, true);

  assert.equal(ecg.writes.length, 5, 'a write reached the dead port');
  const all = records();
  assert.deepEqual(payloadOf(all, PCG), cat(pcgFrame(1), ...after));
  const events = eventsOf(all);
  assert.deepEqual(events.filter((e) => e.e === 'lost'), [{ e: 'lost', stream: 'ecg', message: 'The device has been lost.' }]);
  assert.equal(events.filter((e) => e.e === 'read-error').length, 0, 'a fatal error is not a read-error');
  assert.equal(events.at(-1).e, 'stop');
});

test('a non-fatal read error is logged between the two runs of records, and reading resumes', async () => {
  for (const name of ['ecg', 'pcg']) {
    const h = session();
    const port = h[name];
    const kind = name === 'ecg' ? ECG : PCG;
    const seen = name === 'ecg' ? h.ecgSeen : h.pcgSeen;
    const run = (k) => (name === 'ecg' ? ecgFrames(k, 2) : cat(pcgFrame(k + 1), pcgFrame(k + 2)));
    port.feed(run(0));
    await until(() => seen.length > 0, 'the first run');
    const first = seen.length;
    port.overrun('Buffer overrun');
    await sleep(5);
    port.feed(run(2));
    await until(() => seen.length > first, 'the second run');
    await h.s.stop();

    const all = h.records();
    const marks = all.map((r) => (r.kind === kind ? 'data' : r.kind === EVENT ? eventsOf([r])[0].e : '')).filter((m) => m === 'data' || m === 'read-error');
    assert.deepEqual(marks, ['data', 'read-error', 'data']);
    const events = eventsOf(all);
    assert.deepEqual(events.find((e) => e.e === 'read-error'), { e: 'read-error', stream: name, message: 'Buffer overrun' });
    assert.equal(h.lost.length, 0);
    assert.equal(events.at(-1).e, 'stop');
    assert.deepEqual(payloadOf(all, kind), cat(run(0), run(2)));
  }
});

test('both lost, even during START: done resolves with everything saved, with no Stop', async () => {
  const h = session();
  const { ecg, pcg, log, files, records } = h;
  pcg.feed(pcgFrame(1));
  ecg.feed(ecgFrames(0, 2));
  await until(() => h.ecgSeen.length === 3, 'the first samples');
  ecg.lose('gone');
  pcg.lose('gone too');
  assert.equal(await h.s.done, true);
  assert.deepEqual(h.lost.map(([name]) => name).sort(), ['ecg', 'pcg']);
  assert.equal(log.stats.unsaved, 0);

  const count = files.length;
  await sleep(350); // past the end of START: a late ecg-start-sent would be a record nobody saves
  assert.equal(await log.flush(), true);
  assert.equal(files.length, count, 'a record landed after the session ended');

  const all = records();
  assert.deepEqual(payloadOf(all, PCG), pcgFrame(1));
  assert.deepEqual(payloadOf(all, ECG), ecgFrames(0, 2));
  assert.deepEqual(eventsOf(all).map((e) => e.e).sort(), ['lost', 'lost', 'start']);
});

// The round trip: Tools/load_recording.py reads back what the real createLog and createEcgChain wrote

const TOOLS = fileURLToPath(new URL('../Tools', import.meta.url));
const LOADER = path.join(TOOLS, 'load_recording.py');
const segmentName = (index) => `${String(index).padStart(5, '0')}.ecgpcg`;
const saveTo = (dir) => async (index, blob) => fs.writeFile(path.join(dir, segmentName(index)), Buffer.from(await blob.arrayBuffer()));
const summaryOf = (dir) => JSON.parse(execFileSync('python3', ['-I', '-B', LOADER, dir, '--json'], { encoding: 'utf8' }));
const dump = (dir, out) => JSON.parse(execFileSync('python3', ['-I', '-B', '-c', DUMP, TOOLS, dir, out], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

const DUMP = `
import json, sys
sys.path.insert(0, sys.argv[1])
from load_recording import load
rec = load(sys.argv[2])
for key, value in rec.items():
    if hasattr(value, 'tofile'):
        value.tofile(f'{sys.argv[3]}/{key}.bin')
print(json.dumps({key: rec[key] for key in ('pcg_drops', 'ecg_resync', 'events', 'missing_segments', 'errors')}))
`;

// 300 s of two streams on their own clocks, in the order a session logs them
async function makeRecording(dir) {
  let s = 20261105;
  const rand = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const jitter = () => -Math.log(1 - rand()) * 2; // one-sided, mean 2 ms
  const T0 = 5000, T1 = T0 + 500, PCG_PPM = 20, ECG_PPM = 240;
  const log = [];
  const emit = (t, what) => log.push({ t, ...what });

  // PCG: a stale frame, then seq from 32 000, which wraps after 7.68 s, with 2 frames never sent, some chunks cut mid-frame,
  // and the stream lost mid-frame after 280 s
  const pcgSample = (n) => Math.round(20000 * Math.sin(n / 9));
  const pcgBytes = (q) => {
    const f = new Uint8Array(24), dv = new DataView(f.buffer);
    dv.setInt16(0, -32768, true);
    dv.setUint16(2, (32000 + q) & 0x7fff, true);
    for (let j = 0; j < 10; j++) dv.setInt16(4 + 2 * j, pcgSample(10 * q + j), true);
    return f;
  };
  const LIVE = 28000, DROPPED = [5000, 20000];
  const pcg = [], pcgIndex = [], pcgFrameIndex = [], pcgFrameT = [];
  emit(T0, { pcg: pcgBytes(-900) });
  let t = T0;
  for (let q = 0; q < LIVE; q++) {
    const previous = t; // reads come in order, so a stream's t never goes back, even for the first half of a cut frame
    t = Math.max(t, T0 + 10 + (q * 10) / (1 + PCG_PPM * 1e-6) + jitter());
    if (DROPPED.includes(q)) continue;
    const f = pcgBytes(q);
    if (q % 50 === 7) {
      const cut = 1 + Math.floor(rand() * 22);
      emit(Math.max(previous, t - 1), { pcg: f.subarray(0, cut) });
      emit(t, { pcg: f.subarray(cut) });
    } else {
      emit(t, { pcg: f });
    }
    pcgFrameIndex.push(10 * q);
    pcgFrameT.push(t);
    for (let j = 0; j < 10; j++) {
      pcg.push(pcgSample(10 * q + j));
      pcgIndex.push(10 * q + j);
    }
  }
  emit(t + 10, { pcg: pcgBytes(LIVE).subarray(0, 10) });
  const lostAt = t + 20;

  // ECG: junk before lock, 150 000 frames in chunks of any size, and 17 bytes lost mid-stream, which costs the whole frame
  const M = 150000, CUT = 100000, junk = 65, lostFrom = junk + 40 * CUT + 5, lostTo = lostFrom + 17;
  const leadI = (m) => Math.round(-1500 * Math.cos(m / 11));
  const stream = new Uint8Array(junk + 40 * M).fill(0x11, 0, junk);
  for (let m = 0; m < M; m++) stream.set(ecgFrame(leadII(m), leadI(m), m & 0x1f, (m >> 5) & 0x1f), junk + 40 * m);
  const clock = (p) => T1 + (p * 0.05) / (1 + ECG_PPM * 1e-6);
  const ecgFrameT = [];
  let m = 0;
  t = T1;
  for (let p = 0; p < stream.length; ) {
    const end = Math.min(p + 1 + Math.floor(rand() * 127), stream.length);
    t = Math.max(t, clock(end) + jitter() + (end < 40000 ? 40 : 0)); // the first 2 s run late, as after a real start: the fit must skip them
    const value = end <= lostFrom || p >= lostTo ? stream.subarray(p, end) : cat(stream.subarray(p, Math.min(end, lostFrom)), stream.subarray(Math.min(lostTo, end), end));
    emit(t, { ecg: value });
    for (; junk + 40 * (m + 1) <= end; m++) if (m !== CUT) ecgFrameT.push(t);
    p = end;
  }
  const end = t;

  emit(T0 - 1, { event: { e: 'start', format: 1, wall: 1793800000000, note: ALIGN_NOTE, pcg_hz: 1000, ecg_frame_hz: 500, ecg_1k_hz: 1000 } });
  emit(T0 + 305, { event: { e: 'ecg-start-sent' } });
  emit(clock(lostFrom), { event: { e: 'read-error', stream: 'ecg', message: 'Buffer overrun' } });
  emit(lostAt, { event: { e: 'lost', stream: 'pcg', message: 'The device has been lost.' } });
  emit(end + 1, { event: { e: 'stop' } });

  // Written the way startSession writes them, and read by the real parsers too, so the loader has something to agree with
  const file = createLog(saveTo(dir));
  const chain = createEcgChain();
  const pcgParser = createPcgParser();
  const ecg1k = new Float32Array(2 * (M - 1) - 1);
  let o = 0, keepAliveAt = 30000, keepAlives = 0;
  for (const c of log.sort((a, b) => a.t - b.t)) {
    if (c.event) file.event(c.t, c.event);
    if (c.pcg) {
      file.add(c.t, [PCG, c.pcg]);
      pcgParser.push(c.pcg);
    }
    if (c.ecg) {
      const y = chain.push(c.ecg);
      file.add(c.t, [ECG, c.ecg], [ECG_1K, new Uint8Array(y.buffer, y.byteOffset, y.byteLength)]);
      ecg1k.set(y, o);
      o += y.length;
      if (chain.stats.frames >= keepAliveAt) {
        keepAliveAt += 30000;
        keepAlives++;
        file.event(c.t, { e: 'keep-alive', frames: chain.stats.frames });
      }
    }
  }
  assert.equal(await file.flush(), true);

  const kept = Array.from({ length: M }, (_, k) => k).filter((k) => k !== CUT);
  return {
    expected: {
      pcg: Int16Array.from(pcg),
      pcg_index: BigInt64Array.from(pcgIndex, BigInt),
      pcg_frame_index: BigInt64Array.from(pcgFrameIndex, BigInt),
      pcg_frame_t: Float64Array.from(pcgFrameT),
      ecg_i: Int16Array.from(kept, leadI),
      ecg_ii: Int16Array.from(kept, leadII),
      ecg_a1: Uint8Array.from(kept, (k) => k & 0x1f),
      ecg_b1: Uint8Array.from(kept, (k) => (k >> 5) & 0x1f),
      ecg_frame_t: Float64Array.from(ecgFrameT),
      ecg_1k: ecg1k.subarray(0, o),
    },
    frames: M - 1, liveFrames: LIVE - DROPPED.length, resyncFrame: CUT, keepAlives, lostAt, chain, pcgParser,
  };
}

let shared = null;
async function recording() {
  if (!shared) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-test-'));
    const folder = path.join(dir, 'recording');
    await fs.mkdir(folder);
    shared = { dir, folder, ...(await makeRecording(folder)) };
  }
  return shared;
}
test.after(() => shared && fs.rm(shared.dir, { recursive: true, force: true }));

test('round trip: the loader gives back every array, byte for byte, and every gap from the file alone', async () => {
  const r = await recording();
  const out = path.join(r.dir, 'dump');
  await fs.mkdir(out);
  const rec = dump(r.folder, out);
  for (const [key, want] of Object.entries(r.expected)) {
    const got = await fs.readFile(path.join(out, `${key}.bin`));
    assert.equal(got.length, want.byteLength, `${key} length`);
    assert.equal(Buffer.compare(got, bytesOf(want)), 0, `${key} differs`);
  }
  assert.equal(r.expected.ecg_1k.length, 2 * r.frames - 1);

  assert.equal(rec.pcg_drops, 2);
  assert.equal(r.pcgParser.stats.drops, 2, 'the loader must agree with the parser the page uses');
  assert.equal(r.pcgParser.stats.frames, r.liveFrames + 1, 'the stale frame counts in the parser, and not in the loader');
  assert.deepEqual(rec.ecg_resync, [[r.resyncFrame, 23]]);
  assert.equal(r.chain.stats.skippedAfterLock, 23);
  assert.equal(r.chain.stats.frames, r.frames);
  assert.deepEqual(rec.missing_segments, []);
  assert.deepEqual(rec.errors, []);

  const s = summaryOf(r.folder);
  const files = (await fs.readdir(r.folder)).sort();
  assert.ok(files.length >= 3, `${files.length} files`);
  assert.equal(s.note, ALIGN_NOTE);
  assert.equal(s.segments, files.length);
  assert.deepEqual([s.pcg_frames, s.pcg_drops, s.ecg_frames, s.ecg_resyncs, s.ecg_skipped_after_lock], [r.liveFrames, 2, r.frames, 1, 23]);
  assert.equal(s.ecg_1k_ok, true);
  assert.equal(s.clean_stop, true);
  assert.equal(s.keep_alives, r.keepAlives);
  assert.equal(r.keepAlives, 4, '149 999 frames: the last threshold is not reached');
  assert.deepEqual(s.read_errors.map((e) => [e.stream, e.message]), [['ecg', 'Buffer overrun']]);
  assert.deepEqual(s.lost, [{ t: r.lostAt, stream: 'pcg', message: 'The device has been lost.' }]);
  assert.ok(Math.abs(s.seconds - 300.5) < 1, `seconds ${s.seconds}`);
  assert.ok(Math.abs(s.relative_ppm - 220) <= 2, `relative_ppm ${s.relative_ppm}`);
  assert.ok(Math.abs(s.pcg_hz - 1000.02) < 0.003, `pcg_hz ${s.pcg_hz}`);
  assert.ok(Math.abs(s.ecg_frame_hz - 500.12) < 0.002, `ecg_frame_hz ${s.ecg_frame_hz}`);
  s.relative_ppm_halves.forEach((v) => assert.ok(Math.abs(v - 220) <= 5, `half ${v}`));
  for (const stream of ['pcg', 'ecg']) {
    const { p50, p99, max } = s.residual_ms[stream];
    assert.ok(p50 > 1 && p50 < 2 && p50 < p99 && p99 <= max && max < 30, `${stream} residuals in ms ${p50} ${p99} ${max}`);
  }
  assert.deepEqual(s.chunk_bytes.pcg.max, 24);
  assert.ok(s.chunk_bytes.ecg.median > 50 && s.chunk_bytes.ecg.median < 80 && s.chunk_bytes.ecg.max > 100);
  assert.ok(JSON.stringify(s).length < 3000, 'the summary holds no samples');
});

test('damage: a missing file, a truncated file and bad records are reported, and nothing raises', async () => {
  const r = await recording();
  const files = (await fs.readdir(r.folder)).sort();
  const copy = async (name) => {
    const to = path.join(r.dir, name);
    await fs.cp(r.folder, to, { recursive: true });
    return to;
  };

  const hole = await copy('hole');
  const middle = Math.floor(files.length / 2);
  await fs.rm(path.join(hole, files[middle]));
  let s = summaryOf(hole);
  assert.deepEqual(s.missing_segments, [middle + 1]);
  assert.deepEqual(s.errors, []);
  assert.equal(s.segments, files.length - 1);
  assert.ok(s.pcg_drops > 2, 'the frames in the missing file show as seq gaps');
  assert.ok(s.ecg_resyncs >= 1);
  assert.equal(s.ecg_1k_ok, false, 'frames and filtered samples no longer line up across the hole');
  assert.equal(s.note, ALIGN_NOTE);

  const cut = await copy('cut');
  const last = path.join(cut, files.at(-1));
  await fs.truncate(last, (await fs.stat(last)).size - 5);
  s = summaryOf(cut);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], new RegExp(`${files.at(-1)}.*overruns`));
  assert.deepEqual(s.missing_segments, []);
  assert.equal(s.ecg_frames, r.frames, 'the records before the cut are all there');
  assert.equal(s.clean_stop, false);

  // A lost last file leaves no hole in the numbering, so clean_stop is what shows it
  const lostTail = await copy('lost-tail');
  await fs.rm(path.join(lostTail, files.at(-1)));
  s = summaryOf(lostTail);
  assert.deepEqual([s.missing_segments, s.errors, s.clean_stop], [[], [], false]);

  // A header cut short, a corrupt event, an unknown kind, a time that is not a number, and a stray file
  const bad = path.join(r.dir, 'bad');
  await fs.mkdir(bad);
  const text = (v) => new TextEncoder().encode(v);
  await fs.writeFile(path.join(bad, segmentName(1)), cat(record(EVENT, 1, text('{not json')), record(EVENT, 2, text('[1]')), record(9, 3, Uint8Array.of(1)), record(PCG, NaN, Uint8Array.of(1))));
  await fs.writeFile(path.join(bad, segmentName(3)), Uint8Array.of(1, 2, 3, 4, 5));
  await fs.writeFile(path.join(bad, 'stray.ecgpcg'), Uint8Array.of(1));
  s = summaryOf(bad);
  assert.deepEqual(s.missing_segments, [2]);
  assert.equal(s.errors.length, 6, s.errors.join(' | '));
  assert.equal(s.relative_ppm, null);

  for (const nothing of [path.join(r.dir, 'empty'), path.join(r.dir, 'no such folder')]) {
    if (nothing.endsWith('empty')) await fs.mkdir(nothing);
    s = summaryOf(nothing);
    assert.deepEqual([s.ecg_frames, s.pcg_frames, s.note, s.relative_ppm], [0, 0, null, null]);
    assert.deepEqual(s.errors, ['no segment files']);
  }

  // The parsers' hard cases on the Python copy, judged by the parsers the page uses. PCG: a cut first frame, a truncated
  // frame, and a look-alike sync in every frame, first with the same seq, then with a seq whose top bit is set
  const lookAlikes = [() => [0x0012, 0x0580, 3], (seq) => [0x0012, ((seq & 0x7f) << 8) | 0x80, 0x0090]];
  for (const [k, samples] of lookAlikes.entries()) {
    const fake = (seq) => {
      const f = pcgFrame(seq), dv = new DataView(f.buffer);
      samples(seq).forEach((v, j) => dv.setInt16(12 + 2 * j, v, true));
      return f;
    };
    const folder = path.join(r.dir, `pcg-${k}`), out = path.join(r.dir, `pcg-${k}-dump`);
    await fs.mkdir(folder);
    await fs.mkdir(out);
    const value = cat(fake(1).subarray(8), fake(2), fake(3), fake(4).subarray(0, 12), fake(5), fake(6), fake(7), fake(8).subarray(0, 4));
    const parser = createPcgParser(), log = createLog(saveTo(folder));
    const frames = parser.push(value);
    log.add(1, [PCG, value]);
    assert.equal(await log.flush(), true);
    assert.equal(frames.length, 5);
    assert.equal(dump(folder, out).pcg_drops, parser.stats.drops);
    const live = Int16Array.from(frames.slice(1).flatMap((f) => Array.from(f)));
    assert.equal(Buffer.compare(await fs.readFile(path.join(out, 'pcg.bin')), bytesOf(live)), 0, `case ${k}: not what the page's parser reads`);
  }

  // ECG: a frame with a whole marker set inside it, one look-alike for each marker, and a hunt still running when the stream ends
  const nested = ecgFrame(0);
  [[5, 1], [17, 2], [29, 3]].forEach(([at, n]) => nested.set([n, 0xc0], at));
  const almost = [0, 1, 12, 13, 24, 25].map((at) => {
    const f = ecgFrame(7);
    f[at] ^= 0x40;
    return f;
  });
  const tail = path.join(r.dir, 'tail');
  await fs.mkdir(tail);
  const value = cat(ecgFrames(0, 3), nested, ...almost, ecgFrames(3, 2), new Uint8Array(100).fill(0x22));
  const chain = createEcgChain(), parser = createEcgParser(), log = createLog(saveTo(tail));
  const y = chain.push(value);
  parser.push(value);
  log.add(1, [ECG, value], [ECG_1K, new Uint8Array(y.buffer)]);
  assert.equal(await log.flush(), true);
  s = summaryOf(tail);
  assert.equal(parser.stats.frames, 6);
  assert.equal(parser.stats.skipped, 6 * 40 + 61);
  assert.deepEqual([s.ecg_frames, s.ecg_resyncs, s.ecg_skipped_after_lock], [6, 2, parser.stats.skipped]);
  assert.equal(s.ecg_skipped_after_lock, chain.stats.skippedAfterLock);
  assert.equal(s.ecg_1k_ok, true);
});

// The export: Tools/load_recording.py <folder> --export

const OMITTED = 'Lead I and the rest of each ECG frame, electrode flags, per-chunk stamps and events stay only in the small files: keep the recording folder.';
const exportOf = (dir, ...flags) => spawnSync('python3', ['-I', '-B', LOADER, dir, '--export', ...flags], { encoding: 'utf8' });
const exists = (p) => fs.stat(p).then(() => true, () => false);
const contents = async (dir) => Promise.all((await fs.readdir(dir)).sort().map(async (name) => `${name} ${createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex')}`));
const dumpExport = (dir, out) => JSON.parse(execFileSync('python3', ['-I', '-B', '-c', EXPORT_DUMP, dir, out], { encoding: 'utf8' }));

const EXPORT_DUMP = `
import json, sys
from pathlib import Path
import numpy as np
folder, out = map(Path, sys.argv[1:])
arrays = {p.stem: np.load(p, allow_pickle=False) for p in folder.glob('*.npy')}
with np.load(folder / 'timestamps.npz', allow_pickle=False) as npz:
    arrays.update({key: npz[key] for key in npz.files})
for key, value in arrays.items():
    value.tofile(out / f'{key}.bin')
print(json.dumps({key: [value.dtype.name, value.shape] for key, value in arrays.items()}))
`;

// Runs the real export() with write_export wrapped: argv[3] is one Python line that damages what was written
const CORRUPT = `
import os, sys
import numpy as np
sys.path.insert(0, sys.argv[1])
import load_recording

write_export = load_recording.write_export

def damage(rec, partial):
    write_export(rec, partial)
    pcg, raw, filtered, stamps = (partial / name for name in ('pcg.npy', 'ecg_raw.npy', 'ecg_filtered.npy', 'timestamps.npz'))
    exec(sys.argv[3])

load_recording.write_export = damage
load_recording.export(sys.argv[2])
`;

test('export: the four files match the recording byte for byte, beside it, and the recording stays as it was', async () => {
  const r = await recording();
  const source = await contents(r.folder);
  const exported = `${r.folder}-export`, partial = `${exported}.partial`;

  const first = exportOf(`${r.folder}/`);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(await contents(r.folder), source, 'the recording changed');
  assert.equal(await exists(partial), false);
  assert.equal((await fs.stat(exported)).mode & 0o777, 0o700, 'the folder is private');
  for (const name of await fs.readdir(exported)) assert.equal((await fs.stat(path.join(exported, name))).mode & 0o777, 0o600, name);

  const out = path.join(r.dir, 'export-dump');
  await fs.mkdir(out);
  const shapes = dumpExport(exported, out);
  assert.deepEqual((await fs.readdir(exported)).sort(), ['ecg_filtered.npy', 'ecg_raw.npy', 'pcg.npy', 'timestamps.npz']);
  assert.equal((await fs.readFile(path.join(exported, 'timestamps.npz'))).readUInt16LE(8), 0, 'timestamps.npz is stored, not compressed');
  const M = r.frames, N = r.expected.pcg.length, F = r.liveFrames;
  assert.equal(N, 10 * F);
  const wanted = {
    pcg: [Float32Array.from(r.expected.pcg), 'float32', [N]],
    ecg_raw: [Float32Array.from(r.expected.ecg_ii), 'float32', [M]],
    ecg_filtered: [r.expected.ecg_1k, 'float32', [2 * M - 1]],
    pcg_frame_t: [r.expected.pcg_frame_t, 'float64', [F]],
    ecg_frame_t: [r.expected.ecg_frame_t, 'float64', [M]],
    pcg_frame_index: [r.expected.pcg_frame_index, 'int64', [F]],
    ecg_resync: [BigInt64Array.of(BigInt(r.resyncFrame), 23n), 'int64', [1, 2]],
  };
  assert.deepEqual(Object.keys(shapes).sort(), Object.keys(wanted).sort());
  for (const [key, [want, dtype, shape]] of Object.entries(wanted)) {
    assert.deepEqual(shapes[key], [dtype, shape], key);
    assert.equal(Buffer.compare(await fs.readFile(path.join(out, `${key}.bin`)), bytesOf(want)), 0, `${key} differs`);
  }

  // Position p alone is wrong after the 2 dropped frames, and the documented formula is right
  const index = new BigInt64Array(new Uint8Array(await fs.readFile(path.join(out, 'pcg_frame_index.bin'))).buffer);
  const formula = BigInt64Array.from({ length: N }, (_, p) => index[Math.floor(p / 10)] + BigInt(p % 10));
  assert.equal(Buffer.compare(bytesOf(formula), bytesOf(r.expected.pcg_index)), 0);
  assert.notEqual(r.expected.pcg_index.at(-1), BigInt(N - 1));

  const { stdout } = first;
  assert.ok(stdout.includes(ALIGN_NOTE));
  for (const line of ['errors: []', 'missing_segments: []', 'clean_stop: True']) assert.ok(stdout.includes(line), line);
  assert.ok(stdout.indexOf('clean_stop') < stdout.indexOf('pcg.npy: '), 'the summary comes first');
  const counts = [
    `pcg.npy: ${N} samples`, `ecg_raw.npy: ${M} samples`, `ecg_filtered.npy: ${2 * M - 1} samples`, `timestamps.npz pcg_frame_t: ${F} samples`,
    `timestamps.npz ecg_frame_t: ${M} samples`, `timestamps.npz pcg_frame_index: ${F} samples`, 'timestamps.npz ecg_resync: 1 rows',
  ];
  for (const line of counts) assert.ok(stdout.includes(`${line} verified`), line);
  assert.equal(stdout.trimEnd().split('\n').at(-1), OMITTED);
  assert.ok(stdout.length < 5000, `${stdout.length} characters`);

  const done = await contents(exported);
  const second = exportOf(r.folder);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  assert.deepEqual(await contents(exported), done);
  assert.deepEqual(await contents(r.folder), source);
  assert.equal(await exists(partial), false);

  // A damaged recording still exports, with its problems in the summary
  const damaged = path.join(r.dir, 'damaged');
  await fs.cp(r.folder, damaged, { recursive: true });
  const files = (await fs.readdir(damaged)).sort();
  const hole = Math.floor(files.length / 2);
  await fs.rm(path.join(damaged, files[hole]));
  const last = path.join(damaged, files.at(-1));
  await fs.truncate(last, (await fs.stat(last)).size - 5);
  const holed = exportOf(damaged);
  assert.equal(holed.status, 0, holed.stderr);
  for (const line of [`missing_segments: [${hole + 1}]`, 'overruns the file', 'ecg_1k_ok: False', 'clean_stop: False']) assert.ok(holed.stdout.includes(line), line);
  assert.ok(await exists(`${damaged}-export`));

  // Only a folder with no segments is refused, and it makes nothing
  const stray = path.join(r.dir, 'stray-only');
  await fs.mkdir(stray);
  await fs.writeFile(path.join(stray, 'stray.ecgpcg'), Uint8Array.of(1));
  for (const nothing of [stray, path.join(r.dir, 'never made')]) {
    const refused = exportOf(nothing);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /No segment files/);
    assert.ok(refused.stdout.includes('no segment files'), 'the summary still shows why');
    for (const made of ['-export', '-export.partial']) assert.equal(await exists(nothing + made), false, nothing + made);
  }

  assert.equal(exportOf(stray, '--json').status, 1, '--json and --export together are refused');
  assert.equal(await exists(`${stray}-export.partial`), false);

  // No resync gives shape (0, 2), the bytes compare passes the -0 and NaN that == would fail, and . lands beside the folder too
  const clean = path.join(r.dir, 'clean'), cleanOut = path.join(r.dir, 'clean-dump');
  await fs.mkdir(clean);
  await fs.mkdir(cleanOut);
  const odd = Float32Array.of(1.5, -0, NaN);
  const log = createLog(saveTo(clean));
  log.add(1, [PCG, cat(pcgFrame(1), pcgFrame(2), pcgFrame(3))], [ECG, ecgFrames(0, 2)], [ECG_1K, new Uint8Array(odd.buffer)]);
  assert.equal(await log.flush(), true);
  const quiet = spawnSync('python3', ['-I', '-B', LOADER, '.', '--export'], { encoding: 'utf8', cwd: clean });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(quiet.stdout.includes('timestamps.npz ecg_resync: 0 rows verified'));
  const small = dumpExport(`${clean}-export`, cleanOut);
  assert.deepEqual(small.ecg_resync, ['int64', [0, 2]]);
  assert.equal(Buffer.compare(await fs.readFile(path.join(cleanOut, 'ecg_filtered.bin')), bytesOf(odd)), 0);
});

test('export: damage to any file exits non-zero, names the place, and never reaches the -export name', async () => {
  const r = await recording();
  const exported = `${r.folder}-export`, partial = `${exported}.partial`;
  await fs.rm(exported, { recursive: true, force: true });
  const source = await contents(r.folder);
  const run = (code) => spawnSync('python3', ['-I', '-B', '-c', CORRUPT, TOOLS, r.folder, code], { encoding: 'utf8' });

  const N = r.expected.pcg.length;
  const flip = (file) => `a = np.load(${file}); a.view(np.uint32)[1234] ^= 1; np.save(${file}, a)`;
  const cases = [
    [flip('pcg'), /^pcg\.npy: first mismatch at index 1234\./],
    [flip('raw'), /^ecg_raw\.npy: first mismatch at index 1234\./],
    [flip('filtered'), /^ecg_filtered\.npy: first mismatch at index 1234\./],
    ["s = dict(np.load(stamps)); s['ecg_frame_t'].view(np.uint64)[1234] ^= np.uint64(1); np.savez(stamps, **s)", /^timestamps\.npz ecg_frame_t: first mismatch at index 1234\./],
    ["s = dict(np.load(stamps)); s['ecg_resync'][0, 1] ^= 1; np.savez(stamps, **s)", /^timestamps\.npz ecg_resync: first mismatch at index 0\./],
    ['a = np.load(pcg); a[77] += 0.5; np.save(pcg, a)', /^pcg\.npy: first mismatch at index 77\./],
    ['a = np.load(pcg); a[0] = -0.0; np.save(pcg, a)', /^pcg\.npy: first mismatch at index 0\./],
    ['np.save(pcg, np.load(pcg)[:-1])', new RegExp(`^pcg\\.npy: float32 \\(${N - 1},\\), expected float32 \\(${N},\\)`)],
    ['os.truncate(pcg, pcg.stat().st_size - 4)', new RegExp(`^pcg\\.npy: .*${N}`)],
    ['np.save(pcg, np.load(pcg).astype(np.float64))', new RegExp(`^pcg\\.npy: float64 \\(${N},\\), expected float32 \\(${N},\\)`)],
    ['b = bytearray(stamps.read_bytes()); b[2000] ^= 1; stamps.write_bytes(b)', /^timestamps\.npz pcg_frame_t: .*CRC/],
    ["s = dict(np.load(stamps)); del s['ecg_resync']; np.savez(stamps, **s)", /^timestamps\.npz: holds .*expected/],
    ["(partial / 'extra.npy').touch()", /^recording-export\.partial: holds .*extra\.npy/],
    ['raw.unlink()', /^recording-export\.partial: holds .*expected/],
  ];
  for (const [code, place] of cases) {
    const { status, stderr } = run(code);
    assert.equal(status, 1, `${code}: ${stderr}`);
    assert.match(stderr, place, code);
    assert.match(stderr, /The export is invalid: it stays as recording-export\.partial, and the recording is untouched\./, code);
    assert.equal(await exists(exported), false, code);
    assert.equal(await exists(partial), true, code);
    await fs.rm(partial, { recursive: true });
  }

  // A .partial left behind blocks the next export, which touches nothing
  await fs.mkdir(partial);
  await fs.writeFile(path.join(partial, 'pcg.npy'), 'left over');
  const leftOver = await contents(partial);
  const refused = exportOf(r.folder);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.deepEqual(await contents(partial), leftOver);
  assert.equal(await exists(exported), false);
  await fs.rm(partial, { recursive: true });

  // The same wrapper with no damage passes, so the failures above came from the damage
  const control = run('pass');
  assert.equal(control.status, 0, control.stderr);
  assert.ok(await exists(exported));
  assert.equal(await exists(partial), false);
  assert.deepEqual(await contents(r.folder), source);
});
