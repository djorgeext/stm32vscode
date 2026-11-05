"""Load an ECG + PCG recording made by Web/recorder.html: python3 -I Tools/load_recording.py <folder> [--json]

A recording is a folder of 00001.ecgpcg, 00002.ecgpcg, ... Concatenated in name order they form one log of
little-endian records, and a file only ever ends on a record boundary:

    offset 0   f64  t: performance.now() in ms, taken first thing after the read resolved, one clock for all kinds
    offset 8   u32  n: payload bytes
    offset 12  u8   kind
    offset 13  n payload bytes

    kind 1  PCG bytes as received: 24-byte frames [0x8000 sync][seq 0-32767, wrapping][10 int16 samples], cut anywhere
    kind 2  ECG bytes as received: 40-byte frames (Biomedic_ECG_USB_protocol.md section 8), cut anywhere
    kind 3  event, UTF-8 JSON, named by its field e: start, ecg-start-sent, keep-alive, read-error, lost, stop
    kind 4  filtered lead II upsampled to 1000 Hz, f32, continuing the previous kind 4 record, same t as its kind 2 record

load(folder) returns the arrays below and never raises on a damaged recording: what it cannot use goes in errors.

    pcg, pcg_index                    samples as sent, stale first frame removed, and 10 * unwrapped_seq + k,
                                      counted from 0 at the first live frame, so the index jumps across a drop
    pcg_frame_index, pcg_frame_t      index of each frame's first sample, and t of the chunk that held its last byte
    ecg_i, ecg_ii, ecg_a1, ecg_b1     raw counts and status bytes per frame
    ecg_frame_t                       t of the chunk that held each frame's last byte
    ecg_1k                            ecg_1k[2m] is frame m, and an odd index is halfway between two frames
    ecg_resync                        (frame, bytes): each marker hunt after lock, and the first frame after it
    pcg_drops                         frames missing by seq
    events                            (t, dict)
    missing_segments, errors          gaps in the file numbering, and what could not be read

The parsers copy the rules of createParser in Web/pcg_parser.js and Web/ecg_dsp.js. A PCG frame counts only when the next
frame's header follows it, so the last frame of a recording is not used.

summary(rec) holds counts and rates, no samples, and clean_stop is false when the stop event is missing, which is the only
sign of a lost last file. Its straight line through t and the sample index is a report, not a
correction: the ECG and PCG clocks drift apart and this file corrects nothing. The fixed offset between the ECG and PCG
paths is an unmeasured estimate of about +-3 ms, and no fit here can show it.
"""
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np

PCG, ECG, EVENT, ECG_1K = 1, 2, 3, 4
HEADER = struct.Struct('<dIB')
PCG_FRAME, ECG_FRAME = 24, 40


def read_records(folder, errors):
    """Returns the (t, kind, payload) records, the segment count and the numbers missing from the sequence."""
    files = {}
    for p in Path(folder).glob('*.ecgpcg'):
        if p.stem.isdigit():
            files[int(p.stem)] = p
        else:
            errors.append(f'{p.name}: not a numbered segment')
    if not files:
        errors.append('no segment files')
    records = []
    for k in sorted(files):
        name = files[k].name
        try:
            data = files[k].read_bytes()
        except OSError as e:
            errors.append(f'{name}: {e}')
            continue
        i = 0
        while i < len(data):
            n = HEADER.unpack_from(data, i)[1] if i + HEADER.size <= len(data) else None
            if n is None or i + HEADER.size + n > len(data):
                errors.append(f'{name}: the record at byte {i} overruns the file')
                break
            t, _, kind = HEADER.unpack_from(data, i)
            if math.isfinite(t):
                records.append((t, kind, data[i + HEADER.size : i + HEADER.size + n]))
            else:
                errors.append(f'{name}: the record at byte {i} has no valid time')
            i += HEADER.size + n
    return records, len(files), sorted(set(range(1, max(files, default=0) + 1)) - set(files))


def stream(records, kind):
    """The bytes of one stream, with each chunk's end offset, t and size."""
    chunks = [(t, p) for t, k, p in records if k == kind]
    sizes = np.array([len(p) for _, p in chunks], dtype=np.int64)
    return np.frombuffer(b''.join(p for _, p in chunks), np.uint8), np.cumsum(sizes), np.array([t for t, _ in chunks], np.float64), sizes


