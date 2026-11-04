// Parser for the PCG_CDC stream: little-endian int16 frames of
// [0x8000 sync][seq 0-32767, wrapping][10 filtered samples at 1000 Hz], 24 bytes every 10 ms.
export const FRAME_BYTES = 24;
export const SAMPLES_PER_FRAME = 10;
export const RATE = 1000;

// Bytes 00 80 then a seq whose top bit is clear: samples are clamped to +-32767 and seq is 15-bit
const isSync = (b, i) => b[i] === 0x00 && b[i + 1] === 0x80 && b[i + 3] < 0x80;
const seqAt = (b, i) => b[i + 2] | (b[i + 3] << 8);

// push(Uint8Array chunk) returns the Int16Array samples of every frame completed so far
export function createParser() {
  let rest = new Uint8Array(0);
  let lastSeq = 0;
  const stats = { frames: 0, drops: 0 };

  function push(chunk) {
    const b = new Uint8Array(rest.length + chunk.length);
    b.set(rest);
    b.set(chunk, rest.length);
    const dv = new DataView(b.buffer);
    const out = [];
    let i = 0;
    while (i + FRAME_BYTES + 4 <= b.length) {
      const next = i + FRAME_BYTES;
      // A frame counts only when the next sync follows 24 bytes later with a different seq, so a
      // 00 80 pair across two samples (even one repeated in every frame) or a truncated frame is skipped
      if (!isSync(b, i) || !isSync(b, next) || seqAt(b, i) === seqAt(b, next)) {
        i++;
        continue;
      }
      const seq = seqAt(b, i);
      // The device queues one stale frame while the port is closed, so the first gap is not a drop
      if (stats.frames > 1) stats.drops += (seq - lastSeq - 1) & 0x7fff;
      lastSeq = seq;
      stats.frames++;
      const s = new Int16Array(SAMPLES_PER_FRAME);
      for (let j = 0; j < SAMPLES_PER_FRAME; j++) s[j] = dv.getInt16(i + 4 + 2 * j, true);
      out.push(s);
      i = next;
    }
    rest = b.subarray(i);
    return out;
  }

  return { push, stats };
}
