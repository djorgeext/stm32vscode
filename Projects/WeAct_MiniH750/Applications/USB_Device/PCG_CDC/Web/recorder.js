// Logic of the synchronized recorder, with no DOM, so node can test it. A recording is one log of little-endian records
// split over numbered files, each ending on a record boundary: f64 t (performance.now() ms), u32 n, u8 kind, n payload bytes.
import { createParser as createEcgParser, createEcgFilter, createSender, START, KEEP_ALIVE, STOP, KEEP_ALIVE_FRAMES } from './ecg_dsp.js';
import { createParser as createPcgParser } from './pcg_parser.js';
import { createUpsampler } from './upsample.js';

export const PCG = 1, ECG = 2, EVENT = 3, ECG_1K = 4;
export const HEADER_BYTES = 13;
export const SEGMENT_BYTES = 256 * 1024;
export const ECG_PORT = { usbVendorId: 0x04d8, usbProductId: 0x00df };
export const PCG_PORT = { usbVendorId: 0x0483, usbProductId: 0x5740 };
export const ALIGN_NOTE =
  "ECG and PCG are both nominally 1000 Hz, but each runs on its own clock (ECG: the module, PCG: the STM32). Sample j of one is not simultaneous with sample j of the other. Align them offline with each stream's sample index and the host timestamps. The fixed offset between the two paths is not measured: about ±3 ms, an estimate.";

export function record(kind, t, bytes) {
  const r = new Uint8Array(HEADER_BYTES + bytes.length);
  const dv = new DataView(r.buffer);
  dv.setFloat64(0, t, true);
  dv.setUint32(8, bytes.length, true);
  dv.setUint8(12, kind);
  r.set(bytes, HEADER_BYTES);
  return r;
}

// save(index, blob) is async. Files are saved one at a time, in order, and a failed one stays first in line
export function createLog(save) {
  // shortcut: unsaved segments stay in memory with no cap, 100-200 MB per hour of failed writes; add a cap if disks ever fill mid-recording
  const queue = [];
  const stats = { saved: 0, unsaved: 0, error: '' };
  let open = [], size = 0, next = 1, running = null;

  function roll() {
    if (!open.length) return;
    queue.push({ index: next++, blob: new Blob(open) });
    stats.unsaved = queue.length;
    open = [];
    size = 0;
  }

  async function drain() {
    try {
      while (queue.length) {
        await save(queue[0].index, queue[0].blob);
        queue.shift();
        stats.saved++;
        stats.unsaved = queue.length;
        stats.error = '';
      }
    } catch (e) {
      stats.error = String(e);
    }
  }

  // Cleared in finally, never inside drain(), which can end before this assignment and would leave running set forever
  const pump = () => (running ??= drain().finally(() => (running = null)));

  // Each [kind, bytes] is one record, and the group stays in one file: the roll comes after it
  function add(t, ...group) {
    for (const [kind, bytes] of group) {
      const r = record(kind, t, bytes);
      open.push(r);
      size += r.length;
    }
    if (size >= SEGMENT_BYTES) {
      roll();
      pump();
    }
  }

  const event = (t, object) => add(t, [EVENT, new TextEncoder().encode(JSON.stringify(object))]);

  async function flush() {
    roll();
    await running; // a save already running may fail, and this flush must then try again
    await pump();
    return !queue.length;
  }

  return { add, event, flush, stats };
}

export function createEcgChain() {
  const parser = createEcgParser();
  const filter = createEcgFilter();
  const up = createUpsampler(2);
  const stats = parser.stats;
  stats.skippedAfterLock = 0;
  let junk = 0;

  // Byte by byte until the first frame: one chunk can hold junk, that frame and later losses, and skipped only has their sum
  function parse(chunk) {
    if (stats.frames) return parser.push(chunk);
    for (let i = 0; i < chunk.length; i++) {
      const first = parser.push(chunk.subarray(i, i + 1));
      junk = stats.skipped;
      if (stats.frames) return [...first, ...parser.push(chunk.subarray(i + 1))];
    }
    return [];
  }

  function push(chunk) {
    const y = [];
    for (const [, leadII] of parse(chunk)) y.push(...up(filter(leadII)));
    if (stats.frames) stats.skippedAfterLock = stats.skipped - junk;
    return Float32Array.from(y);
  }

  return { push, stats };
}

