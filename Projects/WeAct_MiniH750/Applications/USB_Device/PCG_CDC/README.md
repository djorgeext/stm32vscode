# PCG_CDC (WeAct MiniSTM32H750)

Samples a PCG signal on PA6 (ADC1 channel 3, 16 bit) at 48 kHz, band-passes it 20–200 Hz on the
STM32H750 (4th-order Butterworth high-pass + 4th-order low-pass, double precision), keeps every 48th
filtered sample and streams the result at 1000 samples/s over USB CDC (USB-C connector, VID:PID
`0483:5740`, product "WeAct H750 PCG"). Do not analyse above 200 Hz: there the 1000 Hz signal holds only
the filter's skirt and alias.

- Clock: HSE 25 MHz, SYSCLK 240 MHz, HCLK 120 MHz, APB1–4 60 MHz, USB 48 MHz from PLL1Q.
- Sampling: TIM3 TRGO (120 MHz / 2500) triggers ADC1; DMA1 stream 0 fills a 960-sample circular buffer in AXI SRAM.
- Wire format, little-endian int16, one 24-byte frame every 10 ms (2400 B/s):
  `[0x8000 sync][seq 0–32767, wrapping][10 filtered samples]`.
  Samples are filtered ADC counts clamped to ±32767. A gap in `seq` means a frame was dropped because the host was not reading.
- Sample index: sample `k` of a frame is number `10·unwrapped_seq + k` at 1000 Hz, which stays exact across a dropped frame.

PA6 must stay between 0 and 3.3 V, biased to about 1.65 V. Anti-alias filtering is the front end's job.

## Build

From this folder (Unix Makefiles, so ninja is not needed):

```
cmake --preset Debug && cmake --build --preset Debug
arm-none-eabi-size build/Debug/PCG_CDC.elf
```

## Filter self-check (host gcc)

```
gcc -O2 -Wall -IInc Src/pcg_filter.c Tests/pcg_filter_test.c -lm -o /tmp/pcg_filter_test && /tmp/pcg_filter_test
```

## Browser viewer

`Web/index.html` reads the 1000 samples/s stream with Web Serial (Chrome or Edge) and draws the last 5 s, scaled to
the largest sample in view (mV = counts × 3300 / 65536), with the measured sample rate and the dropped-frame count.
Start audio plays the stream on the PC's audio output (AudioWorklet `Web/pcg_audio.js`) about 100 ms behind the
trace, fading in from silence at 10 % volume, so turn the system volume down before the first start. The player runs
at 48 kHz, so the page upsamples by 48 with linear interpolation (`Web/upsample.js`), and a 300 Hz low-pass removes
the interpolator's images.
From this folder, check the parser, the upsampler and the audio player:

```
node Tests/pcg_parser_test.mjs
node Tests/upsample_test.mjs
node Tests/pcg_audio_test.mjs
```

Then, from the repo root, serve the page and open http://localhost:8000:

```
python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8000
```

## ECG viewer (Biomedic ECG module)

`Web/ecg.html` reads the Biomedic ECG module's USB serial port (MCP2200, VID:PID `04d8:00df`, 230400 baud) with
Web Serial and draws leads I (LA − RA) and II (LL − RA) for the last 5 s at 500 samples/s, one trace each with its
own scale. It also shows the frame rate, the bytes skipped while syncing and whether the RA, LA and LL electrodes
are on. Lead II needs the LL electrode (left leg): without it the module reports LL off, the page says "Lead II not
valid: LL electrode off." and the lead II trace shows no heartbeat. `Web/ecg_dsp.js` filters on the PC with the vendor
program's resting-ECG filters (protocol §12), always on: a 0.25 Hz Butterworth high-pass, a 50 + 100 Hz notch, a 40 Hz
FIR low-pass and a 0.75 Hz baseline filter. They run forward only, one sample at a time, so the trace has no delay.
Unlike the vendor's zero-phase filtering, this shifts slow waves, so T waves and ST segments differ from the vendor's
program. The first ~2 s after Connect show the module's input settling. The scale is in ADC counts, because the module's µV per count is not known.
The protocol is described in `Biomedic_ECG_USB_protocol.md` at the repo root. From this folder, check the parser and the filters:

