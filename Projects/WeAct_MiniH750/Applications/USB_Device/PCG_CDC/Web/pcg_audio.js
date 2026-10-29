// AudioWorklet player for the PCG stream: 480-sample int16 frames posted by the page, mono float out.
// The same module is the worklet (registerProcessor) and the node test's import (createPlayer).
export const RATE = 48000;
export const TARGET = 4800; // prime to 100 ms
export const LOW = 3600; // keep the fill in 75-125 ms with one slip per quantum
export const HIGH = 6000;
export const MAX = 14400; // above 300 ms the audio thread has stalled: fade out and re-prime
export const CAP = 48000; // 1 s ring, the oldest sample is dropped when full
export const FADE = 480; // 10 ms fade in and out

const PRIME = 0, PLAY = 1, STOP = 2;

// push(Int16Array) queues samples; pull(Float32Array out, volume) fills out with
// clamp(sample / 32768 * fade * volume, -1, 1), volume holding 1 or out.length values
export function createPlayer() {
  const ring = new Int16Array(CAP);
  const stats = { fill: 0, underruns: 0, slips: 0 };
  let r = 0, n = 0, f = 0, state = PRIME;
  const drop = (k) => {
    r = (r + k) % CAP;
    n -= k;
  };

  function push(s) {
    for (let i = 0; i < s.length; i++) {
      if (n === CAP) drop(1);
      ring[(r + n) % CAP] = s[i];
      n++;
    }
    stats.fill = n;
  }

  function pull(out, volume) {
    const q = out.length;
    // Fading out needs FADE real samples, and every PLAY quantum leaves at least that many
    if (state === PLAY && (n < FADE + q || n > MAX)) {
      if (n < FADE + q) stats.underruns++;
      state = STOP;
    }
    // shortcut: correct for quanta up to TARGET - FADE samples (Web Audio uses 128), prime to FADE + q if larger ones appear
    if (state === PRIME && n >= TARGET) {
      drop(n - TARGET);
      state = PLAY;
    }
    // One skipped or repeated sample per quantum absorbs up to 1/q of clock drift
    let hold = false;
    if (state === PLAY && (n > HIGH || n < LOW)) {
      if (n > HIGH) drop(1);
      else hold = true;
      stats.slips++;
    }
    for (let i = 0; i < q; i++) {
      let s = 0;
      if (state !== PRIME) {
        s = ring[r];
        if (state === PLAY) {
          if (f < FADE) f++;
        } else if (f > 0) f--;
        if (hold) hold = false;
        else drop(1);
        if (state === STOP && f === 0) {
          state = PRIME;
          // The leftover is older than the gap that follows it, so splicing it onto new samples would click
          if (n < TARGET) drop(n);
        }
      }
      out[i] = Math.min(1, Math.max(-1, (s / 32768) * (f / FADE) * (volume.length > 1 ? volume[i] : volume[0])));
    }
    stats.fill = n;
  }

  return { push, pull, stats };
}

if (typeof registerProcessor === 'function') {
  registerProcessor(
    'pcg-player',
    class extends AudioWorkletProcessor {
      static parameterDescriptors = [{ name: 'volume', defaultValue: 0.1, minValue: 0, maxValue: 1 }];

      constructor() {
        super();
        this.player = createPlayer();
        this.played = 0;
        this.port.onmessage = (e) => this.player.push(e.data);
      }

      process(inputs, outputs, parameters) {
        const out = outputs[0][0];
        this.player.pull(out, parameters.volume);
        if ((this.played += out.length) >= RATE) {
          this.played -= RATE;
          this.port.postMessage(this.player.stats);
        }
        return true;
      }
    },
  );
}
