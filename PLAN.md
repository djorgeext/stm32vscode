# PLAN: PCG viewer (WeAct MiniSTM32H750)

**Goal:** sample a PCG signal on PA6 at 48 kHz, band-pass it 20–200 Hz on the STM32H750, stream it over USB CDC, draw it live in the browser and play it on the PC's audio output for headphones.

## Decisions

- **Project folder:** `Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/` (`Inc/`, `Src/`, `Web/`, `Tests/`), following ST's `Applications/USB_Device/CDC_Standalone` layout and the BluePill CDC project. It is a standalone CMake project, because the root `CMakeLists.txt` hard-codes F1 flags, includes and startup.
- **Shared files go where the repo keeps them:** H7 HAL in `Drivers/STM32H7xx_HAL_Driver`, H7 device headers in `Drivers/CMSIS/Device/ST/STM32H7xx`, startup and linker script in `GCC/`, CPU flags in `cmake/stm32h7.cmake` (the H7 twin of `cmake/stm32fx.cmake`), toolchain from `cmake/toolchain-arm-none-eabi.cmake`.
- **USB stack:** the repo's `Middlewares/ST/STM32_USB_Device_Library` (V2.5.3, HAL-independent). The glue files are adapted from `Projects/BluePill/Examples/USB/CDC` to the H7 OTG_FS core (PA11/PA12, `USB2_OTG_FS`, no VBUS sensing, as in WeAct's `05-DCMI_UVC`). `HAL_PWREx_EnableUSBVoltageDetector()` runs before `USBD_Init`, as in ST's `CDC_Standalone/Src/main.c` and at the end of WeAct's `SystemClock_Config`.
- **Clock:** WeAct's own H750 USB PLL: HSE 25 MHz crystal, PLL1 M=5 (5 MHz, `RCC_PLL1VCIRANGE_2`, wide VCO) N=96 (VCO 480 MHz), P=2 → SYSCLK 240 MHz, Q=10 → USB 48 MHz, R=2. HCLK = SYSCLK/2 = 120 MHz, **APB1–APB4 = HCLK/2 = 60 MHz**. VOS1 with `FLASH_LATENCY_2` (RM0433 Table 17: VOS1 needs 1 WS up to 140 MHz; the second is margin). Do not copy WeAct's dividers: it runs VOS2 with 1 WS (Table 17 allows 1 WS only up to 110 MHz in VOS2) and all APBs at 120 MHz (DS12556 Table 110: fPCLK max 100 MHz in VOS1, 75 MHz in VOS2). `HAL_RCCEx_PeriphCLKConfig` sets `UsbClockSelection = RCC_USBCLKSOURCE_PLL` and `AdcClockSelection = RCC_ADCCLKSOURCE_CLKP`. Without it, the USB kernel clock stays off after reset and the ADC stays on PLL2P, which is not running. HSI stays on (reset default) because per_ck comes from it.
- **Sample rate:** 48 kHz, as the user asked. TIM3 is on APB1 with a ÷2 prescaler, so its kernel clock is 2 × 60 = 120 MHz (RM0433 Table 57, TIMPRE=0). PSC=0 and ARR=2499 give 120 MHz / 2500 = 48 000.0 Hz exactly, locked to the crystal. TRGO = update event.
- **ADC:** ADC1 channel 3 (PA6 = `ADC12_INP3`, LQFP100 pin 30, checked in the datasheet), 16-bit, single-ended, `ADC_EXTERNALTRIG_T3_TRGO` rising edge, `ConversionDataManagement = ADC_CONVERSIONDATA_DMA_CIRCULAR`, `Overrun = ADC_OVR_DATA_OVERWRITTEN`, sample time `ADC_SAMPLETIME_64CYCLES_5`. The ADC clock is per_ck (HSI 64 MHz) with `ADC_CLOCK_ASYNC_DIV4`. Rev Y runs it at 16 MHz (limit 20 MHz with BOOST=0). Rev V halves it internally to 8 MHz (limit 12.5 MHz with BOOST=01). `HAL_ADC_Init` sets BOOST from the revision. One conversion takes 64.5 + 8.5 = 73 cycles, which is 4.6 µs (rev Y) or 9.1 µs (rev V), well inside the 20.8 µs trigger period. `HAL_ADCEx_Calibration_Start(&hadc1, ADC_CALIB_OFFSET_LINEARITY, ADC_SINGLE_ENDED)` runs after `HAL_ADC_Init` and before `HAL_ADC_Start_DMA`. DMA1 stream 0 (`DMA_REQUEST_ADC1`, half-word on both sides, circular) fills a 960-sample buffer. Each half (480 samples = 10 ms) raises the half or full callback, and the callbacks only flag which half is ready.
- **DMA RAM:** DMA1 cannot reach DTCM, so the linker script places all RAM in AXI SRAM (`0x24000000`, 512 KB). The D-cache stays off, so DMA buffers need no cache maintenance. Do not copy the blink project's `SCB_EnableDCache()`.
- **Filter:** 4th-order Butterworth high-pass at 20 Hz followed by a 4th-order Butterworth low-pass at 200 Hz: 4 biquads in transposed direct form II, in double precision. The poles sit at |z| ≈ 0.999. A float32 simulation of this cascade on a 100 Hz tone around mid-scale gives about 6 counts RMS (20 peak) of round-off error, and the M7 FPU does doubles in hardware. Coefficients come from `scipy.signal.butter(4, 20, 'highpass', fs=48000, output='sos')` and `butter(4, 200, 'lowpass', ...)` (scipy 1.11.4 is installed) and are pasted as a `const double` table. `pcg_filter.c` includes only `<stdint.h>`, so host gcc can build it for step 3. Every DMA half is filtered even when its frame is dropped, so the filter state stays continuous.
- **Wire format:** binary little-endian int16 frames of `[0x8000 sync][uint16 seq, 0–32767 wrapping][480 filtered samples]`, 964 bytes every 10 ms (96 400 B/s, about 8 % of full-speed bulk). Samples are filtered ADC counts clamped to ±32767 and seq is 15-bit, so the word `0x8000` only ever appears as the sync. The byte pair `00 80` can still occur across two samples, so the parser locks only when it finds the sync at offsets k and k+964, and it re-syncs when an expected sync is missing. A gap in `seq` shows a frame dropped because the host was not reading. 964 is not a multiple of 64, so every transfer ends in a short packet and needs no zero-length packet.
- **Browser:** one static page `Web/index.html` and `Web/pcg_parser.js` (an ES module imported by both the page and the node test), read with the Web Serial API (Chrome/Edge; Chrome is installed) and served on localhost with `python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8000`, because Web Serial needs a secure context. The port opens with `{ baudRate: 115200, bufferSize: 65536 }`: CDC ignores the baud rate, and the default 255-byte buffer is small for 96 KB/s. On each `requestAnimationFrame` the page draws the last few seconds as one min/max line per pixel column, and it shows the drop count. No backend, no npm.
- **Audio path (step 6, browser only, no firmware change):** an AudioWorklet processor `pcg-player` with its own int16 ring buffer, fed by `node.port.postMessage(samples)` with each parsed 480-sample frame (960 bytes, 100 messages/s). It runs on the audio thread, so drawing or GC pauses on the main thread do not gap the sound, and drift, underrun, fades and the limiter are per-sample code in one testable function. Not scheduled `AudioBufferSourceNode`s: each 10 ms start time would be set from the main thread, so jank leaves gaps, and drift and fades would need extra scheduling code. Not a `SharedArrayBuffer` ring: it needs COOP/COEP headers, which `python3 -m http.server` does not send.
- **Worklet file:** `Web/pcg_audio.js` is one ES module served by the same `http.server` (as `text/javascript` with the installed Python 3.12.3). It exports the buffer logic (`createPlayer` and its constants) for the node test, like `pcg_parser.js`, and calls `registerProcessor('pcg-player', …)` only when `typeof registerProcessor === 'function'`, so node v23 can import it (checked). `audioWorklet.addModule` needs a URL anyway, and a Blob URL built from inline code could not be node-tested. `audioWorklet` exists only in secure contexts, and localhost is one.
- **Audio sample rate:** `new AudioContext({ sampleRate: 48000 })`, the stream rate, so the page has no resampler. If the sound card runs at 44.1 kHz, the Web Audio spec requires the browser to resample the output. The context clock still follows the sound card's crystal, so drift handling is still needed.
- **Drift:** the player primes to 100 ms (`TARGET` = 4800 samples = 10 frames) and keeps the fill in a 75–125 ms band (3600–6000 samples). Above the band it skips one sample per render quantum (128 samples), below it repeats one. That corrects up to 1/128 = 7800 ppm, against about ±100 ppm for two crystals. A slip of one sample in ≤ 200 Hz content is a phase step of ≤ 1.5°. In the planner's scratch simulation (±1000 ppm, 120 s, 200 Hz at ±24 000 counts), the largest sample-to-sample step was 2.0× the tone's own. Above 300 ms (`MAX` = 14 400, reachable only when the audio thread stalls while samples keep coming), the player fades out and re-primes. The ring holds 1 s (48 000 samples) and drops the oldest when full, so memory and latency stay bounded.
- **Underrun:** when fewer than `FADE` + one quantum remain (10 + 2.7 ms), the player fades out over `FADE` = 480 samples (10 ms) on real samples. It then discards the leftover (under one quantum, and older than the gap that follows it) and outputs exact zeros. It re-primes: once 100 ms are buffered, it keeps the newest 100 ms and fades in over 10 ms. The ring is a FIFO, so no sample plays twice and there is no stale loop. Without the discard, the simulation spliced old samples onto new ones with a 0.2 full-scale step when pushes were not frame-sized.
- **Level and hearing safety:** audio is off at load. **Start audio** creates the `AudioContext` inside the click (the autoplay rule), stays silent until primed, then fades in. The volume is an a-rate `AudioParam` `volume` with `minValue: 0, maxValue: 1` (the platform clamps it to that range). It is set from a 0–100 % slider that starts at 10 %, which puts the measured ±24 000-count peaks at about 0.07 of full scale. `out = clamp(sample / 32768 × fade × volume, −1, 1)` is the last operation. A slider move uses `setTargetAtTime(v, now, 0.02)`, so the level glides. **Stop audio** ramps to 0 (`setTargetAtTime(0, now, 0.005)`) and closes the context 50 ms later, so every start begins with an empty ring. The node outputs mono, and the destination up-mixes it to both ears (Web Audio "speakers" rule, L = R = M).
- **Disconnect, unplug, reconnect:** audio on or off is independent of the serial port. On Disconnect or unplug, posting stops, the buffered ≤ 125 ms play out and the underrun path fades to exact silence. After the next Connect, the sound fades back in 100 ms after samples arrive, with no second Start audio. The page does not post the first frame after each open, because it is the device's stale queued frame (step 4e) and would be spliced in front of live audio. A seq gap (dropped frame) is spliced as is, with the code comment `shortcut: a dropped frame is spliced and can click, drops are 0 on this PC (steps 4e, 5); fade across seq gaps if drops appear`.