```
node Tests/ecg_dsp_test.mjs
```

Then, from the repo root, serve the page and open http://localhost:8000/ecg.html:

```
python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8000
```

Click Disconnect before closing the tab: it sends the module's stop command, and closing the tab does not.

Troubleshooting: if Connect reports "The device has been lost." right away, another tool (pyserial, including the reference script in `Biomedic_ECG_USB_protocol.md` §11) left the port at `min 0`. Run `stty -F /dev/ttyACM0 min 1 time 0`, or replug the module.

If Disconnect does not stop the module (it keeps streaming), or Connect shows frames but the module ignores its commands, unplug the module and plug it back in. It is the only known recovery. Then wait until `fuser /dev/ttyACM0` prints nothing before you click Connect.

## Synchronized recorder

`Web/recorder.html` (Chrome or Edge) records ECG lead II and PCG to disk at a nominal 1000 Hz each and shows both live.
One Start button opens both USB ports, starts both read loops in the same tick and sends the module its start command.
From then on every chunk from each port is written with a `performance.now()` stamp, one clock for both streams. PCG is
logged at once. ECG frames follow about 0.5 s later and are settled about 2 s after that, so "the same time" means that
both records cover the same interval on one host clock, not that they share a first sample. Trim the start offline.

> ECG and PCG are both nominally 1000 Hz, but each runs on its own clock (ECG: the module, PCG: the STM32). Sample j of one is not simultaneous with sample j of the other. Align them offline with each stream's sample index and the host timestamps. The fixed offset between the two paths is not measured: about ±3 ms, an estimate.

