# PCG and ECG acquisition: how they work (2026-11-03)

Both viewers are browser pages that read a USB serial port with Web Serial, so they need Chrome or Edge. Both are in
`Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web/`. Serve that folder from the repo root:

`python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8001`

Port 8000 is used by `strategy_app.py` on this PC.

## PCG (phonocardiogram): WeAct STM32H750 board

- **Acquisition, on the board:** the microphone front end feeds PA6, which must stay between 0 and 3.3 V, biased to about 1.65 V.
  - ADC1 samples it at 48 kHz and 16 bit, triggered by TIM3, with DMA into AXI SRAM.
  - The firmware band-passes it from 20 to 200 Hz (4th-order Butterworth high-pass and low-pass) at 48 kHz, and keeps every 48th sample, so 1000 samples/s leave the board.
- **Link:** USB CDC, `0483:5740`, at about 2.4 KB/s.
  - One 24-byte frame every 10 ms: sync `0x8000`, a sequence number, then 10 int16 samples.
  - A gap in the sequence numbers means a frame was dropped.
- **PC page, `index.html`:** draws the last 5 s in mV, with the sample rate and the dropped-frame count.
  - Start audio plays the sound on the PC output, upsampled to 48 kHz, about 100 ms behind the trace.
- **Verified:** firmware, flashing and the 1000 Hz stream on the real board, with 0 drops (plan steps S8–S10); audio buffer logic (6a–6b).
- **Open:**
  - Plan step 6c, the headphone listening check, is not done.

## ECG: Biomedic ECG module

- **Acquisition, on the module:** the module's own amplifier measures the electrodes RA, LA and LL. RL is the reference.
  - It sends 40-byte frames at 500 frames/s: lead I (LA − RA), lead II (LL − RA) and the electrode-off flags.
- **Link:** MCP2200 USB-UART bridge, `04d8:00df`, at 230400 baud.
  - Connect sends stop, then start (`01`, `01`, `09`), one byte per write as the vendor program does.
  - A keep-alive (`09 09`) goes out every 60 s, and Disconnect sends stop (`02 02`).
- **PC page, `ecg.html` with `ecg_dsp.js`:** shows leads I and II, each with its own scale in ADC counts; µV per count is unknown.
  - Filters: the vendor's chain, always on and forward only, so there is no delay: 0.25 Hz high-pass, 50 + 100 Hz notch, 40 Hz low-pass, 0.75 Hz baseline filter.
  - Electrode warnings say which lead is not valid.
- **Verified:** on the real module with electrodes on, plan steps E1–E7, and 11/11 tests in `node Tests/ecg_dsp_test.mjs`.
- **Limits:**
  - Forward-only filtering distorts T waves and ST segments: use it for rhythm and QRS only.
  - Always click Disconnect before closing the tab, because a closed tab leaves the module streaming.
  - If the module ignores commands, replug it.
  - After using pyserial, run `stty -F /dev/ttyACM0 min 1 time 0`.

## Recorder: ECG lead II and PCG together

- **PC page, `recorder.html` with `recorder.js`:** one Start opens both ports and starts the module, and every chunk from each port goes to disk with a host timestamp. Both traces show live.
  - Each recording is a new folder of numbered files, in a folder you choose outside the repo, because recordings are health data.
- **Stored:** both raw streams as received, plus lead II after the filters, upsampled to 1000 Hz by linear interpolation.
- **Offline:** `Tools/load_recording.py` reads a recording and prints a summary with no samples.
- **Limits:**
  - ECG and PCG are both nominally 1000 Hz, but each runs on its own clock, so sample `j` of one is not simultaneous with sample `j` of the other. Correct that offline, as the project `README.md` says.
  - The fixed offset between the ECG and PCG paths is an unmeasured estimate of about ±3 ms.
  - Stored lead II is distorted in T and ST and about 10 ms late at the QRS. The raw counts are not.

Details: `ECG_viewer_status.md`, `PLAN.md` and the project `README.md`.
