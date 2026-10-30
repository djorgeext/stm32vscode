// Parser and filters for the Biomedic ECG stream (Biomedic_ECG_USB_protocol.md at the repo root):
// 40-byte frames at 500/s, three 12-byte blocks that start 01 C0, 02 C0, 03 C0, leads as big-endian int16.
export const FRAME_BYTES = 40;
export const RATE = 500;

// The same marker check as the vendor program: on a mismatch, hunt again from the next byte
const isFrame = (b, i) =>
  b[i] === 0x01 && b[i + 1] === 0xc0 && b[i + 12] === 0x02 && b[i + 13] === 0xc0 && b[i + 24] === 0x03 && b[i + 25] === 0xc0;

// push(Uint8Array chunk) returns the lead I counts of every frame completed so far;
// stats holds the frame count, the bytes skipped while syncing and the RA/LA electrode-off flags of the last frame
export function createParser() {
  let rest = new Uint8Array(0);
  const stats = { frames: 0, skipped: 0, raOff: false, laOff: false };

  function push(chunk) {
    const b = new Uint8Array(rest.length + chunk.length);
    b.set(rest);
    b.set(chunk, rest.length);
    const dv = new DataView(b.buffer);
    const out = [];
    let i = 0;
    while (i + FRAME_BYTES <= b.length) {
      if (!isFrame(b, i)) {
        i++;
        stats.skipped++;
        continue;
      }
      out.push(dv.getInt16(i + 6)); // lead I = LA - RA
      stats.raOff = (b[i + 3] & 0x60) !== 0;
      stats.laOff = (b[i + 2] & 0x20) !== 0;
      stats.frames++;
      i += FRAME_BYTES;
    }
    rest = b.subarray(i);
    return out;
  }

  return { push, stats };
}

// RBJ cookbook biquad at RATE, direct form II transposed
function biquad(b0, b1, b2, a0, a1, a2) {
  [b0, b1, b2, a1, a2] = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  let z1 = 0, z2 = 0;
  return (x) => {
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  };
}

function design(f, q) {
  const w = (2 * Math.PI * f) / RATE;
  return [Math.cos(w), Math.sin(w) / (2 * q)];
}

export function highpass(f, q = Math.SQRT1_2) {
  const [c, a] = design(f, q);
  return biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + a, -2 * c, 1 - a);
}

export function lowpass(f, q = Math.SQRT1_2) {
  const [c, a] = design(f, q);
  return biquad((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + a, -2 * c, 1 - a);
}

export function notch(f, q) {
  const [c, a] = design(f, q);
  return biquad(1, -2 * c, 1, 1 + a, -2 * c, 1 - a);
}

// Lead I chain: 2nd-order Butterworth high-pass 0.5 Hz and low-pass 150 Hz (the band-pass), then a 50 Hz notch
// (Q 30, 1.56 Hz wide at -3 dB: 49.23-50.79 Hz). Returns x => filtered x, one sample at a time.
export function createEcgFilter() {
  const stages = [highpass(0.5), lowpass(150), notch(50, 30)];
  let x0 = null;
  // Subtracting the first sample starts the chain settled on the electrode offset, else the 0.5 Hz high-pass rings for seconds
  return (x) => stages.reduce((v, f) => f(v), x - (x0 ??= x));
}