From this folder, check it, then, from the repo root, serve the page and open http://localhost:8001/recorder.html
(always `localhost`, because Chrome's port grants belong to the origin):

```
node Tests/recorder_test.mjs
python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8001
```

Click Allow device once per device if the page does not find it. The first Start asks for a folder: make a new one
outside the repo, because recordings are health data. Later Starts use the same folder. Each recording is a new folder
`ecgpcg-YYYYMMDD-HHMMSS` in it, and the page says which while it records and after it has saved.

Always end with Stop: it stops the module, drains that command and writes the last file. If a save fails, the data stays
in memory, the page warns, and the save is tried again at the next file and at Stop. If it still fails, the button reads
Retry save, so keep the tab open and click it. Files go to disk every 256 KiB (about every 0.9 s), so a crash or a killed tab loses
about the last second, and it leaves the module streaming until the next Start. A crash can also leave a `.crswap`
file in the folder, which is health data too: delete it.

### Recording format

A recording is a folder of `00001.ecgpcg`, `00002.ecgpcg`, … Concatenated in name order, they form one log of
little-endian records, and a file only ever ends on a record boundary.

| Offset | Type | Field |
|---|---|---|
| 0 | f64 | `t`: `performance.now()` in ms, taken first thing after the read resolved. One clock for all kinds |
| 8 | u32 | `n`: payload bytes |
| 12 | u8 | `kind` |
| 13 | n bytes | payload |

| `kind` | Payload |
|---|---|
| 1 | PCG bytes exactly as received: 24-byte frames, cut wherever the chunk was cut |
| 2 | ECG bytes exactly as received: 40-byte frames, cut wherever the chunk was cut |
| 3 | Event, UTF-8 JSON |
| 4 | Filtered, upsampled lead II as f32, continuing the previous kind 4 record. Same `t` as the kind 2 record it came from |

| Event `e` | When | Other fields |
|---|---|---|
| `start` | First record | `format: 1`, `wall` (`Date.now()`), `note`, `pcg_hz: 1000`, `ecg_frame_hz: 500`, `ecg_1k_hz: 1000` |
| `ecg-start-sent` | After the last start byte is written | |
| `keep-alive` | When queued | `frames` |
| `read-error` | A read failed but the port lives: bytes may be missing here | `stream`, `message` |
| `lost` | A stream ended without Stop | `stream`, `message` |
| `stop` | Last record of a clean end | |

Stored lead II (kind 4) is distorted in T and ST and delayed about 10 ms at the QRS, because it went through the
forward-only filters. The raw counts (kind 2) are not. `ecg_1k[2m]` is frame `m`, and an odd index is halfway between two
frames, by linear interpolation.

### Loader and offline alignment

`Tools/load_recording.py` needs numpy, and it reads a damaged recording without raising:

```
python3 -I -B Tools/load_recording.py <folder> [--json | --export]
```

`--export` prints the summary, then writes `<folder>-export/` beside the recording, never in it: `pcg.npy` (float32, `pcg`, filtered ADC counts, × 3300/65536 gives mV at PA6, nominal 1000 Hz, STM32 clock), `ecg_raw.npy` (float32, `ecg_ii`, unfiltered counts, µV per count unknown, nominal 500 Hz, module clock), `ecg_filtered.npy` (float32, `ecg_1k` as stored, in counts, nominal 1000 Hz, T and ST distorted, QRS about 10 ms late) and `timestamps.npz` (`pcg_frame_t` and `ecg_frame_t`, float64 host ms when the chunk with the frame's last byte arrived, `pcg_frame_index`, int64, and `ecg_resync`, int64 rows of `(frame, bytes)`, shape (0, 2) when empty). PCG position `p` is sample `pcg_frame_index[p // 10] + p % 10`, stamped `pcg_frame_t[p // 10]`, so after a dropped frame `p` alone is wrong. ECG frame `m` is `ecg_raw[m]`, `ecg_filtered[2m]` and `ecg_frame_t[m]`, an odd `ecg_filtered` index is halfway between two frames, and `m` counts time only between resyncs: a row `(m, bytes)` means `bytes` were skipped just before frame `m` (`m` equal to the frame count: the stream ended still hunting). When the summary shows `ecg_1k_ok` False (a recording with a hole), `ecg_filtered[2m]` no longer equals frame `m` past the hole, so use `ecg_raw` and `ecg_frame_t` there. Every sample is read back before the folder gets the `-export` name, and a mismatch exits non-zero and leaves it as `<folder>-export.partial`. A damaged recording exports as `load()` gives it, with its problems in the summary, a folder with no segments is refused, and if either name already exists nothing happens. Lead I and the rest of each ECG frame, electrode flags, per-chunk stamps and events stay only in the small files: keep the recording folder.

The summary holds no samples: counts, gaps, rates and residuals. `load(folder)` in the same file returns the
arrays (`pcg`, `pcg_index`, `pcg_frame_t`, `ecg_i`, `ecg_ii`, `ecg_frame_t`, `ecg_1k`, `ecg_resync`, `events`, …). Gaps stay
visible: `pcg_drops` counts frames missing by `seq`, `ecg_resync` lists each marker hunt, `missing_segments` lists holes
in the file numbering, and `clean_stop` is false when the `stop` event is missing, the only sign of a lost last file.
The summary's rates are a report, not a drift correction. To align the streams offline:

1. Fit `t = a + b·n` per stream, skipping the first 3 s and splitting at `ecg_resync` and `lost`.
2. `pcg_index` and `j/2` give each sample's host time.
3. Resample one stream onto the other.
4. Allow for the filter delays. On the board, PCG is delayed 3.2 ms at 100–200 Hz, 5.7 ms at 50 Hz, 8.0 ms at 40 Hz,
   14.1 ms at 30 Hz and 31.5 ms at 20 Hz, so this is a phase correction, not one shift. Stored lead II is delayed 10 ms at
   the QRS and 12–17 ms over 10–40 Hz. The raw counts have neither delay.
5. The fixed offset between the two paths stays an unmeasured estimate of about ±3 ms.

In step 1, use a piecewise or rolling fit of sample index against host time, not one straight line for a whole recording: the first real recording drifted −503 to −524 ppm across four windows, about 31 ms/min, with ECG slow against PCG. Run a laptop on a charged battery with the charger unplugged while recording, because the body is connected to the PC through USB.

## Flash

From the repo root, with the Atmel-ICE on SWD (see `PLAN.md` step 4 for the safe-flash checklist):

```
openocd -f openocd.cfg -c "program Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/build/Debug/PCG_CDC.elf verify reset exit"
```