## Steps

- [x] 1. **Shared H7 files.** Copy the H7 HAL `Inc/` `Src/`, the device headers `stm32h7xx.h` `stm32h750xx.h` `system_stm32h7xx.h`, and the gcc startup from STM32Cube_FW_H7_V1.13.0. Copy the linker script from the blink project with RAM moved to AXI SRAM. Add `cmake/stm32h7.cmake`.
  **Acceptance:** files present, root F1 build untouched.
- [x] 2. **Firmware project:** CMakeLists, presets, HAL config, clock, ADC + TIM3 + DMA, filter, USB CDC glue, main loop.
  **Acceptance:** from the project folder, `cmake --preset Debug && cmake --build --preset Debug` builds with no errors, and `arm-none-eabi-size build/Debug/PCG_CDC.elf` shows `text + data < 131072`.
- [x] 3. **Filter self-check:** a host-compiled test `Tests/pcg_filter_test.c` that feeds `pcg_filter.c` 2 s of each sine and measures the gain over the last 1 s.
  **Acceptance:** from the project folder, `gcc -O2 -Wall -IInc Src/pcg_filter.c Tests/pcg_filter_test.c -lm -o /tmp/pcg_filter_test && /tmp/pcg_filter_test` exits 0 with 100 Hz within ±0.5 dB of unity, 20 Hz and 200 Hz at −3 ±0.5 dB, 2 Hz and 2 kHz below −30 dB.
- [x] 4. **On hardware:** flash and check, in this order, stopping at the first failure. Run the commands from the repo root with `P=Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC`.
  **Result (2026-10-29):** a–e pass on rev V (`0x20036450`): `** Verified OK **`, pc in `main`, clocks as planned; PA6 live 0–1.598 V, mean 0.951 V, std 0.221 V over 120 reads, all changing, 1 clipped read at `0x0000`; `0483:5740` on `/dev/ttyACM0`; 96 439–96 567 B/s, every sync present, seq +1; 0 drops through `Web/pcg_parser.js` on a real capture.
  **Acceptance:**
  - a. **Safe flash.** `../stm32h7_blinkled_vscode/GPIO_IOToggle_Led/backup/weact_factory_internal_flash.bin` exists (131072 bytes, present on 2026-10-29). `openocd -f openocd.cfg -c "init" -c "exit"` prints `processor detected`. `openocd -f openocd.cfg -c "program $P/build/Debug/PCG_CDC.elf verify reset exit"` prints `** Verified OK **`. No `unlock`, mass erase or option-byte command.
  - b. **Boots on the new clock tree.** The halted `pc` resolves (`arm-none-eabi-addr2line`) to neither `Error_Handler` nor `HardFault_Handler`. Then run `openocd -f openocd.cfg -c "init" -c "mdw 0x58024410" -c "mdw 0x58024418 3" -c "mdw 0x58024430" -c "mdw 0x58024454 2" -c "mdw 0x52002000" -c "mdw 0x5C001000" -c "exit"`. Expected: RCC_CFGR `& 0x38` = `0x18` (SYSCLK = PLL1); D1/D2/D3CFGR = `00000048 00000440 00000040`; PLL1DIVR = `0109025f`; D2CCIP2R bits 21:20 = `01` (USB = PLL1Q); D3CCIPR bits 17:16 = `10` (ADC = per_ck); FLASH_ACR low nibble = `2`. Record the top half of DBGMCU_IDCODE (`1003` = rev Y, `2003` = rev V).
  - c. **ADC reads the live signal on PA6.** The front end drives PA6 permanently: do not put a resistor or any other load on PA6 while it is connected. Read ADC1_DR 120 times over about 3 s. OpenOCD 0.12 prints nothing for a bare `mdw` inside a loop, so each read is wrapped in `echo`, and OpenOCD logs to stderr:
    ```
    openocd -f openocd.cfg -c init -c 'for {set i 0} {$i < 120} {incr i} { echo [mdw 0x40022040]; sleep 25 }' -c exit 2>&1 | grep '^0x40022040' > /tmp/adc.txt; python3 -c "v=[int(l.split()[1],16) for l in open('/tmp/adc.txt')];x=[c*3.3/65535 for c in v];print(len(v),'reads, min %.3f max %.3f mean %.3f V'%(min(x),max(x),sum(x)/len(x)),'changes',sum(a!=b for a,b in zip(v,v[1:])),'in range',max(v)<=0xFFFF,'clipped',sum(c==0 or c>=0xFFF0 for c in v))"
    ```
    Pass: at least 100 reads, `changes` above 0 (a stuck ADC gives 0), and `in range` is `True` (16-bit right-aligned data). Report min, max and mean in volts. A `clipped` count above 0 (reads at `0x0000` or ≥ `0xFFF0`) is a clipping warning for the user, not a failure.
  - d. **USB enumerates.** With the board's USB-C plugged into the PC, `lsusb | grep 0483:5740` and `ls /dev/ttyACM*` show the device. ModemManager is active on this PC and probes new ACM ports, so wait until `fuser /dev/ttyACM0` prints nothing.
  - e. **Samples stream at 48 kHz.** The command below prints the bytes per second, `True`, and `{1}`. Bytes per second must be 94 472–98 328 (96 400 ± 2 %), every frame must start with the sync, and seq must step by 1:
    ```
    stty -F /dev/ttyACM0 raw -echo && timeout 5 cat /dev/ttyACM0 > /tmp/pcg.bin; python3 -c "d=open('/tmp/pcg.bin','rb').read();s=b'\x00\x80';i=next(i for i in range(len(d)) if all(d[i+k*964:i+k*964+2]==s for k in range(4)));f=[d[j:j+964] for j in range(i,len(d)-963,964)];print(len(d)/5,all(x[:2]==s for x in f),{(int.from_bytes(b[2:4],'little')-int.from_bytes(a[2:4],'little'))%32768 for a,b in zip(f[1:],f[2:])})"
    ```
    The first frame is skipped for the seq check, because the device queues one frame while the port is closed.
