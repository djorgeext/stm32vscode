// Self-check of Web/recorder.js, on synthetic data only: a recording of a person never goes into a test or a fixture.
// From the project folder: node Tests/recorder_test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PCG, ECG, EVENT, ECG_1K, HEADER_BYTES, SEGMENT_BYTES, ECG_PORT, PCG_PORT, ALIGN_NOTE,
  record, createLog, createEcgChain, leadIILine, findPorts, startSession,
} from '../Web/recorder.js';
import { createEcgFilter, START, STOP, KEEP_ALIVE } from '../Web/ecg_dsp.js';

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
function ecgFrame(leadII, leadI = 0) {
  const f = new Uint8Array(40);
  const dv = new DataView(f.buffer);
  [1, 2, 3].forEach((n, k) => f.set([n, 0xc0], 12 * k));
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
