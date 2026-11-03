# PCG_CDC (WeAct MiniSTM32H750)

Samples a PCG signal on PA6 (ADC1 channel 3, 16 bit) at 48 kHz, band-passes it 20–200 Hz on the
STM32H750 (4th-order Butterworth high-pass + 4th-order low-pass, double precision) and streams the
result over USB CDC (USB-C connector, VID:PID `0483:5740`, product "WeAct H750 PCG").

- Clock: HSE 25 MHz, SYSCLK 240 MHz, HCLK 120 MHz, APB1–4 60 MHz, USB 48 MHz from PLL1Q.
- Sampling: TIM3 TRGO (120 MHz / 2500) triggers ADC1; DMA1 stream 0 fills a 960-sample circular buffer in AXI SRAM.
- Wire format, little-endian int16, one 964-byte frame every 10 ms:
  `[0x8000 sync][seq 0–32767, wrapping][480 filtered samples]`.
  Samples are filtered ADC counts clamped to ±32767. A gap in `seq` means a frame was dropped because the host was not reading.

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

`Web/index.html` reads the stream with Web Serial (Chrome or Edge) and draws the last 5 s, scaled to the
largest sample in view (mV = counts × 3300 / 65536), with the measured sample rate and the dropped-frame count.
Start audio plays the stream on the PC's audio output (AudioWorklet `Web/pcg_audio.js`) about 100 ms behind the
trace, fading in from silence at 10 % volume, so turn the system volume down before the first start.
From this folder, check the parser and the audio player:

```
node Tests/pcg_parser_test.mjs
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

## Flash

From the repo root, with the Atmel-ICE on SWD (see `PLAN.md` step 4 for the safe-flash checklist):

```
openocd -f openocd.cfg -c "program Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/build/Debug/PCG_CDC.elf verify reset exit"
```