- [x] 5. **Browser app:** `Web/index.html` + `Web/pcg_parser.js`, and a node self-check of the parser covering: sync lock needing two syncs 964 bytes apart, frames split across chunks, a false `00 80` pair inside the samples, re-sync after garbage, and drop counting from seq gaps, including the 32767 → 0 wrap.
  **Acceptance:** from the project folder, `node Tests/pcg_parser_test.mjs` passes. Then serve the page with `python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8000`, open `http://localhost:8000` in Chrome, click Connect and pick "WeAct H750 PCG". The user confirms a moving trace that stays flat near 0 while PA6 sits at a fixed level, and a drop count that stays at 0.
- [ ] 6. **Audio on the PC output (browser only).** Files: `Web/pcg_audio.js` (new), `Tests/pcg_audio_test.mjs` (new), `Web/index.html`, and `README.md` (the Browser viewer section gets one audio sentence and the new test command). No firmware, CMake, linker, HAL config, `.vscode` or guide change. Commands run from the project folder. Do a, b, c in order.
  - [x] a. **Buffer logic and its self-check.** In `Web/pcg_audio.js`, `createPlayer()` returns `{ push(Int16Array), pull(Float32Array out, volume), stats: { fill, underruns, slips } }` and implements the Drift, Underrun and Level decisions. `volume` is the AudioParam array (1 or `out.length` values), and `pull` sizes everything from `out.length`, never a literal 128. The processor class declares `parameterDescriptors` `[{ name: 'volume', defaultValue: 0.1, minValue: 0, maxValue: 1 }]`. Its `port.onmessage` calls `push`, and `process()` calls `pull(outputs[0][0], parameters.volume)` and returns `true`. It posts `stats` about once per second (every 48 000 output samples). `Tests/pcg_audio_test.mjs` uses `node:test`, in the parser test's style. It drives the player the way the page and the audio thread do: 480-sample pushes and 128-sample pulls on a simulated clock. With A = 24 000/32 768 (the user's measured peak), it asserts:
    1. **Silent until primed.** 4799 buffered samples give exact zeros. Then the first output on a DC input of 24 000 is ≤ A/480, each step is ≤ A/480, and the output reaches A within 480 samples. This is the "no click when audio starts mid-stream" case.
    2. **In order.** At equal rates for 10 s, a numbered ramp comes out in order with no gap, 0 slips and 0 underruns.
    3. **Drift.** At +1000 and at −1000 ppm (10× a bad crystal pair) for 120 s of a 200 Hz tone at ±24 000 counts: 0 underruns. After the first 2 s, `fill` stays within 2992–6608 (the band ± one frame and one quantum). Without correction, +1000 ppm would reach 10 560. Slips are above 0, and the largest step is ≤ 2.05× the tone's own largest step.
    4. **Jitter.** Frames delayed by a seeded random 0–60 ms (kept in order) for 120 s give 0 underruns.
    5. **Underrun.** When pushes stop on a DC input, the output falls to exactly 0 with steps ≤ A/480 and stays exactly 0 for the next 1 s (no stale loop), and underruns = 1. A different DC (−24 000) pushed next in 37-sample chunks fades in with steps ≤ A/480, so the leftover old samples are never spliced on.
    6. **Stall, then burst.** After an underrun, 1 s pushed at once resumes from the newest 100 ms (checked with numbered samples). While playing, an extra 400 ms pushed at once makes the player fade out and re-prime: `fill` returns to 4800 ± one quantum, and the next samples played are the newest.
    7. **Capacity.** 2 s pushed with no pulls leaves `fill` = 48 000, holding the newest samples.
    8. **Limiter.** Alternating 32767/−32768 at volume 1 stays in [−1, 1]. At volume 8, every sample is in [−1, 1] and some are exactly ±1. Volume 0 gives exact zeros. A 128-value volume array is applied per sample.
    9. **Worklet glue.** With stub `AudioWorkletProcessor` and `registerProcessor` on `globalThis`, `await import('../Web/pcg_audio.js?worklet')` registers `pcg-player` (the query gives a fresh module instance). `process()` fills `outputs[0][0]` and returns `true`, and `volume` has `maxValue` 1 and `defaultValue` 0.1.

    **Acceptance:** `node Tests/pcg_audio_test.mjs` and `node Tests/pcg_parser_test.mjs` both end with `fail 0`.
  - [x] b. **Page wiring in `Web/index.html`.**
    - **Markup**, after the Connect paragraph:
      - `<button id="audio" type="button">Start audio</button>`. The text toggles between Start audio and Stop audio, the same pattern as Connect and Disconnect.
      - `<label for="vol">Volume (%)</label> <input id="vol" type="range" min="0" max="100" step="1" value="10">`, with an `<output for="vol">` that shows the value. A native range input already works from the keyboard: arrows move it 1 %, plus Page Up/Down and Home/End.
      - A `role="status"` span for audio state changes only ("Audio off.", "Audio on.", "Audio failed: …"), and a plain span for the numbers that update every second. This is the `#msg` and `#stats` split the page uses today, so screen readers are not flooded.
      - One line of text: "Turn the system volume down before the first Start audio. Audio starts at 10 % and fades in."
      - `input:focus-visible` added to the existing focus rule.
    - **Script.**
      - **Start audio.** The button is disabled while audio starts. Create `new AudioContext({ sampleRate: 48000 })` synchronously in the click handler, then `await actx.audioWorklet.addModule('pcg_audio.js')`. Create `new AudioWorkletNode(actx, 'pcg-player', { numberOfInputs: 0, outputChannelCount: [1], parameterData: { volume: vol.value / 100 } })` and connect it to `actx.destination`. Its port messages show as "Audio: N ms buffered, N underruns, N slips."
      - **Errors.** Any failure shows `Audio failed: <message>`, closes the context and sets the button back to Start audio.
      - **Stop audio.** Ramp and close as in the Level decision.
      - **Slider.** The `input` event updates the `<output>` and calls `setTargetAtTime` on `volume`, if the node exists.
      - **Read loop.** After `ring.set`, post each frame to the node, except the first frame after each `connect()`. Use a per-connection counter, with a one-line comment giving the reason.

    **Acceptance:**
    ```
    python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/index.html').read(),re.S).group(1))" > /tmp/pcg_page.mjs && node --check /tmp/pcg_page.mjs && echo page syntax OK
    python3 -m http.server -b 127.0.0.1 -d Web 8001 >/dev/null 2>&1 & S=$!; sleep 1; for f in "" pcg_parser.js pcg_audio.js; do curl -s -o /dev/null -w "%{http_code} %{content_type} /$f\n" "http://localhost:8001/$f"; done; kill $S
    grep -o '<input id="vol"[^>]*>' Web/index.html
    ```
    The output must be `page syntax OK`, then `200 text/html /`, `200 text/javascript /pcg_parser.js` and `200 text/javascript /pcg_audio.js`, then the slider tag with `min="0"`, `max="100"` and `value="10"`. Port 8001 avoids a collision with the user's server on 8000. Before step 6, the same loop prints `404` for `pcg_audio.js`.
  - [ ] c. **User check with headphones.** The agent cannot hear the output.
    1. Set the system output volume low (about 20 %) and put the headphones on. Serve and open the page as in step 5, then Connect. Before Start audio there is no sound at all.
    2. Click Start audio, or Tab to it and press Enter or Space. Within about 0.1 s the heart sounds fade in quietly in both ears, with no click or pop. They are low thumps in step with the beats on the trace, about 0.1 s behind them. The audio line shows about 100 ms buffered and 0 underruns.
    3. Tab to the volume slider and use the arrow keys: the level changes smoothly. Home gives silence. Raise the level slowly, together with the system volume, until it is comfortable.
    4. Leave it running for 10 minutes. There are no periodic clicks, gaps or pitch wobble. Buffered stays roughly within 60–140 ms and underruns stays at 0. Slips may rise slowly: that is the drift correction working.
    5. Click Disconnect. The sound fades out within about 0.15 s and stays silent: no buzz and no repeating loop. Underruns goes up by 1. Connect again, and the sound fades back in without another Start audio. Unplugging and re-plugging the USB-C behaves the same (wait for ModemManager before Connect, see below).
    6. Click Stop audio. The sound stops without a click, and the status reads "Audio off."

    **Acceptance:** the user confirms 1–6.

