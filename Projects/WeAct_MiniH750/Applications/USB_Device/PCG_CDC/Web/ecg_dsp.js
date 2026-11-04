// Parser and filters for the Biomedic ECG stream (Biomedic_ECG_USB_protocol.md at the repo root):
// 40-byte frames at 500/s, three 12-byte blocks that start 01 C0, 02 C0, 03 C0, leads as big-endian int16.
export const FRAME_BYTES = 40;
export const RATE = 500;

// The same marker check as the vendor program: on a mismatch, hunt again from the next byte
const isFrame = (b, i) =>
  b[i] === 0x01 && b[i + 1] === 0xc0 && b[i + 12] === 0x02 && b[i + 13] === 0xc0 && b[i + 24] === 0x03 && b[i + 25] === 0xc0;

// push(Uint8Array chunk) returns the [I, II] counts of every frame completed so far;
// stats holds the frame count, the bytes skipped while syncing and the RA/LA/LL electrode-off flags of the last frame
export function createParser() {
  let rest = new Uint8Array(0);
  const stats = { frames: 0, skipped: 0, raOff: false, laOff: false, llOff: false };

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
      out.push([dv.getInt16(i + 6), dv.getInt16(i + 8)]); // I = LA − RA, II = LL − RA
      stats.raOff = (b[i + 3] & 0x60) !== 0;
      stats.laOff = (b[i + 2] & 0x20) !== 0;
      stats.llOff = (b[i + 2] & 0xc0) !== 0;
      stats.frames++;
      i += FRAME_BYTES;
    }
    rest = b.subarray(i);
    return out;
  }

  return { push, stats };
}

// Lead I needs RA and LA, lead II needs RA and LL (§8.3)
export function electrodeLine({ raOff, laOff, llOff }) {
  const off = [raOff && 'RA', laOff && 'LA', llOff && 'LL'].filter(Boolean);
  if (!off.length) return 'RA, LA and LL electrodes on.';
  const badI = raOff || laOff, badII = raOff || llOff;
  const leads = badI && badII ? 'Leads I and II' : badI ? 'Lead I' : 'Lead II';
  const names = off.length === 3 ? 'RA, LA and LL electrodes' : off.length === 2 ? `${off[0]} and ${off[1]} electrodes` : `${off[0]} electrode`;
  return `${leads} not valid: ${names} off.`;
}

// The vendor's resting-ECG filters at 500 Hz: protocol §12.2, the tables at 0x506CA0-0x506DF8 and 0x509B28 of BiomedicECG.exe
const HP = [[0.997781024102941, -1.99556204820588, 0.997781024102941], [1, -1.99555712434579, 0.995566972065975]];
const NF = [
  [0.951558090821252, -2.1284207536999, 2.85527558178394, -2.1284207536999, 0.951558090821252],
  [1, -2.18192506761969, 2.85407296314357, -2.07491643978012, 0.904318800282871],
];
const HF = [
  [0.987761389276826, -3.9510455571073, 5.92656833566095, -3.9510455571073, 0.987761389276826],
  [1, -3.97537191256092, 5.92641855596542, -3.92671919775679, 0.975672562146085],
];
const H40 = [
  -0.00812031626499363, 0.00279430037155961, 0.0363062486230826, 0.0960723789024121, 0.163761187856556, 0.209186200511384,
  0.209186200511384, 0.163761187856556, 0.0960723789024121, 0.0363062486230826, 0.00279430037155961, -0.00812031626499363,
];

// y[n] = Σ b[k]x[n−k] − Σ_{k≥1} a[k]y[n−k] from zero state, the vendor's forward pass (0x472760); a = [1] is the causal FIR
function direct(b, a = [1]) {
  const x = b.map(() => 0), y = a.map(() => 0); // x[k] = x[n−k], y[k] = y[n−k]
  return (v) => {
    x.pop();
    x.unshift(v);
    y.pop();
    y.unshift(0);
    for (let k = 0; k < b.length; k++) y[0] += b[k] * x[k];
    for (let k = 1; k < a.length; k++) y[0] -= a[k] * y[k];
    return y[0];
  };
}

// The user chose no display delay, so every stage runs forward only, one sample at a time, and T and ST are distorted.
// Subtracting the first sample replaces the vendor's trend removal, which needs the end of a record, and starts the chain
// settled on the electrode offset. Values stay in doubles where the vendor truncates to int16: under 1 count per stage.
export function createEcgFilter() {
  const stages = [direct(...HP), direct(...NF), direct(H40), direct(...HF)];
  let x0 = null;
  return (x) => stages.reduce((v, f) => f(v), x - (x0 ??= x));
}

// Stop first, as a tab closed without Disconnect leaves the module streaming; 5 ms keeps 01 and 09 in separate USB packets like the vendor's separate writes.
// No purge in Web Serial, so the marker hunt drops the start-up junk.
export const START = [[0x02], 100, [0x02], 100, [0x01], 100, [0x01], 5, [0x09]];
export const KEEP_ALIVE = [[0x09], 5, [0x09]];
export const STOP = [[0x02], 100, [0x02]];
export const KEEP_ALIVE_FRAMES = 30000; // 60 s, like the vendor program

// Every write goes through this one chain, so the stop bytes always follow any queued start or keep-alive
// and two writes never fight over the writer lock. Each array is one write and each number a wait in ms (protocol §6–§7):
// the vendor sends every command byte with its own WriteFile (protocol Appendix A 0x497270/0x497210/0x4972C0).
export function createSender(port) {
  let writes = Promise.resolve();
  return (...steps) => {
    writes = writes
      .then(async () => {
        const w = port.writable.getWriter();
        try {
          for (const s of steps) await (typeof s === 'number' ? new Promise((r) => setTimeout(r, s)) : w.write(new Uint8Array(s)));
        } finally {
          w.releaseLock();
        }
      })
      .catch(() => {}); // an unplug: the read loop reports it, and the chain must keep working for the next send
    return writes;
  };
}