// Lead II needs RA and LL, so LA plays no part here (§8.3)
export function leadIILine({ raOff, llOff }) {
  if (raOff && llOff) return 'Lead II not valid: RA and LL electrodes off.';
  if (raOff) return 'Lead II not valid: RA electrode off.';
  if (llOff) return 'Lead II not valid: LL electrode off.';
  return 'RA and LL electrodes on.';
}

export function findPorts(ports) {
  const find = ({ usbVendorId, usbProductId }) =>
    ports.find((p) => {
      const i = p.getInfo();
      return i.usbVendorId === usbVendorId && i.usbProductId === usbProductId;
    }) ?? null;
  return { ecg: find(ECG_PORT), pcg: find(PCG_PORT) };
}

// dev = { port, reader, stopping }. Closes the port, and returns the error text, or '' after a Stop
export async function readPort(dev, now, onChunk, onError) {
  let error = '';
  while (dev.port.readable && !dev.stopping) {
    dev.reader = dev.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await dev.reader.read();
        const t = now();
        if (done) break;
        onChunk(t, value);
      }
    } catch (e) {
      // Unplugging is fatal (port.readable becomes null); an overrun is not, and reading resumes
      error = e.message;
      if (dev.port.readable) onError(error);
    } finally {
      dev.reader.releaseLock();
    }
  }
  await dev.port.close().catch(() => {}); // after an unplug the port is already gone
  return dev.stopping ? '' : error || 'the port closed';
}

export function startSession({ ecgPort, pcgPort, log, now, onPcg, onEcg, onLost }) {
  const ecg = { port: ecgPort, reader: null, stopping: false };
  const pcg = { port: pcgPort, reader: null, stopping: false };
  const chain = createEcgChain();
  const parser = createPcgParser();
  const send = createSender(ecgPort);
  let keepAliveAt = KEEP_ALIVE_FRAMES, stopped = null;

  function ecgChunk(t, value) {
    let y = new Float32Array(0);
    try {
      y = chain.push(value);
    } finally {
      log.add(t, [ECG, value], [ECG_1K, new Uint8Array(y.buffer, y.byteOffset, y.byteLength)]); // the raw bytes outlive a parser bug
    }
    // Counted, as Chrome throttles timers in hidden tabs
    if (chain.stats.frames >= keepAliveAt) {
      keepAliveAt += KEEP_ALIVE_FRAMES;
      log.event(t, { e: 'keep-alive', frames: chain.stats.frames });
      send(...KEEP_ALIVE);
    }
    onEcg(y);
  }

  function pcgChunk(t, value) {
    log.add(t, [PCG, value]);
    onPcg(parser.push(value));
  }

  const watch = (name, dev, onChunk) =>
    readPort(dev, now, onChunk, (message) => log.event(now(), { e: 'read-error', stream: name, message })).then(async (message) => {
      if (!message) return;
      dev.lost = true;
      log.event(now(), { e: 'lost', stream: name, message });
      onLost(name, message);
      await log.flush();
    });

  log.event(now(), { e: 'start', format: 1, wall: Date.now(), note: ALIGN_NOTE, pcg_hz: 1000, ecg_frame_hz: 500, ecg_1k_hz: 1000 });
  const loops = Promise.all([watch('ecg', ecg, ecgChunk), watch('pcg', pcg, pcgChunk)]);
  // send() swallows a dead port, so without the check this could land after the last flush of a session that ended itself
  send(...START).then(() => {
    if (!ecg.lost) log.event(now(), { e: 'ecg-start-sent' });
  });

  async function halt() {
    keepAliveAt = Infinity; // no keep-alive may follow the stop bytes
    await send(...STOP).then(() => ecg.port.writable.close()).catch(() => {}); // PCG keeps logging during this drain
    ecg.stopping = pcg.stopping = true;
    ecg.reader?.cancel().catch(() => {});
    pcg.reader?.cancel().catch(() => {});
    await loops;
    log.event(now(), { e: 'stop' });
    return log.flush();
  }

  const stop = () => (stopped ??= halt());
  const done = loops.then(() => stopped ?? log.flush());
  return { stop, done, ecgStats: chain.stats, pcgStats: parser.stats };
}
