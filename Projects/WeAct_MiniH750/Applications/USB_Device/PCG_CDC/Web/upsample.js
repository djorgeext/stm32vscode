// Linear upsampler: createUpsampler(L) returns (x) => array of the new output samples.
// The first sample gives one output and each later one gives L, and no output waits for a later input.
export function createUpsampler(L) {
  let prev;
  return (x) => {
    if (prev === undefined) {
      prev = x;
      return [x];
    }
    const out = [];
    for (let i = 1; i < L; i++) out.push(prev + ((x - prev) * i) / L);
    out.push(x); // not prev + (x - prev), which can round away from x
    prev = x;
    return out;
  };
}