def walk(ok, frame):
    """Greedy, like the parsers: a valid frame moves on by a whole frame, a mismatch by one byte. Returns (start, skipped) pairs."""
    found, i = [], 0
    for c in np.flatnonzero(ok).tolist():
        if c >= i:
            found.append((c, c - i))
            i = c + frame
    return found, i


def pcg_frames(b, ends, ts):
    sync = (b[:-3] == 0) & (b[1:-2] == 0x80) & (b[3:] < 0x80)
    seq = b[2:-1].astype(np.int32) | (b[3:].astype(np.int32) << 8)
    found = walk(sync[:-PCG_FRAME] & sync[PCG_FRAME:] & (seq[:-PCG_FRAME] != seq[PCG_FRAME:]), PCG_FRAME)[0]
    starts = np.array([c for c, _ in found], dtype=np.int64)
    gaps = (np.diff(seq[starts].astype(np.int64)) - 1) & 0x7FFF
    live = starts[1:]  # the first frame was queued while the port was closed, so neither it nor its gap counts
    index = 10 * np.cumsum(np.r_[0, gaps[1:] + 1], dtype=np.int64)[: len(live)]
    at = (live[:, None] + np.arange(4, PCG_FRAME)).ravel()
    return {
        'pcg': np.frombuffer(b[at].tobytes(), '<i2').astype(np.int16),
        'pcg_index': (index[:, None] + np.arange(10)).ravel(),
        'pcg_frame_index': index,
        'pcg_frame_t': ts[np.searchsorted(ends, live + PCG_FRAME)],
        'pcg_drops': int(gaps[1:].sum()),
    }


def ecg_frames(b, ends, ts):
    n = max(len(b) - ECG_FRAME + 1, 0)
    ok = np.ones(n, bool)
    for offset, value in ((0, 1), (1, 0xC0), (12, 2), (13, 0xC0), (24, 3), (25, 0xC0)):
        ok &= b[offset : n + offset] == value
    found, end = walk(ok, ECG_FRAME)
    resync = [(m, skipped) for m, (_, skipped) in enumerate(found) if m and skipped]
    if found and n > end:
        resync.append((len(found), n - end))  # still hunting when the stream ended, as the parser's skipped count has it
    s = np.array([c for c, _ in found], dtype=np.int64)
    be16 = lambda o: np.frombuffer(b[(s[:, None] + [o, o + 1]).ravel()].tobytes(), '>i2').astype(np.int16)
    return {
        'ecg_i': be16(6),
        'ecg_ii': be16(8),
        'ecg_a1': b[s + 2],
        'ecg_b1': b[s + 3],
        'ecg_frame_t': ts[np.searchsorted(ends, s + ECG_FRAME)],
        'ecg_resync': resync,
    }