## Not doing

Raw (unfiltered) stream, decimation (all 48 kHz filtered samples go on the wire), recording or export of the trace or the audio (for example WAV), FFT, settings UI, host-to-device commands, status LED, VS Code tasks/launch for the new project (the guide's commands do not change), a CubeMX `.ioc`, deleting the F1 tree. For audio: gain above 100 %, automatic gain or compression, extra audio filtering or EQ, stereo or panning, an output-device picker (`setSinkId`), recovery from a lost sound device (Stop audio then Start audio rebuilds the context), remembering the volume across reloads, concealing dropped frames, a `SharedArrayBuffer` ring, a resampler of our own.

## Needs the user

- Front-end assumptions the firmware relies on (the front end is your hardware):
  - PA6 always stays between 0 and 3.3 V. Full scale is VREF+, which R9 (0R) ties to VDDA = 3.3 V on the V12 schematic, so leave the header's VREF+ pin unconnected.
  - The signal is biased to about 1.65 V.
  - Anti-alias filtering below 24 kHz is the front end's job.
  - The output impedance is low (an op-amp output, ≤ 1 kΩ), so 64.5-cycle sampling settles to 16 bits.
- The measured bias (step 4c: mean 0.95 V, range 0–1.60 V) is below the 1.65 V the plan assumes, and the signal touches 0 V (one read at `0x0000`), so the ADC clips the bottom of the waveform. Raise the front end's bias to about 1.65 V, keeping PA6 within 0–3.3 V at all times.
- PA6 is also `DCMI_PIXCLK` through solder bridge SB1: no camera module may be plugged in.
- Plug the board's USB-C into the PC (it powers the board and carries the data) and keep the Atmel-ICE on SWD for flashing.
- ModemManager probes the port for several seconds after each plug-in. Either wait for it, or (with sudo) add a udev rule with `ENV{ID_MM_DEVICE_IGNORE}="1"` for `0483:5740`.
- Look at the trace in Chrome (serve and open the page as in step 5) and confirm it moves and the drop count stays at 0: the agent cannot see it.
- Plug headphones into the PC's audio output. Before the first Start audio, turn the system output volume down to about 20 %. The page starts at 10 % and never exceeds full scale, but the system volume and the headphones decide how loud full scale is.
- Many headphones and earbuds roll off below about 50–100 Hz, and hearing is less sensitive there, so heart sounds can be faint. Raise the level in small steps.
- Do the headphone check in step 6c and report what you hear: the agent cannot hear it.
- Open question: the audio runs about 100 ms behind the trace, because that buffer absorbs USB and drawing jitter. Say if that is too much. 50 ms is possible, at a higher risk of gaps.

# PLAN: ECG viewer (Biomedic ECG, lead I)

**Goal:** draw lead I of the Biomedic ECG module live in Chrome, read from its USB serial port and filtered on the PC with a 0.5–150 Hz band-pass and a 50 Hz IIR notch.

## Decisions

- **Where:** everything goes in `PCG_CDC/`, because the user asked for the PCG page's folder:
  - `Web/ecg.html`: the new page.
  - `Web/ecg_dsp.js`: the existing draft, adopted.
  - `Tests/ecg_dsp_test.mjs`: the new self-check.
  - `README.md`: a new "ECG viewer" section.

  The same `http.server` command serves both pages, and the ECG page is at `http://localhost:8000/ecg.html`. `index.html`, `pcg_parser.js`, `pcg_audio.js` and their tests stay byte-identical, so the PCG page keeps working. No firmware, CMake, linker, HAL, `.vscode` or guide change.
- **Data path:** Web Serial on the module's MCP2200 CDC-ACM port (`04d8:00df`, `/dev/ttyACM0` through Linux `cdc_acm`, verified), opened with `{ baudRate: 230400, bufferSize: 65536 }`.
  - 8N1 with no flow control is the Web Serial default.
  - The baud rate matters here, because the MCP2200 is a real UART bridge (protocol §3).
  - The buffer holds 3 s at 20 KB/s. The 255-byte default is too small.
  - This is a platform feature: no driver, no backend, no npm.
- **pyserial breaks the next Chrome Connect (confirmed 2026-10-30, after the first E3 run):**
  - Symptom: Connect fails within 1 s with "Connection lost: The device has been lost.", while the module stays on USB.
  - Cause: pyserial 3.5 opens the port with VMIN 0 and VTIME 0 (`serialposix.py` lines 393, 510 and 514) and never restores them. Linux keeps tty settings across opens until the module is replugged.
  - Chrome sets raw mode but leaves VMIN and VTIME as it finds them. It reads at once and treats `read() == 0` as "device lost". On this kernel, a non-blocking raw tty returns 0 on an empty buffer with VMIN 0, and EAGAIN with VMIN 1 (tester's pty test).
  - The page cannot fix it, because Web Serial has no VMIN control.
  - **Fix in the plan's commands:** set `p.inter_byte_timeout = 0.05` before `open`. pyserial then sets VMIN 1 and VTIME `int(0.05 * 10)` = 0, the cdc_acm plug-in default, and never sets VMIN 0. The port is therefore right after an error, Ctrl-C or a killed process too, which a `finally` that resets termios would not cover.
  - pyserial's Linux `read()` ignores `inter_byte_timeout` and times out with `select` (line 553 on), so reads are unchanged.
  - Anyone else: run `stty -F /dev/ttyACM0 min 1 time 0`, or replug the module.
- **Session:** the commands follow protocol §5–§7 and the verified capture, plus a stop before the start:
  - Right after `open`, call `setSignals({ dataTerminalReady: false, requestToSend: false })`.
  - **Connect:** the stop `02`, wait 100 ms, `02`, then wait 100 ms (the vendor's spacing between commands), then the start `01`, wait 100 ms, `01`, `09`. The vendor program sends only the start. Why the page adds the stop: next decision.
  - **Keep-alive:** `09`, wait 5 ms, `09` every 30 000 frames. Count frames like the vendor program does, not with a timer, because Chrome throttles timers in hidden tabs.
  - **Disconnect:** `02`, wait 100 ms, `02`, then `await port.writable.close()`, then cancel the reader and close the port.
    - `writable.close()` drains the OS transmit buffer. `port.close()` alone aborts it and can drop the last stop byte.
    - This drain fix has been in `Web/ecg.html` since the second E3 run. Its effect is not known yet (next decision).
  - **No buffer purge:** Web Serial has none, so the marker hunt drops the start-up junk instead. On the real capture that was 78 bytes, because the module's first blocks carry `01 00`, `02 00`, `03 00` instead of `xx C0`.
  - **One write queue:** every write goes through one promise chain that catches errors (for example an unplug). The stop bytes then always follow any queued start or keep-alive bytes, and two writes never fight over the writer lock.
- **Stop before start on every Connect, because the module can stop obeying commands (E3 second run, evidence there):**
  - **Why the page differs from the vendor:** the vendor program ends every session with a stop, so its start always reaches an idle module. A tab can close, crash or lose the port before Disconnect, so the page cannot promise the stop at the end. It sends the stop at the start instead, for 200 ms more per Connect.
  - **Candidate triggers, all unproven:**
    - (a) A start received while streaming.
    - (b) A start cut off between `01` and `01 09`.
    - (c) The module's UART receiver locked after an overrun, which is common on PIC parts.
    - (d) Streaming for minutes with nobody reading (planner's addition).

    The PC only sees that USB delivered the bytes, so the deaf part may also be the MCP2200's UART side.
  - **What the stop-first Connect covers:**
    - It removes (a) as long as the module still obeys.
    - The double-connect bug, which may have cut a start (b), and VMIN 0, which ended sessions without a stop, are already fixed.
    - (c) and (d) are not addressed. The page never sends more than two command bytes back to back, except when Disconnect is clicked during the 0.3 s Connect sequence.
  - **A stop reaching an idle module is probably harmless:** the vendor's second `02` already does that, and the module started again after E1's stop. E3 item 7.1 checks it.
  - **The trigger itself is not tested:** each positive test can lock the module and cost a replug, and no answer would change the page, whose only lever is the order of the bytes it sends. E3 item 7 instead tests the case users meet: a tab closed without Disconnect, then a new Connect.
  - **Recovery from a deaf module:** unplug and replug it. Nothing the PC can send is known to help.
- **Parser:** adopt the draft's `createParser` as it is.
  - It uses the vendor's six-marker check with a byte-by-byte hunt (§8.1).
  - Lead I is the big-endian int16 at offset 6.
  - RA off is `B1 & 0x60`, and LA off is `A1 & 0x20` (§8.3).
  - The LL flag (`A1 & 0xC0`) is ignored, because lead I does not use LL. It is set on the real device, since no LL electrode is fitted.
  - Planner's check on the real capture, fed in 777-byte chunks: 1955 frames, 78 bytes skipped and lead I from −4488 to 4715. This matches the Python marker check exactly.
- **Electrode off:** a `role="status"` line reads "RA and LA electrodes on." or "Lead I not valid: LA electrode off." (RA, or both, likewise). It is updated only when its text changes.
  - Lead I is not zeroed the way the vendor program does it. The status line gives the same information, and the data and filter state stay untouched.
  - Neither flag has fired on real hardware yet, so in E3 the user unclips LA to prove it.
- **Filters:** adopt the draft chain unchanged:
  - The chain, in order: a 2nd-order Butterworth high-pass at 0.5 Hz, a 2nd-order Butterworth low-pass at 150 Hz (together, the band-pass), then an RBJ notch at 50 Hz with Q 30.
  - Each stage is a biquad in double-precision DF2T. The first sample is subtracted, so the chain starts settled.
  - Planner's check: on the real capture the chain matches scipy (`butter` plus the same notch) to within 3e-9 counts.
  - RMS gains: 0.5 Hz −3.01 dB, 10 Hz 0.00 dB, 49 Hz −2.05 dB, 51 Hz −2.11 dB, 50 Hz −247 dB and 150 Hz −3.01 dB.
  - A constant input gives exact zeros.
  - The chain is causal, as a live view must be. The group delay is 1 sample at 10 Hz and 67 samples (134 ms) at 1 Hz. That bends slow waves slightly, which is acceptable for viewing.
  - Only change: fix the notch comment. It says "about 1.7 Hz wide", but the −3 dB band is 1.56 Hz (49.22–50.79 Hz).
- **Notch Q 30 depends on the sample rate:**
  - A 40-count QRS-like pulse makes the notch ring by only 0.007 counts.
  - But the notch attenuates only 12 dB at ±0.2 Hz from 50 Hz. If the module runs 0.4 % slow, mains lands at 50.2 Hz in the filter's time, so the notch is only as good as `RATE`.
  - The 4 s capture (489 frames/s) cannot tell a slow clock from start-up delay, because its timer started after the 100 ms wait. E1 therefore measures the rate over 10 s.
  - `RATE` stays 500 (§8) if E1 measures 499.5–500.5 frames/s (within 0.1 %). Otherwise E2 sets `RATE` to the measured value.
  - The current capture shows no 50 Hz peak above the ±4-count noise; the largest bins are QRS energy at 7–18 Hz. The notch is there because the user asked, and for setups that do pick up hum.
- **Amplitude in counts:** the scale labels and the caption say "counts".
  - The µV per count is unknown (§12, question 1).
  - The ADS1194 front-end chip is only inferred (§3), and its PGA gain (1 to 12) is unknown, so a mV scale could be wrong by a factor of 12.
  - For the record only, not a source: at gain 6 with a 2.4 V reference, 1 count would be 12.2 µV. The measured QRS of about 40 counts would then be about 0.5 mV, which is plausible for lead I.
- **Display:** reuse the PCG page's `draw()` and its stats pattern.
  - The trace shows the last 5 s (`RING = Math.round(5 * RATE)` samples), newest on the right, as one min/max pair per pixel column.
  - The autoscale is symmetric, rounded up to a 1-2-5 step, with a floor of ±50 counts (QRS about 40 counts, noise about ±4).
  - **Change 1:** the ring is a `Float32Array`. Filtered values are fractional, and after a step to the rail they exceed int16.
  - **Change 2:** every pixel column covers at least one sample. The PCG ring (240 000 samples) is always wider than the canvas. 2500 samples can be fewer than the device pixels of a wide or zoomed window, and the copied loop would then draw the empty columns as ±32767 spikes.
- **Start-up swing:** on the real capture the module's input settles over about 3 s after start, from −4488 to +4700 counts.
  - The 0.5 Hz high-pass turns that into a swing of +1500/−500 counts, which is gone after about 2.5 s.
  - The ECG becomes readable about 7 s after Connect, once the swing has left the 5 s window and the autoscale shrinks.
  - The caption says so. It is not filtered away.
- **Test data:** `Tests/ecg_dsp_test.mjs` uses `node:test` and `node:assert/strict` on synthetic frames only. Real captures are the user's ECG: they stay in `/tmp` and never go into the repo or into a fixture.

## Steps

Commands run from `Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC` unless they say "repo root".

Two rules for anything that touches the device:

- Only two commands ever send to or read from the device. The capture command uses the vendor sequence and always ends with the stop bytes. The listen command sends nothing.
- Both find the port by VID:PID, because the PCG board also shows up as `ttyACM*`.
- Both set `p.inter_byte_timeout = 0.05` before `open`, so they leave the port at `min 1 time 0`, even on an error (Decisions, "pyserial breaks the next Chrome Connect"). Never drop that line: without it, the next Connect in Chrome fails with "The device has been lost."
- After either command, `stty -F /dev/ttyACM0 -a | grep -o 'min = [0-9]*; time = [0-9]*'` must print `min = 1; time = 0`. `stty` sends nothing to the module.

Run the Python blocks exactly as written: the heredocs must stay unindented.

- [x] E1. **Real stream and sample rate (tester only, no code).**
  **Result (2026-10-30):** 500.12 frames/s over 10 s (inside 499.5–500.5, `RATE` stays 500); lock_at 77, 0 skipped after lock, 5956 frames; RA_off 0, LA_off 0, LL_off 5543 (A1 = 0x00 for the first 413 frames, ~0.83 s, then 0xC0); lead I −4206…−2302; listen after stop: 0 bytes in 2 s.
  **Note (18:20):** as first run, these commands left `/dev/ttyACM0` at `min 0`, which broke the first E3 Connect. The tester reset it with `stty -F /dev/ttyACM0 min 1 time 0`. The commands below now carry the fix, so running them again is safe.
  Before starting:
  - The user has RA, LA and RL on and sits still.
  - No page has the port open: `fuser /dev/ttyACM0` prints nothing.

  The capture runs 12 s with the vendor sequence and writes `/tmp/ecg.bin`. The planner ran this exact script against a paced fake device on a pty. For 500 and 489 frames/s it measured 500.05 and 489.00, and the device received `01 01 09 02 02`. After the VMIN fix it measured 500.04 frames/s and the same bytes. On a pty set to VMIN 0 first, the capture and the listen both left VMIN 1, VTIME 0. The listen without the new line left VMIN 0.

```
python3 - <<'EOF'
import sys, time, serial
from serial.tools import list_ports
dev = [q.device for q in list_ports.comports() if (q.vid, q.pid) == (0x04D8, 0x00DF)]
if not dev: sys.exit("ECG module 04d8:00df not found")
p = serial.Serial(); p.port, p.baudrate, p.timeout = dev[0], 230400, 2
p.dtr = p.rts = False
p.inter_byte_timeout = 0.05  # pyserial then sets VMIN 1, VTIME 0, not VMIN 0, which outlives close and breaks Chrome's next Connect
p.open()
buf = bytearray(); mark = None
try:
    p.reset_input_buffer(); p.write(b"\x01"); time.sleep(0.1)
    p.reset_input_buffer(); p.write(b"\x01"); p.write(b"\x09")
    t0 = time.monotonic()
    while time.monotonic() - t0 < 12:
        buf += p.read(p.in_waiting or 1)
        if mark is None and time.monotonic() - t0 >= 2: mark = (len(buf), time.monotonic())
    rate = (len(buf) - mark[0]) / (time.monotonic() - mark[1]) / 40
finally:
    p.write(b"\x02"); time.sleep(0.1); p.write(b"\x02"); p.close()
open("/tmp/ecg.bin", "wb").write(buf)
d = bytes(buf); M = (1, 0xC0, 2, 0xC0, 3, 0xC0); i = 0; lock = None; skip = 0; f = []
while i + 40 <= len(d):
    if (d[i], d[i+1], d[i+12], d[i+13], d[i+24], d[i+25]) == M:
        lock = i if lock is None else lock; f.append(d[i:i+40]); i += 40
    else:
        skip += lock is not None; i += 1
I = [int.from_bytes(x[6:8], "big", signed=True) for x in f]
print(f"{dev[0]} bytes {len(d)} lock_at {lock} frames {len(f)} skipped_after_lock {skip} rate {rate:.2f} frames/s",
      f"RA_off {sum(x[3] & 0x60 > 0 for x in f)} LA_off {sum(x[2] & 0x20 > 0 for x in f)} LL_off {sum(x[2] & 0xC0 > 0 for x in f)}",
      f"leadI {min(I)}..{max(I)}")
EOF
```

  Then the listen command checks that the stop bytes really stopped the module. It opens the port for 2 s and sends nothing:

```
python3 - <<'EOF'
import serial
from serial.tools import list_ports
p = serial.Serial(); p.baudrate, p.timeout = 230400, 2; p.dtr = p.rts = False
p.inter_byte_timeout = 0.05  # leaves VMIN 1, VTIME 0 for Chrome, as in the capture
p.port = [q.device for q in list_ports.comports() if (q.vid, q.pid) == (0x04D8, 0x00DF)][0]
p.open(); print(len(p.read(100000)), "bytes in 2 s, nothing sent"); p.close()
EOF
```

  **Acceptance:**
  - The capture line shows:
    - `lock_at` ≤ 120 and `skipped_after_lock 0`.
    - `frames` ≥ 5800.
    - `RA_off 0` and `LA_off 0`.
    - Lead I strictly inside −32768…32767.
  - Record `rate`. If it is outside 499.5–500.5, E2 sets `RATE` to it.
  - The listen prints fewer than 1000 bytes. A few stale bytes from the bridge are fine. A module that is still streaming gives about 40 000.
- [x] E2. **Parser and filter, with the self-check.** Files:
  - `Web/ecg_dsp.js`: the draft, adopted. The only edits are the notch comment fix and `RATE` if E1 requires it.
  - `Tests/ecg_dsp_test.mjs`: new. Its header comment reads "From the project folder: node Tests/ecg_dsp_test.mjs", like `pcg_parser_test.mjs`.

  The test asserts:
  1. **Values and offsets.** Build frames as in §8, with distinct values in V5, I, II and III. Lead I values −32768, −1, 0, 32767 and −4488 come out in order, so a wrong offset or a little-endian read fails.
  2. **Chunking.** The output is the same for the whole buffer at once, 1-byte chunks, chunks cycling through 39/40/41 bytes, and seeded random chunks of 1–200 bytes.
  3. **Start-up junk.** Put the module's start-up blocks before valid frames: first `01 00` … `02 00` … `03 00`, then `01 00` with `02 C0` and `03 C0`, then a partial frame. None of them is emitted, `skipped` equals their byte count, and the first valid frame comes out first.
  4. **Re-sync.** Insert 333 seeded random bytes between valid frames, and in a separate case a frame cut after 20 bytes. Every valid frame comes out, the cut frame does not, and `skipped` grows by exactly the number of inserted bytes.
  5. **Flags.**
     - `A1 = 0xC0` (the real device, where LL is off) gives `raOff` false and `laOff` false.
     - `A1 = 0x20` and `A1 = 0xE0` give `laOff`.
     - `B1 = 0x20` and `B1 = 0x40` give `raOff`.
     - A clean frame afterwards clears both.
  6. **Response.** Feed 30 s sines of amplitude 1000 at `RATE`. Measure the gain from the RMS of the last 10 s, not the peak: at 150 Hz the 500 Hz samples fall on only 10 phases. Expected:
     - 10 Hz within ±0.1 dB of 0 dB.
     - 0.5 Hz and 150 Hz at −3.01 ± 0.1 dB.
     - 50 Hz below −40 dB.
     - 48 Hz and 52 Hz above −1 dB.
  7. **Start and DC.**
     - A constant 3000 for 10 s gives exactly 0 on every sample.
     - A +100-count step at 1 s is within ±1 count from 4 s on. The planner measured 0.90 at 3 s and 0.02 at 6 s.

  **Acceptance:**
  - `node Tests/ecg_dsp_test.mjs`, `node Tests/pcg_parser_test.mjs` and `node Tests/pcg_audio_test.mjs` all end with `fail 0`.
  - Replay the E1 capture through the module:
    ```
    node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createParser, createEcgFilter, RATE} from './Web/ecg_dsp.js'; const d=readFileSync('/tmp/ecg.bin'); const p=createParser(), f=createEcgFilter(), y=[]; for (let i=0;i<d.length;i+=777) for (const v of p.push(d.subarray(i,i+777))) y.push(f(v)); const late=y.slice(5*RATE); console.log('frames',p.stats.frames,'skipped',p.stats.skipped,'finite',y.every(Number.isFinite),'after 5 s',Math.min(...late).toFixed(0)+'..'+Math.max(...late).toFixed(0))"
    ```
    It must print:
    - `frames` equal to E1's `frames`.
    - `skipped` equal to E1's `lock_at` plus `skipped_after_lock`.
    - `finite true`.

    Report the range after 5 s. On the 4 s capture, filtered lead I was about −175…−5 counts between 2 s and 4 s, still settling.
- [ ] E3. **Page and README.** Files: `Web/ecg.html` (new) and `README.md` (a new section after "Browser viewer"). Build `Web/ecg.html` from `index.html` and drop everything to do with audio.
  **First run (2026-10-30):** Connect failed within 1 s with "Connection lost: The device has been lost.". The cause was E1's pyserial commands, not the page (Decisions). The only change left is the README troubleshooting line below.
  **Second run (2026-10-30):** items 1–5 worked (3+ min, keep-alives at 60, 120 and 180 s). They did not test the start, because the module was already streaming. In items 6 and 7 the module kept streaming after Disconnect: the listens got 40 011 B (old `port.close()`) and 40 021 B (drain fix). The tester then found that it ignores every command (18:52–18:54):
  - Two pyserial runs of `01`, 100 ms, `01 09` … `02`, 100 ms, `02` each left it streaming, at about 40 000 B in 2 s.
  - The bytes reached the MCP2200, because pyserial's close did not wait out the 30 s closing_wait. The kernel log shows no USB event since 17:19.
  - Those starts did not restart it: lock_at 26 and 19, no start-up blocks, LL flagged from frame 1 and lead I flat at 1526–2066. A real start looks like E1: lock_at 77, the `01 00`/`02 00`/`03 00` blocks, A1 = 0x00 for the first ~413 frames and a settling swing.
  - It obeyed both commands in E1. After E1 it received, in order:
    1. A start that the double-connect bug may have cut off before `01 09`, and no stop.
    2. A start at 18:11 and no stop (VMIN 0; the tab held the port until about 18:19).
    3. A start while already streaming, then a stop through the old `port.close()` (items 1–5).
    4. A start while streaming, then a stop with the drain fix (item 7).

    It went deaf somewhere in 1–4, so the drain fix is untested, not disproved.

  **Changes left:** the stop-first Connect (Decisions), a README recovery line, and items 6–7 below, run on a freshly replugged module. The rest of the spec below is unchanged.
  - **Markup:**
    - `<h1>ECG viewer (lead I)</h1>` and the Connect button.
    - `#msg` with `role="status"` (the same "serve the page" hint, with the URL ending in `/ecg.html`) and `#stats`.
    - `<p id="leads" role="status">` for the electrode line.
    - A `<figure>` with `<canvas role="img" aria-label="Live ECG, lead I, last 5 seconds, newest on the right">`.
    - A `<figcaption>`: "Lead I (LA − RA), 500 samples/s, filtered on the PC: 0.5–150 Hz band-pass and 50 Hz notch. Last 5 s, newest on the right. The scale is in ADC counts, because the module's µV per count is not known. For about 7 s after Connect the trace shows the module's input settling."
    - The same CSS and focus rule as the PCG page.
  - **Script:**
    - Import `createParser`, `createEcgFilter` and `RATE` from `./ecg_dsp.js`.
    - Show the same messages as the PCG page when Web Serial is missing or the page is not a secure context.
    - **Connect:**
      - `requestPort({ filters: [{ usbVendorId: 0x04d8, usbProductId: 0x00df }] })`, open as in Decisions, then `setSignals`.
      - The button stays disabled until the open settles, because `port` is still null and a second click would start a second connect. A failed attempt closes the port only if this attempt opened it. Both were fixed after the first E3 run and are already in `Web/ecg.html`.
      - Create a new parser and filter for each connection. Queue the stop sequence, a 100 ms wait, then the start sequence (Decisions, Session), with a one-line why comment.
      - The wait must sit in the write chain, for example `writes = writes.then(() => new Promise((r) => setTimeout(r, 100)));` between the two `send` calls. A wait outside the chain would put the start's first `01` right after the second `02`, and a Disconnect clicked during it could queue its stop before the start.
      - The read loop and error handling are the same as the PCG page. Each lead I value goes through the filter into the ring.
      - Queue the keep-alive whenever `parser.stats.frames` reaches the next multiple of 30 000.
    - **Disconnect:**
      - Disable the button, queue the stop sequence, await the chain and then `port.writable.close()`, then set `stopping` and cancel the reader. This drain fix is already in `Web/ecg.html`. A failed drain, for example after an unplug, still goes on to stop.
      - The loop closes the port and enables the button again, as in the PCG page.
    - **Status lines:**
      - Once per second, `#stats` reads "N frames/s, N bytes skipped while syncing, scale ±N counts."
      - The electrode line is set from `parser.stats` and only rewritten when its text changes.
  - **README:** a section "ECG viewer (Biomedic ECG module)" that says:
    - What the page shows and which filters it applies.
    - Why the scale is in counts.
    - Where the protocol is described (`Biomedic_ECG_USB_protocol.md` at the repo root).
    - The test command.
    - The serve command, plus `/ecg.html`.
    - "Click Disconnect before closing the tab."
    - Troubleshooting, one line: if Connect reports "The device has been lost." right away, another tool (pyserial, including the reference script in `Biomedic_ECG_USB_protocol.md` §11) left the port at `min 0`. Run `stty -F /dev/ttyACM0 min 1 time 0`, or replug the module.
    - A second troubleshooting line, worded like this so the static check finds it: "If Disconnect does not stop the module (it keeps streaming), or Connect shows frames but the module ignores its commands, unplug the module and plug it back in. It is the only known recovery. Then wait until `fuser /dev/ttyACM0` prints nothing before you click Connect." The existing "Click Disconnect before closing the tab" line stays as it is.

  **Acceptance:**
  - Static checks:
    ```
    python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/ecg.html').read(),re.S).group(1))" > /tmp/ecg_page.mjs && node --check /tmp/ecg_page.mjs && echo page syntax OK
    python3 -m http.server -b 127.0.0.1 -d Web 8001 >/dev/null 2>&1 & S=$!; sleep 1; for f in ecg.html ecg_dsp.js "" pcg_parser.js; do curl -s -o /dev/null -w "%{http_code} %{content_type} /$f\n" "http://localhost:8001/$f"; done; kill $S
    git diff --quiet HEAD -- Web/index.html Web/pcg_parser.js Web/pcg_audio.js Tests && echo PCG files unchanged
    grep -q "stty -F /dev/ttyACM0 min 1 time 0" README.md && echo README troubleshooting OK
    grep -q "unplug the module and plug it back in" README.md && echo README recovery OK
    python3 -c "s=open('Web/ecg.html').read(); c=s[s.index('async function connect'):s.index('async function disconnect')]; assert c.index('0x02') < c.index('0x01, 0x09'); print('stop before start OK')"
    ```
    The output must be:
    - `page syntax OK`.
    - `200 text/html /ecg.html`, `200 text/javascript /ecg_dsp.js`, `200 text/html /` and `200 text/javascript /pcg_parser.js`. Port 8001 avoids the user's server on 8000.
    - `PCG files unchanged`.
    - `README troubleshooting OK`.
    - `README recovery OK`.
    - `stop before start OK`.
  - **User check in Chrome.** The agents cannot see the screen. Items 1–5 worked in the second run and are not repeated. Item 1 still says how to open the page.
    1. From the repo root, run `python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8000`. Open `http://localhost:8000/ecg.html`. With RA, LA and RL on and sitting still, click Connect (or Tab to it and press Enter). Pick the only port offered: "MCP2200 USB Serial Port Emulator", ttyACM0.
    2. Within 2 s:
       - The stats line shows about 500 frames/s (E1's rate).
       - "Bytes skipped" stays the same from second to second.
       - The electrode line says RA and LA are on.
    3. For the first ~7 s a slow swing fills the trace. Then:
       - The scale settles near ±50–100 counts.
       - The ECG shows one sharp QRS per heartbeat, about 40 counts tall on the first capture.
       - The beats match the pulse at the wrist.
       - The baseline is flat, with no fine 50 Hz fuzz.
    4. Unclip LA:
       - Within about 2 s the line says "Lead I not valid: LA electrode off", and the trace jumps.
       - Clip it back: the line returns to "on", and the ECG returns within about 10 s.
       - If the line never changes, report it. The flags are then not wired for RA/LA on this unit, and the planner drops the electrode line.
    5. Leave it running for 3 minutes, past the 60 s and 120 s keep-alives. The trace keeps moving at about 500 frames/s.
    6. **Clean start and stop with the page as it is now.** Run this right after the replug, before the executioner's change. "Listen" means E1's listen command followed by the `stty` check (Steps, rules).
       1. Tester: wait 10 s after the replug, then until `fuser /dev/ttyACM0` prints nothing, because ModemManager may probe. If the kernel log names another `ttyACM` for `04d8:00df`, use that name wherever a command says `/dev/ttyACM0`. Then listen. It must print fewer than 1000 bytes: the module is idle after power-up. If it prints about 40 000, stop and report, with no Connect: the page as it is now would send a start to a streaming module.
       2. User: open the page as in item 1 and Connect. Within 3 s the stats line shows about 500 frames/s. Report whether the slow swing of a fresh start fills the trace. This Connect follows a pyserial command, so it also covers the old item 7 (Chrome after pyserial). After about 10 s, note the bytes-skipped number, then click Disconnect. The status reads "Disconnected."
       3. Tester: listen. Fewer than 1000 bytes shows that the page's stop works from a clean state, drain fix included.
    7. **Stop-first Connect.** Run this after the executioner's change and the static checks. The user first reloads the page with Ctrl+Shift+R, so Chrome loads the new `ecg.html`.
       1. User: Connect. Within 3 s about 500 frames/s. Report whether the swing appears and the bytes skipped after 10 s, then Disconnect.
       2. Tester: listen. Fewer than 1000 bytes: the stop sent to an idle module did no harm, and the start after it worked.
       3. User: Connect, wait until frames show, then close the tab without clicking Disconnect.
       4. Tester: listen. About 40 000 bytes: the module was left streaming, which is the case to test. If it prints fewer than 1000, report it and skip 5–6.
       5. User: wait 1 minute after closing the tab, because in the incident the module streamed unread for minutes. Open the page in a new tab and Connect. Within 3 s about 500 frames/s. Report whether the swing appears (a sign of a restart) and the bytes skipped after 10 s, then Disconnect.
       6. Tester: listen. Fewer than 1000 bytes: a Connect after a tab closed without Disconnect stops and restarts the module, and its Disconnect still works.

  - **If a check fails:** follow the line for it and report. Run nothing else that sends to the module.
    - 6.3 prints about 40 000: the user replugs. The tester waits as in 6.1, runs E1's capture and then the listen, and reports both. If pyserial's stop works, the fault is in the page's stop path. If not, the module goes deaf even on a plain start and stop from idle.
    - 7.1 shows about 0 frames/s: the module ignored the start that followed the stop. Disconnect. The executioner raises the wait between stop and start from 100 ms to 1000 ms, then the user repeats 7.1 and the tester 7.2. If it shows 0 frames/s again, stop and report.
    - 7.6 prints about 40 000: the stop-first Connect does not recover a module left streaming. The user replugs. The planner then makes the README tell users to replug after any session that ended without Disconnect.
    - Any other listen of about 40 000 where fewer than 1000 is expected: the user replugs, and the tester reports the item.
  - **Result:** E3 passes when:
    - The static checks print the output above.
    - Item 6: the listens in 6.1 and 6.3 print fewer than 1000 bytes, and the user saw about 500 frames/s in 6.2.
    - Item 7: the listens in 7.2 and 7.6 print fewer than 1000 bytes, the one in 7.4 prints about 40 000, and the user saw about 500 frames/s in 7.1, 7.3 and 7.5. If 7.4 prints fewer than 1000, the planner decides.
    - Every `stty` check prints `min = 1; time = 0`.

## Not doing

- Other leads: II, III and aVR/aVL/aVF need LL, and V1–V6 need chest electrodes.
- A µV or mV scale.
- Recording or export.
- Heart-rate or QRS detection.
- An ECG paper grid or sweep mode.
- Filter settings, and zero-phase filtering.
- Audio.
- Battery voltage (bytes 36–39 read 0).
- The vendor's saturation counters, and zeroing lead I when an electrode is off.
- Auto-reconnect, and sending the stop bytes when the tab closes: Chrome does not run a 100 ms timer in a closing tab, so the next Connect sends the stop instead.
- Finding which trigger makes the module ignore commands (Decisions): each positive test can cost a replug, and no answer would change the page.
- The Bluetooth model and the `0x0B` Identify command.
- Any change to the PCG page, the firmware, CMake, `.vscode` or the guide.

## Needs the user

- **Now:** unplug the ECG module, plug it back in and tell the tester. It is the only known way to make a deaf module obey again. Then do E3 item 6 with the tester.
- **During E1 and the E3 check:** keep RA, LA and RL on and sit still. Movement shows as large, slow swings.
- **Before the tester's capture or listen:** click Disconnect on the ECG page. Two programs reading one port each get only part of the bytes.
- **Before closing the tab:** click Disconnect. Closing the tab skips the stop bytes, so the module keeps streaming.
  - The earlier note that the next start restarts it was wrong: a start sent to a streaming module came before the module ignored all commands (Decisions).
  - The stop-first Connect should handle it, and E3 item 7 checks that. Until then, replug the module after a tab closed without Disconnect.
- **Further replugs may be needed:** E3 items 7.3–7.6 leave the module streaming on purpose. If 7.6 fails, or any other E3 check fails, the module needs another replug (E3, "If a check fails").
- **If you use pyserial yourself** (including the §11 reference script): set `port.inter_byte_timeout = 0.05` before `open()`, or run `stty -F /dev/ttyACM0 min 1 time 0` afterwards. Otherwise the next Connect in Chrome fails with "The device has been lost." Say if §11 of the protocol doc should get that line: the plan does not edit that file.
- **After re-plugging the module:** ModemManager probes the port for a few seconds. Wait until `fuser /dev/ttyACM0` prints nothing. Alternatively (needs sudo), add a udev rule with `ENV{ID_MM_DEVICE_IGNORE}="1"` for `04d8:00df`.
- **Your ECG recordings:** `/tmp/ecg.bin` (from E1) and the earlier scratchpad capture contain your ECG. Delete them when you are done. They are never committed.
- **Approval needed:** `Biomedic_ECG_USB_protocol.md` is untracked, but `ecg_dsp.js` and the README cite it. It documents a disassembly of the vendor's program. Should it be committed with the page, or kept out?
- **E3 browser check:** do it and report what you see. The agents cannot see the screen.
- **Open question:** does the module have an LED or another sign that it is streaming? Users could then spot a stuck module without the tester's listen, and the README could say how.
- **Open question, µV per count:** the page shows counts until there is a way to calibrate:
  - A known signal, for example 1 mV from an ECG simulator.
  - Or the scale factor found in the vendor program (§12, question 1).

  After that, switching to µV is one constant.
- **Fallback for 50 Hz hum:** if hum shows in another setup while E1's rate is correct, change the notch from Q 30 to Q 10.
  - At ±0.2 Hz from 50 Hz it attenuates −21 dB instead of −12 dB.
  - The cost is a dip 5 Hz wide. The ringing after a QRS stays under 0.02 counts in the planner's check.

  It is one number. Say if you want it.