def load(folder):
    errors = []
    records, segments, missing = read_records(folder, errors)
    events = []
    for t, kind, payload in records:
        if kind == EVENT:
            try:
                event = json.loads(payload)
                if not isinstance(event, dict):
                    raise ValueError('not an object')
                events.append((t, event))
            except ValueError as e:
                errors.append(f'event at t {t}: {e}')
        elif kind not in (PCG, ECG, ECG_1K):
            errors.append(f'record at t {t}: unknown kind {kind}')
    pcg_bytes, pcg_ends, pcg_ts, pcg_sizes = stream(records, PCG)
    ecg_bytes, ecg_ends, ecg_ts, ecg_sizes = stream(records, ECG)
    y = b''.join(p for _, k, p in records if k == ECG_1K)
    times = [t for t, _, _ in records]
    return {
        **pcg_frames(pcg_bytes, pcg_ends, pcg_ts),
        **ecg_frames(ecg_bytes, ecg_ends, ecg_ts),
        'ecg_1k': np.frombuffer(y[: len(y) // 4 * 4], '<f4').astype(np.float32),
        'events': events,
        'missing_segments': missing,
        'errors': errors,
        'segments': segments,
        'seconds': (max(times) - min(times)) / 1000 if times else 0.0,
        'pcg_chunk_bytes': pcg_sizes,
        'ecg_chunk_bytes': ecg_sizes,
    }


def line(t, index):
    """Plain least squares of index against t: the rate per second, and the residuals in ms."""
    if len(t) < 2 or t.min() == t.max():
        return None, np.zeros(0)
    s, n = (t - t[0]) / 1000, (index - index[0]).astype(np.float64)
    hz, a = np.polyfit(s, n, 1)
    return float(hz), (n - a - hz * s) / hz * 1000


def ppm(ecg_hz, pcg_hz):
    return None if ecg_hz is None or pcg_hz is None else ((ecg_hz / 500) / (pcg_hz / 1000) - 1) * 1e6


def spread(residual):
    r = np.abs(residual)
    return {'p50': float(np.percentile(r, 50)), 'p99': float(np.percentile(r, 99)), 'max': float(r.max())} if len(r) else None


def sizes(n):
    return {'median': float(np.median(n)), 'max': int(n.max())} if len(n) else None


def summary(rec):
    named = lambda name: [(t, e) for t, e in rec['events'] if e.get('e') == name]
    listed = lambda name: [{'t': t, 'stream': e.get('stream'), 'message': e.get('message')} for t, e in named(name)]
    sent = named('ecg-start-sent')
    since = sent[0][0] + 3000 if sent else -math.inf

    # ECG frames have no counter, so m is only continuous inside a run between resyncs. PCG indices are exact across drops
    edges = [0, *(m for m, _ in rec['ecg_resync']), len(rec['ecg_frame_t'])]
    first, last = max(zip(edges, edges[1:]), key=lambda run: run[1] - run[0])
    ecg_t, ecg_m = rec['ecg_frame_t'][first:last], np.arange(first, last)
    pcg_t, pcg_n = rec['pcg_frame_t'], rec['pcg_frame_index']

    def rates(lo, hi):
        e, p = (ecg_t >= lo) & (ecg_t <= hi), (pcg_t >= lo) & (pcg_t <= hi)
        return line(ecg_t[e], ecg_m[e]), line(pcg_t[p], pcg_n[p])

    window = ecg_t[ecg_t >= since]
    lo, hi = (window[0], window[-1]) if len(window) else (since, math.inf)
    mid = (lo + hi) / 2
    (ecg_hz, ecg_residual), (pcg_hz, pcg_residual) = rates(lo, hi)
    (ecg_a, _), (pcg_a, _) = rates(lo, mid)
    (ecg_b, _), (pcg_b, _) = rates(mid, hi)

    return {
        'note': next((e.get('note') for _, e in named('start')), None),
        'seconds': rec['seconds'],
        'segments': rec['segments'],
        'missing_segments': rec['missing_segments'],
        'errors': rec['errors'],
        'pcg_frames': len(pcg_t),
        'pcg_drops': rec['pcg_drops'],
        'ecg_frames': len(rec['ecg_frame_t']),
        'ecg_resyncs': len(rec['ecg_resync']),
        'ecg_skipped_after_lock': sum(n for _, n in rec['ecg_resync']),
        'ecg_1k_ok': len(rec['ecg_1k']) == 2 * len(rec['ecg_frame_t']) - 1,
        'lost': listed('lost'),
        'read_errors': listed('read-error'),
        'keep_alives': len(named('keep-alive')),
        'clean_stop': bool(named('stop')),  # the numbering cannot show a lost last file, so a lost tail shows here
        'pcg_hz': pcg_hz,
        'ecg_frame_hz': ecg_hz,
        'relative_ppm': ppm(ecg_hz, pcg_hz),
        'relative_ppm_halves': [ppm(ecg_a, pcg_a), ppm(ecg_b, pcg_b)],
        'residual_ms': {'pcg': spread(pcg_residual), 'ecg': spread(ecg_residual)},
        'chunk_bytes': {'pcg': sizes(rec['pcg_chunk_bytes']), 'ecg': sizes(rec['ecg_chunk_bytes'])},
    }


if __name__ == '__main__':
    folders = [a for a in sys.argv[1:] if a != '--json']
    if len(folders) != 1:
        sys.exit('usage: python3 -I Tools/load_recording.py <folder> [--json]')
    report = summary(load(folders[0]))
    if '--json' in sys.argv:
        print(json.dumps(report))
    else:
        for key, value in report.items():
            print(f'{key}: {value}')
