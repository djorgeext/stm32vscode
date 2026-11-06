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
  - [x] c. **User check with headphones.** The agent cannot hear the output. Passed 2026-11-06 on the recorder page (S16); the `index.html`-only items were not re-checked.
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

# PLAN: ECG viewer (Biomedic ECG, leads I and II)

**Goal:** draw leads I and II of the Biomedic ECG module live in Chrome, read from its USB serial port and filtered on the PC with the vendor program's resting-ECG chain (protocol §12), run forward only so that the trace has no delay.

**Revision of 2026-11-03.** This revision follows a new static analysis of `BiomedicECG-Setup.exe` (Findings below). Two changes:

- **E4:** the page sends its command bytes the way the vendor program does. E4 is proven on the real module first.
- **E5:** the §12 chain replaces the 0.5–150 Hz band-pass and the Q 30 notch, at the user's request. This new request replaces the earlier "IIR notch 50 Hz + band-pass 0.5–150 Hz", so the old chain is removed and not kept as an option.
- **E5 and E6, revised after the user's answers (2026-11-03):** every stage is always on, and the chain runs forward only, one sample at a time, with no display delay. The zero-phase 8 s window and its 0.5 s lag are dropped.

The old E3 items 6–7 are superseded by E4.

**E7 (2026-11-03), at the user's request "I want you to show me both leads I and II":** the page draws lead II as well, under the heading "ECG viewer (leads I and II)". E7 passed with the LL electrode on. E1–E7 are committed in `539c1e6`.

**D1 (2026-11-03), at the user's request "yes, correct the document and add the §11 line":** the five findings below are corrected in `Biomedic_ECG_USB_protocol.md`, and its §11 example gets the `inter_byte_timeout` line.

## Findings from the installer (2026-11-03)

**How this was done:**

- Static analysis only. The installer (SHA-256 `1d090a05…0c79`, as in protocol §2) was copied to an empty scratch directory and unpacked with innoextract 1.9. `app/BiomedicECG.exe` (SHA-256 `5f5feca4…e079`, as in §2) was disassembled with objdump.
- The import slots and data were read with the planner's own scripts. Nothing was executed, and nothing extracted went into the repo.
- Addresses are virtual addresses in that build.
- ✅ = read from the code. 🔶 = inferred.

### Communication

- ✅ **The serial API is all there is.**
  - KERNEL32 imports only `CreateFileA`, `SetupComm`, `GetCommState`/`SetCommState`, `GetCommTimeouts`/`SetCommTimeouts`, `PurgeComm`, `ReadFile`, `WriteFile`, `CloseHandle` and `Sleep`.
  - There is no `EscapeCommFunction`, so no DTR/RTS toggling and no break.
  - There is no `ClearCommError`, `SetCommMask`/`WaitCommEvent`, `FlushFileBuffers` or `DeviceIoControl`.
  - There is no `LoadLibrary`/`GetProcAddress`, no `hid.dll`/`setupapi` and no HID string. Qt5SerialPort is used only for `QSerialPortInfo` enumeration.
  - So the program never configures the MCP2200 over HID, never resets anything and never recovers from errors.
- ✅ **Open (`0x496EF0`):**
  - `CreateFileA(GENERIC_READ|GENERIC_WRITE, no sharing, OPEN_EXISTING)`, non-overlapped, so every `WriteFile` is synchronous. Then `SetupComm(32768, 32768)`.
  - `GetCommState`, then changes only these DCB fields:
    - BaudRate = 230400.
    - The bit mask `0xFFFFCFC3` (`0x496F78`) clears CTS and DSR handshaking and sets DTR control and RTS control to DISABLE.
    - ByteSize 8, Parity none, StopBits 1 (`0x496F8C`, `0x496F93`).
  - Every other DCB field is left as the driver had it, including XON/XOFF and `fAbortOnError`.
  - Timeouts: read total constant 10 000 ms, read multiplier 0, write total constant 3000 ms, write multiplier 0. `ReadIntervalTimeout` is not set.
  - Then `PurgeComm(0x0C)`, which is TX clear + RX clear without the abort flags.
- ✅ **Start (`0x493E78`–`0x493EA6`):** no delay after open.
  - `0x497270`: `PurgeComm(0x0C)` plus a 1-byte `WriteFile(01)`.
  - `msleep(100)`.
  - `0x497270` again.
  - Then `0x497210`: its own 1-byte `WriteFile(09)`, with no sleep before it.

  Every command byte is a separate synchronous `WriteFile`. **The program never sends two command bytes in one write.** The success flag of the start helper is ignored, and there is no retry.
- 🔶 **The page differs here, and only here:** it sends `01 09` as one 2-byte write, so both bytes travel in one USB packet and reach the UART back to back.
  - E1's pyserial capture, the only start/stop pair that ever worked, used two separate `write()` calls.
  - Every start in the sessions before the module went deaf came from the page.
- ✅ **Read loop:** one byte per `ReadFile`, hunting `01 C0`. Purges only clear the PC-side buffer, so frames that are already arriving are just hunted through. Nothing is ever sent in reaction to frames, flags or errors.
- ✅ **Keep-alive:** `09`, `msleep(5)`, `09` every 30 000 frames (`0x4951B4`–`0x4951D3`). This is the program's only explicit gap between two command bytes.
- ✅ **Stop:** only when the user stops, checked once per byte hunt (`0x493ED0` → `0x4951E8`). The sequence is `02`, `msleep(100)`, `02`, then `CloseHandle` (`0x497110`), with no purge, flush or delay. Because the writes are synchronous, both bytes have left the driver before the close.
- ✅ **No stop on an error:** a read that returns no byte (an error, or the 10 s timeout) throws. The handlers at `0x495209`/`0x49525C`/`0x495293` set "Device read error" or "Unexpected error" and jump to `0x495227`, which closes the port **without the stop bytes**. The vendor program can therefore also leave the module streaming, and its next start then reaches a streaming module.
- 🔶 **Its own second `01` probably reaches a streaming module too:** it is sent 100 ms after the first, in every session. "A start received while streaming" is therefore normal vendor behaviour and a weak suspect for the deaf module.
- ✅ **The second acquisition class** (vtable `0x518AD0`, run loop `0x495E20`) is the **"HRProtocol"** variant:
  - It is chosen only when the QSettings bool `Config/HRProtocol` is true (`0x40701F`, `0x407123`, `0x407253`). The default is false.
  - It opens at **570 000 baud** (`0x4958FA`, `0x407150`).
  - It sends the keep-alive every **60 000** frames (`0x495F08`, `0x496D94`).
  - Its blocks start with `C0` and have no `01`/`02`/`03` marker (`0x495F56`).
  - Its start and stop sequences match the 230400 class.

  The USB path with the default setting uses the 230400 class (`0x4072CB` → `0x491710` → `0x491AE0`), and E1 confirms that the module speaks it.
- 🔶 **Linux and Web Serial, compared with Windows:**
  - Linux `cdc_acm` raises DTR and RTS on every open and drops them on close. That covers Chrome, pyserial, `stty -F`, and ModemManager if it probes. The page then lowers them with `setSignals`. The MCP2200 has no DTR pin, and its RTS pin works only with hardware flow control, so this is probably harmless.
  - ModemManager, if it probes after a plug-in, is the only other program that sends bytes to the module (AT commands). E4.1 checks its log without sending anything.

### Where the user's document is contradicted or incomplete (corrected in D1)

- Appendix A says the second acquisition thread "uses the same commands, frame layout…". The commands and timings are the same. The baud rate (570 000), the keep-alive interval (60 000 frames) and the block markers (`C0` only) differ (above).
- §5 "Flow control: none": the program clears only CTS/DSR handshaking and DTR/RTS control. XON/XOFF and `fAbortOnError` are inherited from the driver (`0x496F78`).
- §6 and §7 read as if every session ends with the stop. After a read error the program closes without it (`0x495227`).
- §12.1 "used by the live monitor":
  - ✅ The chain is built over a record of known length: the trend uses its first and last 3 s, set at build time (`0x466C43`, `0x46FE70`). It is processed in 4096-sample blocks (`0x447034`, `0x461C46`).
  - ✅ The monitor's filter buttons rebuild it (`0x43CE90`–`0x43CEC1`).
  - 🔶 How the monitor filters samples while it is still acquiring was not traced.
- §12.1 "the output is truncated and clamped to 16 bits" is true of the IIR stages as well (`0x472C7F`–`0x472CB7`), not only of the FIR.
- §12.2's SciPy sketch differs from the program at the edges:
  - It uses `filtfilt` (odd-extension padding) and `mode="nearest"` for the FIR.
  - The program starts each pass from zero state and reads zeros beyond the available data (`0x472838`, `0x472E5D`). The backward pass also starts `margin` samples after the end.

### Filters

- ✅ **The coefficients in §12.2 are the program's tables at 500 Hz:**
  - IIR stages at `0x506CA0`–`0x506DF8`, with the feedback terms stored negated and the `a[0]` slot at 0. The 12-tap "40hz" FIR is at `0x509B28` and the 19-tap "25hz" at `0x509C38`.
  - Planner's check with scipy 1.11.4: stage 1 and stage 4 equal `butter(2, 0.25, 'high', fs=500)` and `butter(4, 0.75, 'high', fs=500)` to 4e-15.
  - The notch zeros are at 49.965 Hz and 99.992 Hz, with pole radius 0.9752. All poles are inside the unit circle, and the notch and FIR have a DC gain of 1.
- ✅ **Stage order and margins** (the pipeline is linked through `[ebx+0x74]`, so build order is processing order):
  1. Trend (`0x466EC0`).
  2. HP order 2, margin 2000 (`0x466FBB`).
  3. NF order 4, margin 500 (`0x4672E5`).
  4. MF FIR (`0x467649`).
  5. HF order 4, margin 3000 (`0x46780F`).

  This matches §12.1.
- ✅ **How the stages work:**
  - **IIR (`0x472760`):** a direct-form pass from zero state over `[−margin, n+margin)`, with zeros where no neighbouring block exists, then a backward pass over that buffer. The output is clamped to ±32767 and truncated toward zero.
  - **FIR (`0x472DA0`):** `y[n] = Σ h[k]·x[n + taps/2 − k]`, with the centre at taps/2 (`0x467619`–`0x467622`) and zeros outside the data.
  - **Trend:** a line through (750, m0) and (L − 750, m1), where m0 and m1 are the means of the first and last 1500 samples (`0x466DF4`–`0x466E23`, `0x470070`).
  - **The start-up transient** is handled only by this trend removal plus the zero-state passes. There is no first-sample subtraction and no steady-state initial condition.
- ✅ **MF choice:** `"25hz"` selects the 19-tap table, and `"40hz"` (the constructor default at `0x4665CB`) the 12-tap one. 🔶 Which buttons start checked is set in the form setup, which was not traced.
- **Responses (planner, scipy):** the chain run forward and backward reproduces §12.1:
  - HP −3 dB at 0.312 Hz and HF at 0.838 Hz.
  - Notch −3 dB band 46.93–53.17 Hz, −70.5 dB at 50.000 Hz.
  - MF40 −3 dB at 39.5 Hz and −5.1 dB at 50 Hz.

## Decisions

- **Where:** everything stays in `PCG_CDC/`:
  - `Web/ecg.html`, `Web/ecg_dsp.js` and `Tests/ecg_dsp_test.mjs`.
  - The README section "ECG viewer (Biomedic ECG module)".

  `index.html`, `pcg_parser.js`, `pcg_audio.js` and the PCG tests stay byte-identical. No firmware, CMake, linker, HAL, `.vscode` or guide change.
- **Data path (unchanged):** Web Serial on the MCP2200 CDC-ACM port (`04d8:00df`), opened with `{ baudRate: 230400, bufferSize: 65536 }`, 8N1 with no flow control. This is a platform feature: no driver, backend or npm.
- **pyserial and VMIN (unchanged, confirmed 2026-10-30):** every pyserial command in this plan sets `p.inter_byte_timeout = 0.05` before `open`, so it leaves the port at `min 1 time 0`. Otherwise Chrome's next Connect fails with "The device has been lost.". Anyone else can run `stty -F /dev/ttyACM0 min 1 time 0`, or replug.
- **Commands, one byte per write (E4, new):**
  - Every command byte gets its own `writer.write()`, as the vendor sends each byte with its own synchronous `WriteFile` (✅ above).
  - **Connect:** `02`, 100 ms, `02`, 100 ms, `01`, 100 ms, `01`, 5 ms, `09`.
    - The 5 ms gap is the vendor's keep-alive spacing, its only explicit gap between two command bytes. It keeps `01` and `09` out of one USB packet (🔶 the vendor's real gap is one synchronous USB write, about 1 ms).
  - **Keep-alive:** `09`, 5 ms, `09` every 30 000 frames, counted as now. Same bytes as before.
  - **Disconnect:** `02`, 100 ms, `02`, then `await port.writable.close()`, which drains like the vendor's synchronous writes, then cancel the reader and close the port. Unchanged, because the vendor does the same.
  - A whole sequence holds one writer lock inside the one write chain, so a Disconnect clicked during Connect queues its stop after the whole start.
- **Stop before start on every Connect (🔶, the page's own choice):**
  - A tab closed without Disconnect leaves the module streaming. The vendor's error exit does the same and never recovers from it (✅ `0x495227`).
  - The stop-first sequence only creates module states that a normal vendor session also creates:
    - `02` while streaming, and `02` while idle (the vendor's second `02`).
    - `01` while idle, and `01` while probably streaming (the vendor's second `01`).
  - Cost: 200 ms per Connect.
- **What may make the module deaf (all 🔶; only H1 and H3 are tested, in E4):**
  - **H1, two command bytes in one USB packet:** only the page did this, and E4 removes it.
  - **H2, a start while streaming:** weak, because the vendor does it in every session.
  - **H3, streaming for minutes with nobody reading:** E4.5–4.6 test it, with 1 minute.
  - **H4, the MCP2200's host-to-UART path stalled, for example by hardware flow control set in its EEPROM:** the software cannot see this, and the vendor never reads the bridge's configuration. A read-only HID query could tell, but only with the user's approval (Needs the user).
  - **H5, ModemManager AT probes after a plug-in:** E4.1 checks its log.
- **Recovery from a deaf module:** unplug it and plug it back in. Nothing in the vendor program recovers either.
- **Parser and electrode line (unchanged):**
  - `createParser` uses the six-marker check (§8.1). Lead I is the big-endian int16 at offset 6.
  - RA off is `B1 & 0x60` and LA off is `A1 & 0x20`. LL is ignored until E7 (below).
  - The `role="status"` electrode line is updated only when its text changes.
- **Filters (E5, revised after the user's answers of 2026-11-03): the vendor's resting-ECG chain, always on, run causally. Each sample gets one forward pass through every stage, in the vendor's order, at 500 Hz.**
  - The stages:
    1. First-sample subtraction, in place of the trend removal (below).
    2. 0.25 Hz Butterworth high-pass, order 2 (HP `b1`/`a1`).
    3. 50 + 100 Hz notch, order 4 (NF `b2`/`a2`).
    4. The 12-tap "40hz" FIR (`h40`).
    5. 0.75 Hz Butterworth high-pass (HF), order 4 (`b4`/`a4`).
  - The coefficients are those of §12.2 and the program's tables, at 500 Hz.
  - Each IIR stage is the vendor's direct form `y[n] = Σ b[k]x[n−k] − Σ_{k≥1} a[k]y[n−k]`, run once, forward, from zero state. There is no backward pass and there are no margins.
  - The FIR runs causally, `y[n] = Σ h40[k]·x[n−k]`. It is not centred, so it delays by 5.5 samples (11 ms).
  - **Always on (the user, 2026-11-03: "The filters must be always on"):** no buttons and no options.
  - **Trend removal becomes "subtract the first sample"**, as the current `createEcgFilter` already does:
    - The vendor's line needs the mean of the last 3 s of a finished record, which a live trace never has.
    - A live line fit is not needed. HP and HF have 2 and 4 zeros at DC, so offset and linear drift go to 0 once settled. A ramp stays under 0.25 counts from 3 s on (planner's prototype).
    - The subtraction makes zero state the settled state for a constant, so a constant gives exact zeros. The electrode offset (about −3000 counts) therefore does not ring the high-passes for seconds.
  - **Start-up transient: no skip.**
    - On the swing modelled on E1 (9000 counts, τ 0.8 s), the output stays inside ±60 counts from 2.1 s after Connect.
    - Skipping the first 1 s gives 2.3 s, so a skip buys nothing.
    - E6.1 measures the real swing.
  - **No display delay (the user, 2026-11-03: "No delay: an instant display (filter only forward, sample by sample, with no delay)"):**
    - Each sample is filtered when it arrives and drawn on the next animation frame.
    - The filters' own group delay remains: a QRS peak comes out 5 samples (10 ms) after it went in, and the group delay is 12–17 ms over 10–40 Hz. No causal filter with this FIR can avoid it.
  - **The trade-off the user accepted (2026-11-03):** forward-only filtering does not cancel the phase shift, so it distorts slow waves.
    - On the planner's synthetic ECG, the T wave is 3.4 counts against 7.2 with the vendor's zero-phase filters (input 9.2).
    - The ST level is −6.7 counts against −2.8 (input −0.2).
    - So the page does not match the vendor's waveform in T and ST. QRS timing and rhythm are kept. The page caption and the README say so.
  - **Responses of one forward pass** (scipy `freqz` of the §12.2 coefficients; the planner's JS prototype matched it to 0.001 dB at every test frequency):
    - HP −3 dB at 0.250 Hz and HF at 0.751 Hz. The whole chain is within 3 dB from 0.75 to 38.8 Hz.
    - Notch: −3 dB band 47.99–52.01 Hz.
      - It gives −35.2 dB at 50.000 Hz, and −38.9 dB at 49.988 Hz, where mains falls at E1's 500.12 frames/s.
      - ±0.2 Hz off, it still gives −21.7 dB (49.8 Hz) and −18.7 dB (50.2 Hz).
      - With the FIR, the whole chain gives −40.3 dB at 50 Hz and −84.8 dB at 100 Hz.
    - FIR: −3.08 dB at 40 Hz, −5.07 dB at 50 Hz and −40.2 dB at 150 Hz.
    - A 40-count synthetic QRS (σ 12 ms) shows as about 32 counts, mostly because of the FIR.
  - **The user's high-frequency noise:** the old chain's low-pass was −3 dB at 150 Hz, so it passed almost everything the module sends. The new chain is −3 dB at 38.8 Hz and −40 dB at 150 Hz, so it should remove that noise. E6.1 asks the user.
  - Values stay in doubles between stages, with no int16 truncation, so they differ from the vendor by under 1 count per stage. The browser has no reason to round.
  - `RATE` stays 500.
  - **Dropped with the user's answer:** the zero-phase sliding-record view (`WINDOW` 8 s, `LAG` 0.5 s, `SKIP` 2 s) and its 7.5 s blank start. It matched the vendor's waveform to 2.6 counts, but it drew 0.5 s behind the module.
  - A JS prototype of this chain (planner's scratch, not repo code) matched scipy `lfilter` of the same stages to 3.9e-6 counts.
- **Amplitude in counts (unchanged):** the µV per count is unknown (§13, question 1).
- **Display (unchanged by E5):** the page's `draw()`, ring and stats stay as they are.
  - The ring holds **filtered** lead I (`Float32Array(RING)`, 5 s). The read loop fills it one sample at a time with `filter(v)`, as now.
  - The 1-2-5 autoscale with a ±50-count floor, and the guard of at least one sample per pixel column, stay.
- **Leads I and II (E7):**
  - **Parser:** `push()` returns one `[I, II]` pair per frame, from offsets 6 and 8 (§8). Keeping both leads of a frame in one entry means the page cannot misalign them. 500 small arrays per second cost nothing.
  - **LL flag:** `stats.llOff` is `A1 & 0xC0` (§8.3). Lead I is invalid when RA or LA is off, and lead II when RA or LL is off.
  - **Electrode line:** `electrodeLine(stats)` in `ecg_dsp.js` builds the text, so the eight cases get a node test instead of eight unclip tests on the user.
  - **Filters:** one `createEcgFilter()` per lead. Each IIR stage keeps its own lead's past samples, so one shared instance would mix the leads.
  - **Display:** two canvases, `traceI` and `traceII`, each under an `<h2>` label and with its own ring. Both are drawn by the existing `draw()`, which now takes the trace as an argument.
  - **Autoscale per lead, not shared:** without LL, lead II sits at the rail, and a shared scale would flatten lead I to a line. Each trace's grid labels and the stats line ("scale I ±…, II ±… counts") give the scales, so amplitudes can still be compared.
  - **No zeroing:** invalid leads are drawn as sent, unlike the vendor, which zeroes them. The electrode line says which lead is invalid.
  - **Unchanged:** the E4 communication code, the §12 filter chain and `isFrame`.
- **Test data (unchanged):** synthetic only. Real captures are the user's ECG: they never go into the repo or into a fixture.

## Steps

Commands run from `Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC` unless they say "repo root".

Rules for anything that touches the device:

- Only the page, E1's capture command and E1's listen command ever send to or read from the module. The listen sends nothing.
- The Python commands find the port by VID:PID and set `p.inter_byte_timeout = 0.05` before `open`. Never drop that line.
- After a listen or a capture, `stty -F /dev/ttyACM0 -a | grep -o 'min = [0-9]*; time = [0-9]*'` must print `min = 1; time = 0`. `stty` sends nothing.
- "Listen" means E1's listen command followed by that `stty` check.
- Run the Python blocks exactly as written: the heredocs must stay unindented.

- [x] E1. **Real stream and sample rate (tester only, no code).**
  **Result (2026-10-30):**
  - 500.12 frames/s over 10 s, so `RATE` stays 500.
  - lock_at 77, 0 skipped after lock, 5956 frames.
  - RA_off 0, LA_off 0, LL_off 5543.
  - Lead I −4206…−2302.
  - Listen after the stop: 0 bytes in 2 s.

  These two commands are E4's fallback and the only pyserial commands in this plan.

  The capture runs 12 s with the vendor sequence and writes `/tmp/ecg.bin`:

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

  The listen opens the port for 2 s and sends nothing:

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

  A listen prints under 1000 bytes for an idle module and about 40 000 for a streaming one.
- [x] E2. **Parser and filter, with the self-check (2026-10-30).** 7/7 tests passed, and the replay of the real capture matched. The parser and its tests 1–5 stay. The filter half is replaced by E5.
- [x] E3. **Page and README (2026-10-30, commit `8c56a39`).** Items 1–5 of the second run passed: about 500 frames/s, the electrode line, the LA-off warning, more than 3 minutes and the keep-alives. The module then stopped obeying commands (status file). Items 6–7 and the README recovery line move to E4. The stop-first Connect planned there was never built, and E4 builds it.
- [x] E4. **Vendor-identical command bytes, proven on the real module (hardware first).**
  **Result (2026-11-03):** all items passed. Static checks: all four lines. Item 1: listen 0 B, ModemManager "not supported by any plugin", nothing claimed. Cycles 1–3: listens 0/0/0 B, the user saw about 500 frames/s and the swing. Item 5 (tab closed without Disconnect): listen 40 024 B. Item 6: Connect after about 17.5 min of unread streaming restarted the module with the swing (user-confirmed); a void run where the tab was closed was redone, and the redo listened 40 031 B before and 0 B after Disconnect, with about 500 frames/s, the swing and "Disconnected.". Every `stty` printed `min = 1; time = 0`.

  Files:
  - `Web/ecg.html`: `send()` and its three callers.
  - `README.md`: one line.

  Changes:
  1. **`send(...steps)`:**
     - Each array is written with its own `w.write(new Uint8Array(step))`, and each number is a wait of that many ms. The whole call holds one writer lock inside the existing `writes` chain, and the existing `.catch(() => {})` stays.
     - Its comment says why: the vendor sends every command byte with its own `WriteFile` (protocol Appendix A `0x497270`/`0x497210`/`0x4972C0`).
  2. **Connect** replaces `send([0x01], 100, [0x01, 0x09])` with exactly `send([0x02], 100, [0x02], 100, [0x01], 100, [0x01], 5, [0x09]);`.
     - One comment line: stop first, because a tab closed without Disconnect leaves the module streaming. The 5 ms keeps `01` and `09` in separate USB packets, as the vendor's separate writes do.
     - The existing "no purge in Web Serial" note stays.
  3. **Keep-alive** stays `send([0x09], 5, [0x09])`. **Disconnect** stays `send([0x02], 100, [0x02])`, followed by the drain, as now.
  4. **README:** after the existing `stty` troubleshooting line, add exactly this line: "If Disconnect does not stop the module (it keeps streaming), or Connect shows frames but the module ignores its commands, unplug the module and plug it back in. It is the only known recovery. Then wait until `fuser /dev/ttyACM0` prints nothing before you click Connect."

  **Acceptance, static (tester):**
    ```
    python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/ecg.html').read(),re.S).group(1))" > /tmp/ecg_page.mjs && node --check /tmp/ecg_page.mjs && echo page syntax OK
    python3 -c "s=open('Web/ecg.html').read(); c=s[s.index('async function connect'):s.index('async function disconnect')]; d=s[s.index('async function disconnect'):]; assert 'send([0x02], 100, [0x02], 100, [0x01], 100, [0x01], 5, [0x09]);' in c; assert 'send([0x02], 100, [0x02])' in d; assert 'send([0x09], 5, [0x09])' in s; assert '0x01, 0x09' not in s; print('vendor command bytes OK')"
    grep -q "unplug the module and plug it back in" README.md && echo README recovery OK
    git diff --quiet HEAD -- Web/index.html Web/pcg_parser.js Web/pcg_audio.js Tests/pcg_parser_test.mjs Tests/pcg_audio_test.mjs Tests/pcg_filter_test.c && echo PCG files unchanged
    ```
    It must print `page syntax OK`, `vendor command bytes OK`, `README recovery OK` and `PCG files unchanged`.

  **Acceptance, on the module** (the user and the tester; the agents cannot see the screen). The module must be in a clean state: plugged in fresh, with nothing sent to it since.

  The page is served from the repo root with `python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8000`. Before the first Connect, the user hard-reloads `http://localhost:8000/ecg.html` with Ctrl+Shift+R.

  The user keeps RA, LA and RL on and sits still.
  1. **Tester, before any Connect:**
     - Wait 10 s after the plug-in, then until `fuser /dev/ttyACM0` prints nothing. If the kernel log names another `ttyACM` for `04d8:00df`, use that name.
     - Run `journalctl -b -u ModemManager --no-pager | grep -i -E 'ttyACM|04d8'` and report its output. It sends nothing. Lines naming the module's port mean ModemManager sent it AT probes (H5). A permission error is fine: report it.
     - Listen: under 1000 bytes. If it prints about 40 000, the module is not idle. Stop and report, with no Connect.
  2. **User:** Connect.
     - Within 3 s the stats line shows about 500 frames/s, and the slow swing of a fresh start fills the trace.
     - After 10 s, note the "bytes skipped" number, then click Disconnect. The status reads "Disconnected.".
  3. **Tester:** listen: under 1000 bytes.
  4. **Repeat 2–3 twice**, for three clean cycles in all. The module went deaf only after several sessions.
  5. **User:** Connect, wait until frames show, then close the tab without clicking Disconnect. **Tester:** listen: about 40 000 bytes. The module was left streaming, which is the case to test. If it prints under 1000, report it and skip 6.
  6. **User:** wait 1 minute (H3), open the page in a new tab and Connect.
     - Within 3 s about 500 frames/s, and the swing appears. The swing means the stop-first sequence stopped the module and the start restarted it.
     - Then Disconnect. **Tester:** listen: under 1000 bytes.

  **If a check fails,** follow the line for it, report, and run nothing else that sends to the module:
  - **A listen in 1, 3 or 4 prints about 40 000:** the module went deaf on vendor-identical bytes. The user replugs. The tester waits as in 1, then runs E1's capture and then the listen, and reports both. The planner decides next, with no further Connect.
  - **2 shows about 0 frames/s:** Disconnect, and the tester listens. The executioner raises the wait between the second `02` and the first `01` from 100 to 1000 ms. The user repeats 2 and the tester 3, once. If it shows 0 again, stop and report.
  - **6 shows frames but no swing, or its listen prints about 40 000:** the stop-first Connect does not recover a module left streaming. The user replugs. The planner then makes the README tell users to replug after any session that ended without Disconnect.

  **E4 passes when:**
  - The static checks print the four lines.
  - The listens in 1, 3 (three times) and 6 print under 1000 bytes, and the one in 5 prints about 40 000.
  - The user saw about 500 frames/s and the swing in every Connect.
  - Every `stty` check prints `min = 1; time = 0`.
- [x] E5. **The §12 chain, forward only, replaces the old filters (no device; only after E4 passes).**
  **Result (2026-11-03):** tests 8/8 (plus PCG 10/10 and 11/11), all static checks printed, scipy max difference 3.9e-6 counts; verified by the executioner and re-run by the tester.

  Files:
  - **`Web/ecg_dsp.js`:**
    - Remove `biquad`, `design`, `highpass`, `lowpass` and `notch`. `FRAME_BYTES`, `RATE`, `isFrame` and `createParser` stay byte-identical.
    - Add the coefficients of §12.2 as constants: `HP = [b1, a1]`, `NF = [b2, a2]`, `HF = [b4, a4]`, and the 12-tap `H40`. A one-line comment gives the source: protocol §12.2, and the tables at `0x506CA0`–`0x506DF8` and `0x509B28`.
    - Add one private helper, `direct(b, a = [1])`. It returns `x => y`, the direct form `y[n] = Σ b[k]x[n−k] − Σ_{k≥1} a[k]y[n−k]` from zero state, as in the vendor's `0x472760` forward pass. With `a = [1]` it is the causal FIR.
    - **`createEcgFilter()` keeps its name and its `x => filtered x` interface**, so the page needs no code change. Its body becomes:
      ```
      const stages = [direct(...HP), direct(...NF), direct(H40), direct(...HF)];
      let x0 = null;
      return (x) => stages.reduce((v, f) => f(v), x - (x0 ??= x));
      ```
    - Its comment says why, in at most three lines:
      - The user chose no display delay, so every stage runs forward only, one sample at a time, and T and ST are distorted (Decisions).
      - Subtracting the first sample replaces the vendor's trend removal, which needs the end of a record. It also starts the chain settled on the electrode offset.
      - Values stay in doubles, where the vendor truncates to int16, a difference under 1 count per stage.
  - **`Web/ecg.html`: the caption only** (the `<figcaption>`). The import, `filter = createEcgFilter()`, the ring and the read loop stay byte-identical. The new caption is exactly:
    "Lead I (LA − RA), 500 samples/s, filtered on the PC with the vendor's resting-ECG filters, always on: 0.25 Hz high-pass, 50 and 100 Hz notch, 40 Hz low-pass and 0.75 Hz baseline filter. They run forward only, one sample at a time, so the trace has no delay, but T waves and ST segments look different from the vendor's program. Last 5 s, newest on the right. The scale is in ADC counts, because the module's µV per count is not known. For about 2 s after Connect the trace shows the module's input settling."
  - **`Tests/ecg_dsp_test.mjs`:**
    - The import, tests 1–5 and the `gainDb` helper stay unchanged.
    - Replace tests 6–7 and add test 8:
      6. **Frequency response of one forward pass.** `gainDb(hz)` at each frequency below. Every frequency is a multiple of 0.1 Hz, so the 10 s RMS window holds whole periods. Expected values (planner's prototype, equal to scipy `freqz` to 0.001 dB):

         | Frequency | Expected gain |
         |---|---|
         | 0.3 Hz | −33.55 ± 0.1 dB |
         | 0.5 Hz | −14.52 ± 0.1 dB |
         | 0.7 Hz | −4.44 ± 0.05 dB |
         | 1 Hz | −0.43 ± 0.05 dB |
         | 10 Hz | −0.18 ± 0.05 dB |
         | 25 Hz | −1.15 ± 0.05 dB |
         | 40 Hz | −3.22 ± 0.05 dB |
         | 46 Hz | −5.12 ± 0.05 dB |
         | 50 Hz | below −38 dB (−40.32) |
         | 54 Hz | −7.07 ± 0.05 dB |
         | 100 Hz | below −60 dB (−84.83) |
         | 150 Hz | −40.24 ± 0.2 dB |

         A forward-backward chain gives about twice these dB values, for example −29 dB at 0.5 Hz, so the test fails if the zero-phase passes come back.
      7. **Constant, ramp and step.** Each signal is 10 s long and goes through its own `createEcgFilter()`.
         - A constant 3000 gives exactly 0 on every sample (`!== 0` count 0, planner: 0).
         - The ramp `3000 + 0.7·k` stays within ±0.5 counts from 3 s on (planner: 0.22). This is the check that the first-sample subtraction and the high-passes together replace the trend removal.
         - A step from 3000 to 3100 at 1 s stays within ±1 count from 4 s on (planner: 0.44), as in the old test.
      8. **No display delay: each QRS comes out 10 ms late, with wander and hum removed.**
         - The signal: 40 s at `RATE`, with `t = k / RATE` and `d = t − 0.3 − 0.85·Math.round((t − 0.3) / 0.85)`. Each beat is `40·g(d, 0.012) − 8·g(d − 0.03, 0.01) + 10·g(d − 0.28, 0.05)`, with `g(d, s) = exp(−d²/2s²)`. Add `30·sin(2π·0.3t)` and `10·sin(2π·50t)`.
         - All 20 000 samples go through one `createEcgFilter()`, in order.
         - For every beat centre `c = Math.round((0.3 + 0.85·i)·RATE)` with `10·RATE ≤ c ≤ 39·RATE`, let `m` be the index of the largest output in `[c − 20, c + 30]`.
         - Assert `0 ≤ m − c ≤ 8` (planner: 5 on every beat) and `28 ≤ y[m] ≤ 36` (planner: 31.43…32.69).
  - **`README.md`:** in the ECG section, replace the filter sentences ("`Web/ecg_dsp.js` filters on the PC: a 0.5–150 Hz band-pass … (Q 30). The first ~7 s after Connect show the module's input settling.") with exactly:
    "`Web/ecg_dsp.js` filters on the PC with the vendor program's resting-ECG filters (protocol §12), always on: a 0.25 Hz Butterworth high-pass, a 50 + 100 Hz notch, a 40 Hz FIR low-pass and a 0.75 Hz baseline filter. They run forward only, one sample at a time, so the trace has no delay. Unlike the vendor's zero-phase filtering, this shifts slow waves, so T waves and ST segments differ from the vendor's program. The first ~2 s after Connect show the module's input settling."

  **Acceptance (tester):**
  - `node Tests/ecg_dsp_test.mjs`, `node Tests/pcg_parser_test.mjs` and `node Tests/pcg_audio_test.mjs` all end with `fail 0`.
  - Static checks:
    ```
    python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/ecg.html').read(),re.S).group(1))" > /tmp/ecg_page.mjs && node --check /tmp/ecg_page.mjs && echo page syntax OK
    ! grep -n "biquad\|highpass\|lowpass\|notch(\|0.5–150\|0.5-150\|Q 30" Web/ecg_dsp.js Web/ecg.html Tests/ecg_dsp_test.mjs README.md && echo old chain gone
    grep -q "0.25 Hz" README.md && grep -q "0.25 Hz" Web/ecg.html && grep -q "forward only" README.md && grep -q "forward only" Web/ecg.html && echo new chain documented
    grep -qF "import { createParser, createEcgFilter, RATE } from './ecg_dsp.js';" Web/ecg.html && grep -qF "ring[written++ % RING] = filter(v)" Web/ecg.html && echo page wiring unchanged
    git show HEAD:./Web/ecg_dsp.js | sed -n '/^const isFrame/,/^}/p' > /tmp/ecg_parser_old.js && sed -n '/^const isFrame/,/^}/p' Web/ecg_dsp.js | cmp - /tmp/ecg_parser_old.js && echo parser unchanged
    python3 -m http.server -b 127.0.0.1 -d Web 8001 >/dev/null 2>&1 & S=$!; sleep 1; for f in ecg.html ecg_dsp.js "" pcg_parser.js; do curl -s -o /dev/null -w "%{http_code} %{content_type} /$f\n" "http://localhost:8001/$f"; done; kill $S
    git diff --quiet HEAD -- Web/index.html Web/pcg_parser.js Web/pcg_audio.js Tests/pcg_parser_test.mjs Tests/pcg_audio_test.mjs Tests/pcg_filter_test.c && echo PCG files unchanged
    ```
    It must print:
    - `page syntax OK`, `old chain gone`, `new chain documented`, `page wiring unchanged` and `parser unchanged`.
    - The four `200` lines (`text/html` for `/ecg.html` and `/`, `text/javascript` for the two `.js` files).
    - `PCG files unchanged`.
  - **Cross-check against scipy,** an independent implementation of the same causal chain. Synthetic data only, with a 5000-count start-up swing and 50 Hz hum:
    ```
    node --input-type=module -e "import {createEcgFilter, RATE} from './Web/ecg_dsp.js'; import {writeFileSync} from 'node:fs'; const x=Float64Array.from({length:20*RATE},(_,k)=>3000+40*Math.sin(k/7)+5000*Math.exp(-k/400)+10*Math.sin(2*Math.PI*50*k/RATE)); const y=x.map(createEcgFilter()); writeFileSync('/tmp/ecg_x.f64',Buffer.from(x.buffer)); writeFileSync('/tmp/ecg_y.f64',Buffer.from(y.buffer)); console.log('page samples', y.length)"
    ```

```
python3 - <<'EOF'
import numpy as np
from scipy import signal
x, y = np.fromfile("/tmp/ecg_x.f64"), np.fromfile("/tmp/ecg_y.f64")
b1 = [0.997781024102941, -1.99556204820588, 0.997781024102941]; a1 = [1, -1.99555712434579, 0.995566972065975]
b2 = [0.951558090821252, -2.1284207536999, 2.85527558178394, -2.1284207536999, 0.951558090821252]
a2 = [1, -2.18192506761969, 2.85407296314357, -2.07491643978012, 0.904318800282871]
b4 = [0.987761389276826, -3.9510455571073, 5.92656833566095, -3.9510455571073, 0.987761389276826]
a4 = [1, -3.97537191256092, 5.92641855596542, -3.92671919775679, 0.975672562146085]
h = [-0.00812031626499363, 0.00279430037155961, 0.0363062486230826, 0.0960723789024121, 0.163761187856556, 0.209186200511384]
h = h + h[::-1]
v = x - x[0]  # the page's start: subtract the first sample, then one forward pass per stage from zero state
for b, a in [(b1, a1), (b2, a2), (h, [1]), (b4, a4)]: v = signal.lfilter(b, a, v)
print("max |page - scipy|", np.abs(y - v).max(), "counts")
EOF
```

    It must print `page samples 10000` and `max |page - scipy|` below `1e-3` counts. The planner's prototype gave 3.9e-6.
- [x] E6. **The new filters on the real module (user and tester).**
  **Result (2026-11-03), user-confirmed:**
  - About 500 frames/s; QRS present, R peak a little below 30 counts.
  - High-frequency noise "reduced", and the user is satisfied with the level.
  - The LA tap blip appeared at once.
  - The LA-off warning appeared and the ECG recovered.
  - 3 min stable; Disconnect showed "Disconnected.".

  Tester: the port was held 16:14:39–16:18:13, and the listen afterwards got 0 B with `min = 1; time = 0`.

  First the user hard-reloads with Ctrl+Shift+R. The user keeps RA, LA and RL on and sits still. Rules and "listen" are as in E4.
  1. **Connect:**
     - Within 3 s about 500 frames/s.
     - The slow swing of a fresh start shows briefly, then the ECG appears: one sharp QRS per heartbeat, about 30 counts tall, matching the pulse at the wrist.
     - **Report how many seconds after Connect the baseline is flat.** The planner's model gives about 2 s. If it is more than 5 s, the planner adds a start-up skip.
     - The baseline is flat, the scale is ±50 or ±100 counts, and there is no fine 50 Hz fuzz.
     - Lower T waves and a shifted ST segment are the expected cost of no delay (Decisions). They are not a failure.
  2. **The high-frequency noise you reported (ask the user explicitly):** "With the old page you saw too much high-frequency noise. Look at the trace between beats now: is that noise gone, reduced, or the same?"
     - The user answers "gone", "reduced" or "the same".
     - For "reduced" or "the same", the user also reads the thickness of the trace between beats off the grid, in counts, and says whether it looks like fine fuzz or like slower wiggles.
  3. **No delay:** the user taps the LA electrode's clip once. The blip appears at the right edge at once, with no half-second wait.
  4. **Unclip LA:**
     - Within about 2 s the line says "Lead I not valid: LA electrode off", and the trace jumps. Because the filters run forward only, the ringing shows only after the jump, never before it.
     - Clip it back: the line returns to "on", and the ECG returns within about 5 s. The planner's prototype settles a 30 000-count step to ±60 counts in 3.6 s.
  5. **Leave it running for 3 minutes,** past the 60 s, 120 s and 180 s keep-alives. The trace keeps moving at about 500 frames/s, and the page stays responsive. Report it if the page lags or Chrome's task manager shows the tab above about 20 % CPU.
  6. **Disconnect. Tester:** listen: under 1000 bytes.

  **E6 passes when:**
  - The user reports 1, 3, 4 and 5 as described.
  - The answer to 2 is "gone" or "reduced", and the user accepts the trace. "The same", or "reduced" with the user not satisfied, fails E6. The planner then revises with the user's numbers from 2.
  - The listen in 6 prints under 1000 bytes, with `stty` at `min = 1; time = 0`. A listen of about 40 000 means the user replugs and the tester reports it.

- [x] E7. **Leads I and II, two traces (code: no device; then the user checks on the module with the LL electrode on).**
  **Result (2026-11-03), user-confirmed:** all user items passed and the user is satisfied: both traces show the ECG; LL/LA/RA unclip messages and recovery; 1 minute stable; separate per-lead scales accepted. Tester: tests 9/9 (PCG 10/10, 11/11), static block all ten lines; port held 16:37:50–16:40:40, listen afterwards 0 B, `min = 1; time = 0`.
  The user asked on 2026-11-03: "I want you to show me both leads I and II." E7 does not wait for E6 to be ticked. It reuses `createEcgFilter()` unchanged, so if E6 leads to a filter revision, that revision applies to both leads.

  **Tester, before the executioner starts.** The E4 and E5 changes are not committed, so `HEAD` cannot be the reference. Save the pre-E7 files:
    ```
    cp Web/ecg.html /tmp/ecg_pre_e7.html && cp Web/ecg_dsp.js /tmp/ecg_dsp_pre_e7.js && echo pre-E7 saved
    ```

  Files:
  - **`Web/ecg_dsp.js`:**
    - `createParser().push(chunk)` returns one `[I, II]` pair per frame: `out.push([dv.getInt16(i + 6), dv.getInt16(i + 8)]); // I = LA − RA, II = LL − RA`.
    - `stats` gets `llOff: false`, set per frame next to the other two flags: `stats.llOff = (b[i + 2] & 0xc0) !== 0;` (§8.3).
    - The comment above `createParser` says "returns the [I, II] counts" and "the RA/LA/LL electrode-off flags".
    - Add `export function electrodeLine({ raOff, laOff, llOff })` directly after `createParser`. It returns exactly the texts in the table below. Lead I needs RA and LA, and lead II needs RA and LL (§8.3). A one-line comment says so.

      | RA off | LA off | LL off | Text |
      |---|---|---|---|
      | no | no | no | `RA, LA and LL electrodes on.` |
      | no | yes | no | `Lead I not valid: LA electrode off.` |
      | no | no | yes | `Lead II not valid: LL electrode off.` |
      | yes | no | no | `Leads I and II not valid: RA electrode off.` |
      | no | yes | yes | `Leads I and II not valid: LA and LL electrodes off.` |
      | yes | yes | no | `Leads I and II not valid: RA and LA electrodes off.` |
      | yes | no | yes | `Leads I and II not valid: RA and LL electrodes off.` |
      | yes | yes | yes | `Leads I and II not valid: RA, LA and LL electrodes off.` |

    - `FRAME_BYTES`, `RATE` and `isFrame` stay byte-identical. So does everything from the comment `// The vendor's resting-ECG filters at 500 Hz` to the end of the file.
  - **`Web/ecg.html`:**
    1. `<h1>ECG viewer (lead I)</h1>` becomes `<h1>ECG viewer (leads I and II)</h1>`. `<title>ECG viewer</title>` stays.
    2. The one `<canvas id="trace" …>` becomes these four lines, inside the existing `<figure>` and before its `<figcaption>`:
       ```
       <h2>Lead I (LA − RA)</h2>
       <canvas id="traceI" role="img" aria-label="Live ECG, lead I, last 5 seconds, newest on the right"></canvas>
       <h2>Lead II (LL − RA)</h2>
       <canvas id="traceII" role="img" aria-label="Live ECG, lead II, last 5 seconds, newest on the right"></canvas>
       ```
       CSS: the canvas `height: 60vh` becomes `34vh`, so both traces and the controls fit in one window. Add `h2 { font-size: 1.1rem; margin: 0.5rem 0 0.25rem; }`.
    3. The import becomes `import { createParser, createEcgFilter, electrodeLine, RATE } from './ecg_dsp.js';`.
    4. **State:** `ring`, `full`, `filter`, `canvas` and `ctx` are replaced by one array. The existing comment on the ring stays on its line.
       ```
       const traces = ['traceI', 'traceII'].map((id) => {
         const canvas = document.getElementById(id);
         return { canvas, ctx: canvas.getContext('2d'), ring: new Float32Array(RING), full: MIN_FULL, filter: null };
       });
       ```
    5. **Connect:** `filter = createEcgFilter();` and `ring.fill(0);` become `for (const t of traces) { t.filter = createEcgFilter(); t.ring.fill(0); } // one chain per lead: each stage holds its lead's past samples`.
    6. **Read loop:** `for (const v of parser.push(value)) ring[written++ % RING] = filter(v);` becomes:
       ```
       for (const pair of parser.push(value)) {
         traces.forEach((t, k) => (t.ring[written % RING] = t.filter(pair[k])));
         written++;
       }
       ```
    7. **Teardown:** `port = reader = parser = filter = null;` becomes `port = reader = parser = null;`, because the next Connect replaces each trace's filter.
    8. **`draw()` becomes `draw(t)`.** It uses `t.canvas`, `t.ctx` and `t.ring`, and stores the scale in `t.full`. Nothing else in its body changes: the min/max columns, `niceCeil` with the `MIN_FULL` floor, the grid and the labels stay. `tick()` calls `for (const t of traces) draw(t);` under the one `dirty` flag.
    9. **Electrode line:** the two lines that build `off` and `t` become `const t = electrodeLine(parser.stats);`. The "only when its text changes" guard stays.
    10. **Stats line:** `scale ±${full} counts.` becomes `scale I ±${traces[0].full}, II ±${traces[1].full} counts.`.
    11. **The `<figcaption>`** becomes exactly:
        "Leads I (LA − RA) and II (LL − RA), 500 samples/s, each filtered on the PC with its own copy of the vendor's resting-ECG filters, always on: 0.25 Hz high-pass, 50 and 100 Hz notch, 40 Hz low-pass and 0.75 Hz baseline filter. They run forward only, one sample at a time, so the traces have no delay, but T waves and ST segments look different from the vendor's program. Last 5 s, newest on the right. Each trace has its own scale, in ADC counts, because the module's µV per count is not known: compare amplitudes by the scale labels. Lead II needs the LL electrode on the left leg. For about 2 s after Connect the traces show the module's input settling."

    **Unchanged (the E4 communication code):** `send()`, the Connect `send(...)` line, the keep-alive, `disconnect()`, `requestPort`/`open`/`setSignals` and the read-error handling.
  - **`Tests/ecg_dsp_test.mjs`:**
    - `frame(leadI, { leadII = ~leadI, a1 = 0xc0, b1 = 0x00, m = … } = {})` writes `[0x1234, leadI, leadII, 0x3456]`.
      - `~v` is never `v` and stays inside int16 for every int16 `v` (`~-32768 = 32767`). A swapped or wrong offset therefore shows.
      - Its comment says so, in place of "V5, II and III differ from every lead I value used here".
    - Add `const pairs = (vals) => vals.map((v) => [v, ~v]);`.
    - Test 1 becomes "leads I and II are the big-endian int16 at offsets 6 and 8", and asserts `deepEqual(values, pairs(LEAD_I))`.
    - Tests 3 and 4 assert `pairs(LEAD_I)`, and test 2 asserts `deepEqual(whole.values, pairs(vals))`. Their chunk comparisons stay as they are.
    - Test 5 becomes "electrode-off flags of the last frame: RA from B1 & 0x60, LA from A1 & 0x20, LL from A1 & 0xC0". `flags()` returns `{ raOff, laOff, llOff }`, with these cases in this order:

      | A1 | B1 | raOff | laOff | llOff | Case |
      |---|---|---|---|---|---|
      | `0xc0` | `0x00` | false | false | true | the real module without LL (E1) |
      | `0x40` | `0x00` | false | false | true | |
      | `0x80` | `0x00` | false | false | true | |
      | `0x20` | `0x00` | false | true | false | |
      | `0x10` | `0x00` | false | false | false | the V5 bit is not a lead I/II flag |
      | `0xe0` | `0x00` | false | true | true | |
      | `0xc0` | `0x20` | true | false | true | |
      | `0x00` | `0x40` | true | false | false | |
      | `0xe0` | `0x60` | true | true | true | |
      | `0x00` | `0x00` | false | false | false | all on |

    - Tests 6–8 (the filter) stay byte-identical.
    - Add test 9, "electrode line names the invalid leads":
      - It asserts the eight texts of the table above for every `raOff`/`laOff`/`llOff` combination.
      - It also asserts that `electrodeLine(p.stats)` after one default `frame(0)` gives `Lead II not valid: LL electrode off.`, which ties the parser's flags to the text.
  - **`README.md`, ECG section:**
    - Replace "draws lead I (LA − RA) for the last 5 s at 500 samples/s. It also shows the frame rate, the bytes skipped while syncing and whether the RA and LA electrodes are on." with exactly: "draws leads I (LA − RA) and II (LL − RA) for the last 5 s at 500 samples/s, one trace each with its own scale. It also shows the frame rate, the bytes skipped while syncing and whether the RA, LA and LL electrodes are on. Lead II needs the LL electrode (left leg): without it the module reports LL off, the page says "Lead II not valid: LL electrode off." and the lead II trace shows no heartbeat."
    - Rewrap the lines as the section does, but keep "II (LL − RA)" and "needs the LL electrode" each on one line, because the static check greps them.

  **Acceptance, static (tester):**
  - `node Tests/ecg_dsp_test.mjs` ends with `pass 9` and `fail 0`. `node Tests/pcg_parser_test.mjs` and `node Tests/pcg_audio_test.mjs` end with `fail 0`.
  - E5's static checks "page wiring unchanged" and "parser unchanged" now fail by design (E7 changes both). Do not rerun them: these checks replace them.
    ```
    python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/ecg.html').read(),re.S).group(1))" > /tmp/ecg_page.mjs && node --check /tmp/ecg_page.mjs && echo page syntax OK
    grep -qF "import { createParser, createEcgFilter, electrodeLine, RATE } from './ecg_dsp.js';" Web/ecg.html && grep -qF "t.filter = createEcgFilter();" Web/ecg.html && grep -qF "t.ring[written % RING] = t.filter(pair[k])" Web/ecg.html && grep -qF "electrodeLine(parser.stats)" Web/ecg.html && grep -qF 'id="traceI"' Web/ecg.html && grep -qF 'id="traceII"' Web/ecg.html && ! grep -qF "filter(v)" Web/ecg.html && echo two leads wired
    grep -qF "<h1>ECG viewer (leads I and II)</h1>" Web/ecg.html && grep -qF "<h2>Lead II (LL − RA)</h2>" Web/ecg.html && grep -qF "own scale" Web/ecg.html && grep -qF "II (LL − RA)" README.md && grep -qF "needs the LL electrode" README.md && ! grep -qF "(lead I)" Web/ecg.html && echo leads I and II documented
    bash -c 'for f in "function send" "async function disconnect"; do cmp -s <(sed -n "/^$f/,/^}/p" /tmp/ecg_pre_e7.html) <(sed -n "/^$f/,/^}/p" Web/ecg.html) || exit 1; done' && python3 -c "s=open('Web/ecg.html').read(); c=s[s.index('async function connect'):s.index('async function disconnect')]; assert 'send([0x02], 100, [0x02], 100, [0x01], 100, [0x01], 5, [0x09]);' in c; assert 'send([0x09], 5, [0x09])' in c; assert 'await p.open({ baudRate: 230400, bufferSize: 65536 });' in c; print('communication unchanged')"
    bash -c "cmp -s <(sed -n '/resting-ECG filters at 500 Hz/,\$p' /tmp/ecg_dsp_pre_e7.js) <(sed -n '/resting-ECG filters at 500 Hz/,\$p' Web/ecg_dsp.js) && cmp -s <(sed -n '/^const isFrame/,/;\$/p' /tmp/ecg_dsp_pre_e7.js) <(sed -n '/^const isFrame/,/;\$/p' Web/ecg_dsp.js)" && echo filters and marker check unchanged
    python3 -m http.server -b 127.0.0.1 -d Web 8001 >/dev/null 2>&1 & S=$!; sleep 1; for f in ecg.html ecg_dsp.js "" pcg_parser.js; do curl -s -o /dev/null -w "%{http_code} %{content_type} /$f\n" "http://localhost:8001/$f"; done; kill $S
    git diff --quiet HEAD -- Web/index.html Web/pcg_parser.js Web/pcg_audio.js Tests/pcg_parser_test.mjs Tests/pcg_audio_test.mjs Tests/pcg_filter_test.c && echo PCG files unchanged
    ```
    It must print:
    - `page syntax OK`, `two leads wired`, `leads I and II documented`, `communication unchanged` and `filters and marker check unchanged`.
    - The four `200` lines, as in E5.
    - `PCG files unchanged`.

  **Acceptance, on the module (the user and the tester; the agents cannot see the screen).**
  - Rules and "listen" are as in E4, and the page is served as in E4. First the user hard-reloads with Ctrl+Shift+R.
  - **The user attaches the LL electrode:** a fresh gel electrode on the left leg (left ankle, or the lower left abdomen), with the clip labelled LL. RA, LA and RL stay on. The user sits still.
  1. **Connect:**
     - Within 3 s about 500 frames/s.
     - The line reads "RA, LA and LL electrodes on.".
     - Within about 2 s **both** traces show the ECG, one QRS per heartbeat, at the same moments in both traces.
     - Report both scales from the stats line ("scale I ±…, II ±… counts") and the R-peak height in each trace, read off the grid.
     - Lead II's QRS usually points up and is often taller than lead I's. A different size is not a failure.
  2. **Unclip LL:**
     - Within about 2 s the line reads "Lead II not valid: LL electrode off.", and lead II looks like the "LL missing" picture below.
     - **Lead I does not change:** same ECG, same scale. This proves the separate filters and scales.
     - Clip LL back on: the line returns to "RA, LA and LL electrodes on." and lead II's ECG returns within about 5 s.
  3. **Unclip LA:**
     - The line reads "Lead I not valid: LA electrode off.", lead I jumps, and **lead II does not change** (LA is not part of lead II).
     - Clip LA back on.
  4. **Unclip RA:**
     - The line reads "Leads I and II not valid: RA electrode off.", and both traces jump.
     - Clip RA back on. Both ECGs return within about 5 s.
  5. **Leave it running for 1 minute,** past the 60 s keep-alive. The page stays responsive. Report it if Chrome's task manager shows the tab above about 20 % CPU, now that the page draws two canvases.
  6. **Disconnect. Tester:** listen: under 1000 bytes, with `stty` at `min = 1; time = 0`.

  **What lead II looks like when LL is missing.** The user should know this picture before starting.
  - In E1, without LL, the module reported LL off in every frame after the first 0.83 s, and lead II sat at the rail: mean about 29 000 counts, with values reaching ±32768.
  - On the page:
    - The line reads "Lead II not valid: LL electrode off." within about 1 s of Connect.
    - The lead II trace shows **no heartbeat**. It shows a jump of thousands to tens of thousands of counts that rings for a few seconds, then either a flat line at 0 (the rail held steady) or repeated large jumps (the rail flickering). The "II ±…" scale is ±1000 counts or more while the jump is on screen.
    - Lead I keeps its own scale and its ECG.
  - The page does not zero lead II like the vendor does, so contact problems stay visible (Not doing).

  | What you see | What it means | What to do |
  |---|---|---|
  | "Lead II not valid: LL electrode off." with LL attached | The module itself reports LL off. This is wiring or skin contact, not the page. | Check that the clip sits on the electrode snap and that the cable's LL lead is plugged in. Use a fresh electrode and wait 5 s. If it stays off, report it. |
  | "RA, LA and LL electrodes on." but lead II shows no heartbeat for more than 5 s while lead I has one | Not explained by the flags | Report it with the stats line. The planner decides, with no new device command. |
  | Lead II is a copy of lead I (same shape, same scale) | Page bug: lead II is read from lead I's offset | Report it to the executioner. Test 1 should have caught it. |
  | Unclipping LL changes lead I, or unclipping LA changes lead II | Page bug: the leads share state | Report it to the executioner. |
  | Lead II's QRS points down while lead I's points up | Usually swapped RA and LL clips, sometimes the person's heart axis. The page draws the module's counts as sent. | Check the clip labels. If they are right, this is not a fault. |

  **E7 passes when:**
  - The static checks print every line above, and the three node test files end with `fail 0` (`pass 9` for the ECG tests).
  - With LL attached, the user reports 1–5 as described.
  - The listen in 6 prints under 1000 bytes, with `stty` at `min = 1; time = 0`.
  - The user accepts both traces.
  - If the user cannot attach LL, items 1–4 cannot pass. The user then confirms only the "LL missing" picture and that lead I is unchanged, and E7 stays open.

- [x] D1. **Correct `Biomedic_ECG_USB_protocol.md` and add the §11 line (document only, no device).**
  **Result (2026-11-03), executioner:** the five findings and the §11 line are in place in §5, §6, §7, §11, §12.1, §12.2 and Appendix A; check 2 printed all four lines. Tester (2026-11-03): checks 1–3 pass; only the two files modified, the script printed all four lines, the word diff shows changes only in the D1 sections. Then the 16-bit bullet was narrowed to the IIR and FIR stages, as stage 0 was not checked.
  The user asked on 2026-11-03: "yes, correct the document and add the §11 line." This lifts "the plan does not edit the document" for D1 only.

  **Executioner.** Edit only `Biomedic_ECG_USB_protocol.md` (repo root), plus D1's tick and result line here. The facts are in Findings, "Where the user's document is contradicted or incomplete", and are already verified: do not re-check them, and never run the installer or anything from it.
  - **Style:** correct the wrong sentence where it stands. No errata section, no new headings, no reflowed paragraphs. Keep the document's ✅/🔶 markers, its thousands commas (`570,000`), its contractions and its backticked addresses.
  - **§5:** the "Flow control" row says CTS and DSR handshaking are off, and that XON/XOFF and abort-on-error are not set by the program and stay as the driver had them (`0x496F78`).
  - **§6 and §7:** the Stop row says the stop is sent only when the user stops. Below the §7 diagram, one ✅ line: after a read error or the 10 s timeout, the program closes the port without the stop (`0x495227`), so the module can keep streaming until the next start.
  - **§12.1:**
    - In the "Used by the live monitor" sentence, say that the chain is built over a record of known length (the trend's first and last 3 s are set at build time, `0x466C43`, `0x46FE70`), processed in 4096-sample blocks (`0x447034`, `0x461C46`), and rebuilt by the monitor's filter buttons (`0x43CE90`–`0x43CEC1`). Add a 🔶: how the monitor filters while it is still acquiring wasn't traced.
    - The "truncated and clamped to 16 bits" fact moves from the FIR bullet so that it covers the IIR stages too (`0x472C7F`–`0x472CB7`).
  - **§12.2:** extend the sentence before the SciPy sketch. The sketch pads with `filtfilt`'s odd extension and uses `mode="nearest"`, while the program starts each pass from zero state, reads zeros beyond the data, and starts the backward pass `margin` samples after the end (`0x472838`, `0x472E5D`). Neither code block changes.
  - **§11:** one line in `acquire()`, after the `port.port, … = …` line and before `port.open()`: `port.inter_byte_timeout = 0.05`, with a one-line comment (on the same line, or one `#` line directly above). The comment says that without it pyserial leaves the tty at VMIN 0 and Chrome Web Serial then fails with "The device has been lost", and that the other fix is `stty -F /dev/ttyACM0 min 1 time 0`. Use these exact strings: `VMIN 0`, `The device has been lost`, `stty -F /dev/ttyACM0 min 1 time 0`. Nothing else in the block changes.
  - **Appendix A, the "second, nearly identical acquisition thread class" sentence:** keep the vtable and run-loop addresses. Say that it is chosen only when the setting `Config/HRProtocol` is true (default false, `0x40701F`, `0x407123`, `0x407253`). Its commands and timings are the same, but it opens at 570,000 baud (`0x4958FA`, `0x407150`), sends the keep-alive every 60,000 frames (`0x495F08`, `0x496D94`), and its blocks start with `C0` only, with no `01`/`02`/`03` markers (`0x495F56`). The phrase "uses the same commands, frame layout" goes. The tables stay as they are.
  - Do not commit.

  **Tester (repo root, no device):**
  1. `git status --porcelain` prints exactly ` M Biomedic_ECG_USB_protocol.md` and ` M PLAN.md`, and `git diff --stat` lists only those two files.
  2. This check compares the document with `HEAD`. It must print its four lines.

```
python3 -I - <<'EOF'
import ast, re, subprocess
F = "Biomedic_ECG_USB_protocol.md"
old = subprocess.run(["git", "show", "HEAD:" + F], capture_output=True, text=True, check=True).stdout
new = open(F, encoding="utf-8").read()
def sections(t):
    order, out, head, fence = [], {}, "", False
    for line in t.splitlines():
        if line.startswith("```"): fence = not fence
        if not fence and re.match(r"#{1,3} ", line): head = line; order.append(line)
        out.setdefault(head, []).append(line)
    return order, {k: "\n".join(v) for k, v in out.items()}
oh, o = sections(old); nh, n = sections(new)
assert oh == nh, "headings changed"
H = {k: next(h for h in nh if h.startswith(k)) for k in ["## 5.", "## 6.", "## 7.", "## 11.", "### 12.1", "### 12.2", "## Appendix A"]}
for h in n:
    assert h in H.values() or o[h] == n[h], "changed outside D1: " + h
print("only D1 sections changed")
code = lambda t: re.findall(r"```.*?```", t, re.S)
assert code(o[H["### 12.2"]]) == code(n[H["### 12.2"]]), "12.2 code changed"
row = lambda t: [l for l in t.splitlines() if l.startswith("|")]
assert row(o[H["## Appendix A"]]) == row(n[H["## Appendix A"]]), "Appendix A tables changed"
print("12.2 code and Appendix A tables unchanged")
def has(k, *subs):
    for s in subs: assert s in n[H[k]], f"{k} lacks {s!r}"
has("## 5.", "XON/XOFF", "0x496F78")
assert "0x495227" in n[H["## 6."]] + n[H["## 7."]], "6/7: no stop after a read error missing"
has("### 12.1", "0x466C43", "0x46FE70", "4096", "0x447034", "0x461C46", "0x43CE90", "traced", "0x472C7F")
has("### 12.2", "zero state", "0x472838", "0x472E5D")
has("## Appendix A", "570,000", "60,000", "0x495F56", "HRProtocol")
assert "uses the same commands, frame layout" not in n[H["## Appendix A"]]
print("five findings present")
o11, n11 = (re.search(r"```python\n(.*?)```", t[H["## 11."]], re.S).group(1) for t in (o, n))
ast.parse(n11)
added = [l for l in n11.splitlines() if "inter_byte_timeout" in l or l.strip().startswith("#")]
assert [l for l in n11.splitlines() if l not in added] == o11.splitlines() and 1 <= len(added) <= 2, "11: other code changed"
assert "port.inter_byte_timeout = 0.05" in n11 and n11.index("inter_byte_timeout") < n11.index("port.open()")
assert "VMIN 0" in n11 and "The device has been lost" in n11 and "stty -F /dev/ttyACM0 min 1 time 0" in n11
print("11 parses, only the inter_byte_timeout line added")
EOF
```

  3. Read `git diff --word-diff -- Biomedic_ECG_USB_protocol.md`. Every change is one of the edits above, in its own section, and the rest of each sentence keeps the user's wording.

  **D1 passes when** 1 holds, 2 prints `only D1 sections changed`, `12.2 code and Appendix A tables unchanged`, `five findings present` and `11 parses, only the inter_byte_timeout line added`, and 3 finds no other change. The planner dry-ran 2: on the unedited document it stops at `## 5. lacks 'XON/XOFF'`, and on a simulated correct edit it prints all four lines.

## Next, in order

1. **Executioner:** D1's edits to `Biomedic_ECG_USB_protocol.md`, nothing else. Do not commit.
2. **Tester:** D1's checks 1–3. Report every printed line.
3. **Main session:** tick D1 with its result line, then ask the user whether to commit.

## Not doing

- **Other leads:** III and aVR/aVL/aVF (nobody asked for them; they also need LL), and V1–V6 (they need chest electrodes).
- **Scale and data:**
  - A µV or mV scale.
  - Recording or export, and a real-data replay test (`/tmp/ecg.bin` no longer exists, and E6 checks real data on screen).
  - Heart-rate or QRS detection.
- **Display:** an ECG paper grid or a sweep mode.
- **Filter options:**
  - Filter buttons or settings: NF, MF and HF are always on.
  - The 19-tap "25hz" FIR.
  - A 60 Hz notch (the vendor's chain has none).
  - The stress-test FIR chain (§12.4).
  - The 250/1000 Hz tables.
  - int16 truncation between stages.
  - The zero-phase view of the vendor's chain, with its 0.5 s lag and 7.5 s blank start (the user chose no delay, 2026-11-03).
  - A start-up skip: the swing settles in about 2 s (Decisions).
- **Other variants:** the "HRProtocol" variant (570 000 baud), and the Bluetooth model with its `0x0B` Identify command.
- **Diagnostics:**
  - Any MCP2200 HID access, unless the user approves the read-only query (Needs the user).
  - usbmon traces.
  - Finding which trigger makes the module deaf, beyond the H1/H3 coverage in E4.
- **Other features:**
  - Audio, battery voltage, and the vendor's saturation counters.
  - Zeroing lead I or II when an electrode is off.
  - A shared or switchable scale for the two traces (E7 decides per lead, see Decisions).
  - Auto-reconnect, and sending the stop when the tab closes (Chrome does not run a 100 ms timer in a closing tab).
- **Document (D1):** other stale notes in `Biomedic_ECG_USB_protocol.md`, such as "Not tested with real hardware" in §10 and "not against a real device" in §11, and §13's open questions, stay as written (not asked).
- **Out of scope:** any change to the PCG page, the firmware, CMake, `.vscode` or the guide.

## Needs the user

- **During any session with the module:**
  - Keep RA, LA, LL and RL on and sit still.
  - Click Disconnect before closing the tab.
  - Two programs reading one port each get only part of the bytes, so no page may be connected while someone listens.
- **Replugs:** E4.5 leaves the module streaming on purpose, and any failed check may need a replug (E4, "If a check fails"). After every plug-in, wait until `fuser /dev/ttyACM0` prints nothing, because ModemManager may probe.
  - The alternative needs sudo: a udev rule with `ENV{ID_MM_DEVICE_IGNORE}="1"` for `04d8:00df`.
  - If E4.1's journal shows ModemManager probing the module, the planner recommends that rule.
- **Answered 2026-11-03, filters:** all of the vendor's filters are always on, and they run forward only, with no delay (Decisions). You accepted that T waves and ST segments then differ from the vendor's program.
  - For your information: the 0.75 Hz baseline filter is above the 0.67 Hz limit often cited from the AHA 2007 recommendations, and that limit is meant for zero-phase filters. For forward-only filters the same recommendations are usually cited at 0.05 Hz.
  - So this trace is for watching rhythm and QRS live, not for judging ST segments.
- **Your document (`Biomedic_ECG_USB_protocol.md`), decided 2026-11-03:** you asked for the five points in Findings (Appendix A, §5, §6/§7, §12.1 and §12.2) to be corrected and for §11's `inter_byte_timeout` line. D1 does both. After D1, say whether to commit it.
- **Optional diagnostic, if the module goes deaf again (H4):**
  - A read-only query of the MCP2200's configuration through its HID interface (`/dev/hidraw*`) would show whether hardware flow control is set in its EEPROM.
  - It sends a "read all" HID report. It writes no settings, but it is still traffic to the bridge, it needs sudo or a udev rule for `hidraw`, and the report layout must first be checked against Microchip's MCP2200 datasheet.
  - Say if you approve it. Until then, no agent touches the HID interface.
- **For your information, no action needed:**
  - `Biomedic_ECG_USB_protocol.md`, with your §12 edit, is committed (`8c56a39`, `539c1e6`).
  - `BiomedicECG-Setup.exe` is already ignored by `.gitignore` (`*.exe`), so it cannot be committed by accident.
- **Your recordings:** `/tmp/ecg.bin` is gone. Earlier scratchpad captures from the 2026-10-30 session may still hold your ECG: delete them when you are done.
- **Open questions, kept:**
  - Does the module have an LED that shows streaming?
  - The µV per count (§13, question 1): the vendor's display code was not traced, so a known 1 mV signal remains the way to calibrate.

# PLAN: synchronized ECG + PCG recorder

**Goal:** one page, `Web/recorder.html`, where one Start button records ECG lead II and PCG to disk at a nominal 1000 Hz each, shows both live, and keeps everything the user needs to correct the drift offline.

**The user's requests (2026-11-04), verbatim:**

- "I want now an app browser that show me both signal ECG lead II and PCG, due to I need to recording simultaneously both signals I want you to create a start button which enable the measuring in both devices at the same time, so after having finished I will do the drift correction offline."
- "After the digital lowpass PCG signal, apply a downsampling until 1000 Hz to the PCG signal inside the stm32"
- "Also make upsampling to the ecg up to 1000 Hz after the lowpass filtering for having a paired signal with the same frequency sampling"
- "Ok, I agree with that saving the unfiltered ECG"

**This section changes the PCG wire format and the firmware.** The two sections above stay as history. Where they disagree with this one (48 kHz on the wire, 964-byte frames, "no firmware change", "no recording"), this section wins. Step 6c of the PCG plan, the headphone check, stays open.

`P` = `Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC`. ✅ = read from the code or computed by the planner. 🔶 = estimated, not measured.

## Decisions

### What "start both at the same time" can mean

- **What the devices do:**
  - ✅ The STM32 streams from power-up with no start command. `main()` starts the ADC, TIM3 and DMA before its loop, and `CDC_Receive_FS` throws host bytes away. `seq` counts DMA halves since power-up, so it is already an exact sample clock.
  - ✅ The ECG module must be started: the stop-first sequence takes 305 ms, and the input settles for about 2 s after that. Nothing tells us how long the module takes from `01` to its first valid sample, and its frames carry no counter.
- **Design: one Start button, gating on the PC, no start command.** Start opens both ports, starts both read loops in the same tick and sends the ECG start sequence. From then on every received chunk goes to disk with a `performance.now()` stamp, one clock for both streams.
  - PCG chunks are being logged within about 20 ms of Start. ECG frames follow about 0.5 s later 🔶 and are settled about 2 s later.
  - "The same time" therefore means that both records cover the same interval and both map onto one host clock. It does not mean a shared first sample, which neither device can give. The user trims the start offline.
- **Firmware options for alignment, all rejected except A.** The flash for the decimation is paid anyway, so cost is not the reason. They buy nothing, because the weak link is the ECG path, which we cannot change.

  | Option | What it buys | Alignment after the offline fit |
  |---|---|---|
  | **A. Host timestamps on both streams (chosen)** | Works with what exists | Under 0.5 ms random, plus a constant unknown path difference of about ±3 ms 🔶 |
  | B. Start/stop command to the STM32 | The PCG file starts about 2 ms 🔶 after a command | Same as A: the ECG's first sample must still be placed by host timestamps, and `seq` is already exact |
  | C. Wider sample counter | Removes the 327.68 s `seq` wrap | Same as A: only an outage above 5.46 min could alias, and the host timestamps resolve that |
  | D. STM32 echoes host pings, NTP style | PCG to host offset down to about 0.5 ms 🔶 | Same as A: the ECG path is unchanged |
  | E. A hardware trigger seen by both | Under 1 ms | Rejected: it needs a wire into a device connected to the body |

- **Alignment budget for the chosen design.** All of these are per recording, with the fit from "Recording" below:

  | Term | Size | Note |
  |---|---|---|
  | Clock drift before correction | Measured in S10: 514 ppm, about 31 ms/min, ECG slow against PCG | Not constant: −503 to −524 ppm over four windows of that recording, on the ECG side, so one straight line may not be enough, and S12's `relative_ppm_halves` limit of under 5 ppm may fail (this recording: 16.7 ppm). E1's 10 s run gave a rough 240 ppm. A fit removes the drift, piecewise if needed |
  | Random error left after the fit | ✅ under 0.5 ms (spread under 0.2 ms) for 60 s or more | Planner's simulation: 2 ms exponential jitter plus 2 % outliers of 30 ms, 100 and 250 stamps/s, plain least squares. A model. Measured in S10: residual p50 0.30/0.33 ms, p99 7.20/6.87 ms, max 23.6/24.7 ms |
  | Timestamp resolution | 🔶 0.1 ms | Chrome without cross-origin isolation, from memory, not checked here |
  | Path difference, constant | 🔶 about ±3 ms, not measured and staying so (Not doing) | ECG: 1.7 ms UART plus MCP2200 plus USB. PCG: about 1 ms from the last kept sample to the end of the DMA half, plus filter time and USB. The mean jitter of each path lands in this term too. Constant within a session, so it moves every S1 by the same amount |
  | Board filter delay on PCG | ✅ 3.2 ms at 100–200 Hz, 5.7 ms at 50 Hz, 8.0 ms at 40 Hz, 14.1 ms at 30 Hz, 31.5 ms at 20 Hz | From `sos` in `pcg_filter.c`. It depends on frequency, so it is a phase correction offline, not one shift |
  | PC filter delay on stored lead II | ✅ QRS 10 ms, 12–17 ms over 10–40 Hz (ECG plan) | The raw counts have none. The module's own internal delay is unknown |

- **A cheap offline cross-check:** mains hum, if it shows in both raw records, is a common reference independent of the PC. The file already holds what that needs.

### PCG firmware: 48 kHz in, 1000 Hz out (one flash)

- **Order, as the user asked:** ADC at 48 kHz → the existing 20–200 Hz band-pass, run on every sample → keep one sample in 48 → USB. The filter still runs for every sample of every DMA half, sent or not, so its state stays continuous.
- **Is the 4th-order 200 Hz low-pass enough as anti-alias filter? For the 20–200 Hz band yes, as a brick wall at 500 Hz no.** Gain of the real coefficients, ✅ computed and ✅ confirmed by a dry-run of the decimating code at 600 and 800 Hz:

  | Input | 500 Hz | 600 Hz | 800 Hz | 950 Hz | 1000 Hz | 1200 Hz |
  |---|---|---|---|---|---|---|
  | Gain | −31.85 dB | −38.19 dB | −48.19 dB | −54.18 dB | −55.97 dB | −62.32 dB |
  | Folds to | 500 Hz | 400 Hz | 200 Hz | 50 Hz | 0 Hz | 200 Hz |

  - Only input at 800–1200 Hz (and 1800–2200 Hz, and so on) can fold into 20–200 Hz, and it is at least 48 dB down. A full-scale 800 Hz tone would alias to about ±127 counts. White ADC noise folded into the band is −50.3 dB against the noise already there.
  - Between 200 and 500 Hz the output holds the filter's skirt plus alias from 500–800 Hz at −32 to −48 dB. Do not analyse above 200 Hz.
- **Plain keep-every-48th is enough.** Averaging 48 samples would add −12.6 dB at 800 Hz, but it costs −0.58 dB at 200 Hz and 0.5 ms more delay, for no gain the band needs.
- **Which samples:** 0, 48, 96, … 432 of each 480-sample DMA half, so 1 kHz sample `j` is ADC sample `48·j`.
- **In `pcg_filter()`, not a new function:** two changed lines, and the host test exercises the real path. No start command and no wider counter go in the same flash (table above).
- **No change** to clocks, GPIO, ADC, DMA, TIM3, USB glue, the linker script, CMake (`Src/*.c` is a glob) or `stm32h7xx_hal_conf.h`. PA13/PA14 and PA6 are not touched.

### Wire format

- **`[0x8000 sync][seq 0–32767, wrapping][10 int16 samples]`, little-endian, 24 bytes every 10 ms, 2400 B/s** (it was 964 bytes and 96 400 B/s). Only the sample count changes, which is the smallest change.
  - The DMA half stays at 480 samples, so the firmware loop and the meaning of `seq` stay the same, and a gap still means a frame dropped because the host was not reading.
  - **Every sample's index follows from `seq`:** `10·unwrapped_seq + k` at 1 kHz, exact across drops.
  - 100 frames/s keep 100 host timestamps/s for the fit, one short USB packet each. A 100 ms frame would save 4 bytes per 10 samples, but costs 90 % of the timestamps and 100 ms of display lag.
- **Sync rule unchanged:** two syncs one frame apart with different `seq`. The planner's dry-run of the test file below passes 10/10, and 600 000 hunts on quiet synthetic data gave 0 false locks. A false lock would cost one bad frame in the display, and the raw file is unaffected.

### Audio stays, at the cost of about 10 lines

`pcg_audio.js` assumes 48 kHz and 480-sample pushes. An `AudioContext` cannot run at 1 kHz (browsers support about 3 kHz and up), so the stream must be upsampled.

- **The page upsamples by 48 with the same linear interpolator as the ECG,** then posts 480 samples per frame as today. So `pcg_audio.js` and `pcg_audio_test.mjs` stay byte-identical.
- **One `BiquadFilterNode` low-pass at 300 Hz** before the destination, a platform feature, removes the interpolator's images. ✅ Linear alone leaves the image of 100 Hz at 900 Hz at −38 dB, where the ear is far more sensitive than at 100 Hz. With the biquad it is −57 dB. The image of 200 Hz goes from −24 to −40 dB. Droop at 100 Hz is −0.34 dB in all, and at 200 Hz −1.9 dB.
- **Not proven by any test:** the user has not done step 6c, and that check now runs on this upsampled audio. If the sound is worse, it goes back to the planner.

### ECG lead II at 1000 Hz

- **Where in the chain: after the whole §12 chain, after the 0.75 Hz stage.** That stage comes after the 40 Hz FIR and its coefficients are for 500 Hz. Interpolating between the FIR and it would need a new design at 1 kHz, and the protocol warns that the vendor's 1000 Hz baseline filter is numerically fragile (§12.3). It adds nothing above 40 Hz, so the signal is still "after the low-pass". `createEcgFilter()` stays byte-identical.
- **Method: linear, one midpoint between neighbours.** `y[2m] = x[m]`, `y[2m+1] = (x[m] + x[m+1]) / 2`.
  - **Fixed 2:1 map:** N frames give 2N − 1 samples, and `y[j]` is frame `j/2` (odd `j` is halfway between two frames).
  - **Error at 40 Hz:** ✅ original samples exact, midpoints low by 3.14 % of the amplitude, 1.57 % RMS over all output, 33 dB SNR. At 15 Hz, where the QRS lives, midpoints are 0.44 % low. Image at 460 Hz: −36 dB.
  - **Delay: none.** Frame `m+1` arrives, and both `y[2m+1]` and `y[2m+2]` come out at once. Nothing waits for a later frame.
  - **Rejected:** a 4-point midpoint gives 0.15 % at 40 Hz but needs the next frame, so 2 ms of delay. The user chose no delay, and the raw counts are in the file anyway.
- **One function for both uses:** `createUpsampler(L)` in `Web/upsample.js`, L = 2 for ECG and L = 48 for audio.

### What "the same rate" does and does not give

The 1000 Hz ECG stays on the module's clock and the 1000 Hz PCG on the STM32's clock. **The rates match only nominally: sample `j` of one is not simultaneous with sample `j` of the other, and at the 514 ppm measured in S10 the two slide apart by about 1 ms every 2 s.** The page does not correct this, and the user does the correction offline from each stream's sample indices plus the host timestamps. The page caption, the first record of every file, the README and the loader's output all carry this exact text, `ALIGN_NOTE` in `recorder.js`:

"ECG and PCG are both nominally 1000 Hz, but each runs on its own clock (ECG: the module, PCG: the STM32). Sample j of one is not simultaneous with sample j of the other. Align them offline with each stream's sample index and the host timestamps. The fixed offset between the two paths is not measured: about ±3 ms, an estimate."

### Recording

- **Bytes as received, not decoded values.** Each chunk from each port is logged whole, before any parsing, so a parser bug cannot damage a recording. Keeping values in the form the platform gives them also needs the least code.
- **User decision, 2026-11-04:** the unfiltered module counts stay in the file, next to the filtered, upsampled lead II. The 40-byte frames also carry lead I, the electrode-off flags and the battery byte, at no extra cost, and they are the frame numbering that `y[j]` maps onto.
- **Layout:** one folder per recording, `ecgpcg-YYYYMMDD-HHMMSS/`, holding `00001.ecgpcg`, `00002.ecgpcg`, … Concatenated in name order, they form one log of records, little-endian. A file only ever ends on a record boundary.

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
  | 4 | Filtered, upsampled lead II as f32, continuing the previous kind 4 record. Same `t` as the kind 2 record it came from. Written only when that chunk gave samples (S14). Recordings made before S14 hold an empty one for every other chunk, which adds nothing |

  | Event `e` | When | Other fields |
  |---|---|---|
  | `start` | First record | `format: 1`, `wall` (`Date.now()`), `note` (`ALIGN_NOTE`), `pcg_hz: 1000`, `ecg_frame_hz: 500`, `ecg_1k_hz: 1000` |
  | `ecg-start-sent` | After the last start byte is written | |
  | `keep-alive` | When queued | `frames` |
  | `read-error` | A read failed but the port lives: bytes may be missing here | `stream`, `message` |
  | `lost` | A stream ended without Stop | `stream`, `message` |
  | `stop` | Last record of a clean end | |

- **Gaps stay visible in the file, never silent:**
  - **PCG:** a `seq` gap gives the exact number of missing frames.
  - **ECG:** there is no counter. Lost bytes show as a marker hunt, whose byte position the loader reports, and the size of the loss follows from the host timestamps (a frame is 2 ms, under the rolling residual).
  - **Between recordings:** a missing segment file shows as a gap in the numbering, which the loader reports.
  - **Stale first PCG frame:** always present, queued while the port was closed. Its timestamp means nothing, so the loader drops it, as `index.html` does.
- **Data rate, measured in S10:** about 290 KB/s, about 1 GB/hour. The payload is only 2400 + 20 000 + 4000 = 26 400 B/s. The rest was headers: ECG arrives in about 10 200 chunks/s, each chunk cost two 13-byte headers, and only about 500 chunks/s complete a frame. The estimate was 28–54 KB/s.
- **Data rate after S14, estimated 🔶, not measured:** about 165 KB/s, about 600 MB/hour, because the 9700 or so empty kind 4 records per second cost about 126 KB/s. S11 and S12 measure it.
- **Loader: `P/Tools/load_recording.py`, about 100 lines, numpy only.** Justified, because it is the format's real documentation, it is what the self-check reads back with, and it gives the tester a summary of counts on real recordings with no samples printed. It does not correct drift. Its summary fits `t = a + b·n` with plain least squares only to report rates, in ppm against the host clock. In the simulation, least squares did better than a lower envelope below about 5 min and worse at 30 min, so the choice stays with the user.

### Data safety

- **Disk, not memory.** Memory would lose everything in a tab crash. A single file from `showSaveFilePicker` plus `createWritable()` would not help either: the data sits in a swap file and reaches the named file only on `close()`.
- **So: one small file per segment.** `showDirectoryPicker()`, and every 256 KiB (about every 1.6 s 🔶 at the estimated rate after S14, was 0.9 s) the current records go through `createWritable()`, `write()` and `close()` as one new file. Each file is committed whole. The roll is counted in bytes in the read loop, because Chrome throttles timers in hidden tabs.

  | Event | What happens |
  |---|---|
  | **Stop** | ECG stop, drain, cancel both readers, `stop` event, final segment written, status names the folder |
  | **Tab crash or killed tab** | Everything but about the last 1.6 s 🔶 is on disk. The module keeps streaming, and the next Start's stop-first recovers it (tested in E4) |
  | **Unplug of one device** | `lost` event and a warning that stays. The other stream keeps recording. No auto-reconnect: the board reboots, and `seq` restarts |
  | **Unplug of both** | The session ends itself and writes the last segment |
  | **Dropped PCG frame** | Counter on the page, `seq` gap in the file, recording continues |
  | **Lost ECG sync** | Counter on the page, marker hunt in the file, recording continues |
  | **Disk write fails** | The segment stays in memory and is retried at the next roll and at Stop. A warning stays up, and the button offers Retry save after Stop |
  | **Closing or reloading the tab while recording or unsaved** | `beforeunload` asks first |

- **Recordings are health data and never land in the repo.** `startIn: 'documents'` opens outside the repo, a page cannot learn a folder's full path to check it, and Chrome may refuse `~/Documents` itself, so the user makes a subfolder.
- **`.gitignore` needs one line, `ecgpcg-*/`,** which also covers any `.crswap` left by a crash. It is defence in depth against a folder picked by mistake inside the repo.

### Page

- **`Web/recorder.html` + `Web/recorder.js`**, next to the others, with the logic in the module so node can test it, as with `pcg_parser.js` and `ecg_dsp.js`. No backend, no npm. Chrome or Edge on `http://localhost:8001/recorder.html`. Port 8000 is left alone.
- **What the user clicks:** `requestPort()` needs a gesture per port, so **Allow device** (filter on both VID:PIDs, one device per click) is needed once per device. Chrome should remember the grant where the device has a serial number 🔶 (the board has one, the module is unknown), and after that `getPorts()` finds both by `getInfo()` with no click. If a grant is not remembered, the page says so and Allow device is one more click. **Start** is enabled when both are found. The first Start of a session also asks for the folder, using that click's gesture. Later Starts use the same folder, so a normal session is one click.
- **Connect guard, as `ecg.html`:** the button is disabled for the whole attempt, an `opened` list closes only ports this attempt opened, and focus is restored. `index.html` got the same guard in S3 (user decision, 2026-11-04).
- **Traces on one time base:** both draw the 1000 Hz signals in 5000-sample rings, so 5 s has the same width in both traces. ✅ One `draw(t)` costs 0.06–0.09 ms at this ring size, against 1.6 ms for the 48 kHz ring (node v23, 1900–3800 columns). The two-trace page spends under 0.2 ms per animation frame, so drawing cannot disturb the read loops. The right edges are each stream's newest sample, so this is not a sample-level alignment.
- **`draw(t)` is copied from `ecg.html`, with a unit and a scale factor.** Not shared: `index.html` keeps its own, and sharing would change a verified page for no user benefit.
- **ECG start, keep-alive and stop are shared, not copied:** the sequences and `send()` move from `ecg.html` into `ecg_dsp.js`, which the page already imports. Those bytes made the module go deaf once, so one copy is worth a small change to a verified page. S9 re-proves it on the module.
- **Display:** ECG lead II with the forward-only chain, PCG in mV, Start/Stop as one toggling button like Connect/Disconnect (disabled while starting, so a double click cannot stop), electrode-off warning for RA and LL, PCG dropped frames, ECG frames/s, bytes lost after lock, recording length, files saved, status text. Accessibility as in `ecg.html`: `role="status"` for state text only, numbers in a plain span, labelled canvases, visible focus, a caption.

### PCG front end (user, 2026-11-04)

- PA6 is connected only to the PCG PCB's filter output. That PCB runs from a 9 V battery.
- The user reports that the output does not go above 3 V. Earlier measurements (step 4c) read 0–1.598 V, mean 0.951 V.
- **Nothing in the software can show a short excursion.** The board's filter hides it in the stream, and step 4c's reads were spot checks about 25 ms apart.
- **The 3 V limit is by design (user, 2026-11-04):** a voltage divider on the PCB limits the output to 3 V.
- **The PCB stays live when the board has no power,** so its output still drives PA6 then. What that does to an unpowered chip was not checked against DS12556, so S11 item 1 takes the signal wire off PA6 first.
- No hardware change is planned.

### Everything this reaches

| Place | Change |
|---|---|
| `Inc/pcg_filter.h`, `Src/pcg_filter.c`, `Src/main.c` | Decimation, 10 samples per frame |
| `Tests/pcg_filter_test.c` | 1 kHz output, two alias cases, `-INFINITY` |
| `Web/pcg_parser.js`, `Tests/pcg_parser_test.mjs` | Frame size, `RATE`, test sizes |
| `Web/index.html` | Ring, column guard, caption, audio upsampling, biquad, and the Connect fix, which went in with S3 (user decision, 2026-11-04) |
| `Web/pcg_audio.js`, `Tests/pcg_audio_test.mjs` | **Byte-identical** |
| `Web/upsample.js`, `Tests/upsample_test.mjs` | New |
| `Web/ecg_dsp.js`, `Web/ecg.html`, `Tests/ecg_dsp_test.mjs` | `send()` and the sequences move, no behaviour change, one new test |
| `Web/recorder.js`, `Web/recorder.html`, `Tests/recorder_test.mjs`, `Tools/load_recording.py` | New |
| `.gitignore` | `ecgpcg-*/` |
| `P/README.md`, `Acquisition_systems_summary.md` | Rates, frame, recorder section |
| `ECG_viewer_status.md` | Only the double-Connect reminder goes, fixed in S3 |
| `.vscode/`, `STM32 LED Blink Quick Guide.md`, root `README.md`, CMake, linker script, HAL config | **No change:** a grep finds no rate or frame size stated there |

## Steps

Commands run from `P` unless they say "repo root". `$S` is a scratch folder outside the repo.

| Step | Who | Device? |
|---|---|---|
| S1 | Tester | Read-only look, no port opened |
| S2–S7 | Executioner, then tester | None |
| S8 | Tester, with a stop-and-ask | Flash |
| S9–S12 | User and tester | Both devices, sensors connected |
| S13 | Executioner, then tester | None. Reads one kept recording and writes beside it |
| S14 | Executioner | None |
| S15 | Executioner, then the user in Chrome | Both devices, one short recording |
| S16 | Executioner, then the user with headphones | Both devices, one short recording |

S2–S7 all come before the flash so that the viewers work the moment the board changes, and the user disconnects once.

**If time is short.** Every step stays in the plan. This is the order of need for a first usable recording:

| Step | For a first usable recording | If it comes later, the risk left |
|---|---|---|
| S5, S6 | **Essential** | A format or loader fault is found only after a real recording |
| S7: page and `.gitignore` | **Essential** | |
| S7: `P/README.md`, `Acquisition_systems_summary.md`, `ECG_viewer_status.md` | Later | None to the data: each recording carries `ALIGN_NOTE` |
| S8, all checks | **Essential** | |
| S9 items 1 and 2, with the listen | **Essential** | |
| S9 items 3 and 4 | Later | An audio or double-click fault stays unseen. Neither touches the recorder |
| S10 | **Essential.** It can be the first real recording: record longer if you want, and keep it | |
| S11 | Later, after the first real recording | Unplug, killed tab and busy port are proven only in the node tests, not on the real devices. Files already written are separate and closed, so they should survive, but a real crash is unproven |
| S12 | Later, or met by a first real recording of 10 minutes or more | Runs over 3 minutes are unproven with the recorder. The loader's summary after that recording shows any fault, and the files up to it stay |
| Step 6c | Later | None to the recorder |

**Rules for anything that touches a device:**

- Only the tester runs device commands, and only the user clicks in pages.
- **Ports are found by VID:PID, never by `/dev/ttyACM0`.** With two devices the numbers are not fixed:
  ```
  tty_of() { python3 -c "import sys;from serial.tools import list_ports;print([q.device for q in list_ports.comports() if (q.vid,q.pid)==(int(sys.argv[1],16),int(sys.argv[2],16))][0])" "$1" "$2"; }
  ```
  `tty_of 04d8 00df` is the ECG module and `tty_of 0483 5740` the board. This opens nothing.
- **"Listen"** is E1's listen command, which already finds the port by VID:PID and sets `inter_byte_timeout = 0.05`. Never drop that line: without it, Chrome reports "The device has been lost". Follow it with `stty -F "$(tty_of 04d8 00df)" -a | grep -o 'min = [0-9]*; time = [0-9]*'`, which must print `min = 1; time = 0`. No page may hold the port during a listen.
- **After any plug-in,** wait 10 s, then until `fuser` on that port prints nothing, because ModemManager may probe it.
- **Serving, from the repo root:** `python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8001`. Never touch port 8000. Always `localhost`, not `127.0.0.1`, because port grants belong to the origin. Hard-reload with Ctrl+Shift+R after any code change.
- **Anything recorded from a person is health data:** never in the repo, never a fixture, and deleted after use. The tester reports only the loader's summary.
- **The sensors stay on the body.** The piezo is fitted under a bandage and refitting it is difficult, so no step removes or moves it, and the electrodes stay stuck on. Steps disconnect a connector or a USB cable instead.
- Physical checks pass only when the user confirms them. Do not commit.

- [x] S1. **Tester first: what is attached (no port opened, no code).** From the repo root:
  ```
  lsusb | grep -E '0483:5740|04d8:00df'
  for d in /sys/class/tty/ttyACM*; do t=${d##*/}; u=$(readlink -f "$d/device/.."); echo "$t $(cat "$u/idVendor"):$(cat "$u/idProduct") holders: [$(fuser "/dev/$t" 2>/dev/null)]"; done
  ss -ltn | grep -E ':800[01] '
  ls -l ../stm32h7_blinkled_vscode/GPIO_IOToggle_Led/backup/weact_factory_internal_flash.bin
  openocd -f openocd.cfg -c "init" -c "exit"
  ```
  **Acceptance:** both devices are listed, each on its own `ttyACM`, with empty holders. Report which is which, and anything on 8001. Port 8000 belongs to `strategy_app.py`: report it, leave it. The backup is 131072 bytes. OpenOCD prints `processor detected`. If a port has a holder, or the board shows no `0483:5740`, stop and report: do not kill anything, and do not flash.
  **Result (2026-11-04):** `/dev/ttyACM0` is the STM32 board and `/dev/ttyACM1` the ECG module (MCP2200 serial `0001671253`). 8001 is free. The factory backup is present, 131072 B. The user ran `openocd -f openocd.cfg -c "init" -c "exit"` themselves, because the permission system refused it for the tester: `SWD DPIDR 0x6ba02477`, `[stm32h7x.cpu0] Cortex-M7 r1p1 processor detected`.

- [x] S2. **Firmware: keep every 48th filtered sample (no device).** Files: `Inc/pcg_filter.h`, `Src/pcg_filter.c`, `Src/main.c`, `Tests/pcg_filter_test.c`.
  **Result (2026-11-04):** host test seven lines `ok`, exit 0, 600 Hz at −38.189 dB and 800 Hz at −48.145 dB. Build has no errors, `arm-none-eabi-size` gives text 33264, data 384, bss 10440, so `text + data` = 33648 < 131072. `no pin or clock change` printed. Not flashed: S8 does that.
  - **`pcg_filter.h`:** add `#define PCG_DECIMATE 48 /* 48 kHz in, 1000 Hz out */`. The comment says that `pcg_filter` band-passes `n` raw counts at 48 kHz, writes every `PCG_DECIMATE`-th result to `out`, so `n / PCG_DECIMATE` values, and that `n` must be a multiple of `PCG_DECIMATE`.
  - **`pcg_filter.c`:** after the biquad loop, `if (i % PCG_DECIMATE != 0) continue; /* keeps samples 0, 48, ... of each block */`. The last line becomes `*out++ = …`.
  - **`main.c`:** the header comment gives the new frame. `HALF` stays 480, its comment becomes "samples per DMA half: 10 ms at 48 kHz". Add `#define FRAME_SAMPLES (HALF / PCG_DECIMATE) /* 10 samples at 1000 Hz */`, and `frame[2 + FRAME_SAMPLES]`. The `pcg_filter(…, &frame[2], HALF)` call stays.
  - **`pcg_filter_test.c`:** the sum loop runs to `BLOCK / PCG_DECIMATE`, and the gain uses `sqrt(sum / (FS / PCG_DECIMATE))`. Every `-1e9` becomes `-INFINITY`, because the 2 kHz tone folds onto DC at a zero crossing, so its output is exact zeros, −inf dB, which `-1e9` rejects (the planner's dry-run hit this). Add `{600, -39, -37}` and `{800, -49, -47}`. Do not add 500 or 1000 Hz: they fold to Nyquist and DC, where the RMS depends on the phase.

  **Acceptance:**
  ```
  gcc -O2 -Wall -IInc Src/pcg_filter.c Tests/pcg_filter_test.c -lm -o "$S/pcg_filter_test" && "$S/pcg_filter_test"
  cmake --preset Debug && cmake --build --preset Debug
  arm-none-eabi-size build/Debug/PCG_CDC.elf
  ! git diff -U0 -- Src Inc | grep -E '^[-+].*(GPIO|PA1[34]|RCC_)' && echo no pin or clock change
  ```
  Seven lines ending `ok`, exit 0, with 600 Hz at −38.19 and 800 Hz at −48.15 dB (planner's dry-run). No build errors, `text + data < 131072`, then `no pin or clock change`.

- [x] S3. **PCG browser code for 24-byte frames (no device).** Files: `Web/pcg_parser.js`, `Tests/pcg_parser_test.mjs`, `Web/upsample.js` (new), `Tests/upsample_test.mjs` (new), `Web/index.html`.
  **Result (2026-11-04):** `pcg_parser_test` pass 10, `upsample_test` pass 5, `pcg_audio_test` pass 11, all fail 0, then `audio player unchanged`, `page syntax OK` and `index rates OK`. The Connect guard copied from `ecg.html` also went in, approved by the user on 2026-11-04, so it replaces "Leave the Connect race alone" below: the button is disabled for the whole attempt, and `finally` re-enables it and restores focus. No `opened` flag, because nothing can throw after `open` here and the `catch` closes nothing. Checked by running the page's script under stubs, not in Chrome, so a double-click on Connect is still a user check to add at S9.
  - **`pcg_parser.js`:** `FRAME_BYTES = 24`, `SAMPLES_PER_FRAME = 10`, add `export const RATE = 1000;`, update the header comment. The parser logic stays byte-identical.
  - **`pcg_parser_test.mjs`:** only these replacements. The planner's dry-run with them passes 10/10:

    | Old | New |
    |---|---|
    | `FRAME_BYTES - 836`, and the title's "(the 836-byte fragment the tester saw)" | `FRAME_BYTES - 14`, title without it |
    | "964 bytes later" (test title and comment) | "24 bytes later" |
    | `frame(0).subarray(300)` | `frame(0).subarray(7)` |
    | `[963, 964, 965][k % 3]`, `rnd(2001)` | `[23, 24, 25][k % 3]`, `rnd(51)` |
    | `frame(2).subarray(0, 500)` | `frame(2).subarray(0, 12)` |
    | `j === 100`, `101`, `102`, and "Samples 100 and 101", "sample 102 = 3" | `j === 4`, `5`, `6`, and the same in the comment |
    | `frame(0, fill).subarray(100)`, `f(0).subarray(100)` | `.subarray(8)` |

  - **`upsample.js`:** `createUpsampler(L)` returns `(x) => array`. The first call returns `[x]`. Later calls return the `L` points `prev + (x − prev)·i/L` for `i = 1…L`, so the last one is exactly `x`. Comment: the first sample gives one output and each later one gives L, and no output waits for a later input.
  - **`upsample_test.mjs`, `node:test`:**
    1. **Count:** N inputs give 2N − 1 outputs at L = 2 and 1 + 48(N − 1) at L = 48.
    2. **Fixed map at L = 2:** `y[2m] === x[m]` exactly, and `y[2m+1] === (x[m] + x[m+1]) / 2`.
    3. **Constant and ramp:** a constant stays exact, and a ramp `a + b·m` gives `a + b·j/2` within 1e-9.
    4. **40 Hz:** a unit sine at 500 Hz for 10 s, against the true sine at `j` ms. Largest error between 0.030 and 0.0315, RMS ≤ 0.0160, zero error on even `j`. Planner's prototype: 0.03141.
    5. **Audio use:** 10-sample frames at L = 48 give 480 outputs per frame after the first.
  - **`index.html`:**
    - `import { createParser, RATE } from './pcg_parser.js';` and `import { createUpsampler } from './upsample.js';`.
    - `const RING = 5 * RATE; // 5 s, a whole number of 10-sample frames, so ring.set never wraps`.
    - **`draw()` inner loop, a trap:** the ring is now narrower than a wide canvas, and an empty column would plot ±32767. Use the guard `ecg.html` has: `e = Math.max(k + 1, Math.floor(((x + 1) * RING) / W))`, with its comment.
    - **Audio:** `const up = createUpsampler(48);`. The read loop's post becomes `if (frames++ > 0 && audioNode) audioNode.port.postMessage(Int16Array.from(Array.from(s).flatMap((v) => up(v))));`. One comment: the player runs at 48 kHz and cannot run at 1 kHz.
    - **In `startAudio()`:** `node.connect(new BiquadFilterNode(actx, { type: 'lowpass', frequency: 300, Q: -3 })).connect(actx.destination);` replaces `node.connect(actx.destination);`. One comment: it removes the interpolator's images near 1 kHz, where the ear is most sensitive.
    - **Caption:** "PA6 sampled at 48 kHz, band-passed 20–200 Hz and reduced to 1000 samples/s on the board. Last 5 s, newest on the right. The vertical scale fits the largest sample in view (mV = counts × 3300 / 65536)."
    - **Connect fix:** went in with S3, the same guard as `ecg.html` (user decision, 2026-11-04).

  **Acceptance:**
  ```
  node Tests/pcg_parser_test.mjs; node Tests/upsample_test.mjs; node Tests/pcg_audio_test.mjs
  git diff --quiet HEAD -- Web/pcg_audio.js Tests/pcg_audio_test.mjs && echo audio player unchanged
  python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/index.html').read(),re.S).group(1))" > "$S/pcg_page.mjs" && node --check "$S/pcg_page.mjs" && echo page syntax OK
  grep -qF "Math.max(k + 1" Web/index.html && grep -qF "BiquadFilterNode" Web/index.html && ! grep -qE "48000;|48 kHz\. L" Web/index.html && grep -qF "sampleRate: 48000" Web/index.html && echo index rates OK
  ```
  The three test files end with `fail 0` (`pass 10`, `pass 5`, `pass 11`), then the three OK lines.

- [x] S4. **Share the ECG commands (no device, behaviour unchanged).** Files: `Web/ecg_dsp.js`, `Web/ecg.html`, `Tests/ecg_dsp_test.mjs`.
  **Result (2026-11-04):** `ecg_dsp_test` pass 10, fail 0, then `page syntax OK`, `commands shared` and `0`. Under a stubbed port on a virtual clock, `HEAD` and the moved code gave identical traces over 11 scenarios (298 lines: bytes, waits, writer lock, `writable.close`, keep-alive frame counts), and all 14 injected breaks changed the trace. Not run on the module: S9 does that.
  - **`ecg_dsp.js`** gains, with the comments moved from `ecg.html`:
    ```
    export const START = [[0x02], 100, [0x02], 100, [0x01], 100, [0x01], 5, [0x09]];
    export const KEEP_ALIVE = [[0x09], 5, [0x09]];
    export const STOP = [[0x02], 100, [0x02]];
    export const KEEP_ALIVE_FRAMES = 30000;
    export function createSender(port) { … }
    ```
    `createSender` returns `send(...steps)`, the body of today's `send()` moved verbatim, with `writes` now one chain per port and `p` now `port`. Everything from `FRAME_BYTES` to the end of the filters stays byte-identical.
  - **`ecg.html`:** remove `send()` and `writes`. Add `let send = null;`, and `send = createSender(p);` next to `port = p;`. The three call sites become `send(...START)`, `send(...KEEP_ALIVE)` with `keepAliveAt += KEEP_ALIVE_FRAMES` and its initial value, and `send(...STOP).then(() => p.writable.close()).catch(() => {})`. Nothing else changes.
  - **`ecg_dsp_test.mjs`:** tests 1–9 stay. Add test 10, "commands go out one byte per write, in order": a stub port whose writer records each write and when. `send(...START)` writes five single bytes `02 02 01 01 09`, with gaps of at least 95 ms, 95 ms, 95 ms and 4 ms. A `send(...STOP)` queued during it starts only after the `09`. A writer that throws does not break the chain, and the next `send` still writes.

  **Acceptance:**
  ```
  node Tests/ecg_dsp_test.mjs
  python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/ecg.html').read(),re.S).group(1))" > "$S/ecg_page.mjs" && node --check "$S/ecg_page.mjs" && echo page syntax OK
  python3 -c "s=open('Web/ecg.html').read(); [s.index(x) for x in ('createSender(p)','send(...START)','send(...KEEP_ALIVE)','send(...STOP)','p.writable.close()')]; assert '0x02' not in s and '0x09' not in s; print('commands shared')"
  git diff -U0 -- Web/ecg_dsp.js | grep -E '^-[^-]' | wc -l
  ```
  `pass 10`, `fail 0`, `page syntax OK`, `commands shared`, and `0` (nothing removed from `ecg_dsp.js`). The older E4 and E7 static checks on `ecg.html` fail by design, because they look for the literal sequence: do not rerun them. S9 re-proves the bytes on the module.

- [x] S5. **`Web/recorder.js` and its self-check (no device).** Files: `Web/recorder.js` (new), `Tests/recorder_test.mjs` (new). Constants: `PCG = 1, ECG = 2, EVENT = 3, ECG_1K = 4`, `HEADER_BYTES = 13`, `SEGMENT_BYTES = 256 * 1024`, `ECG_PORT`, `PCG_PORT` (the `{ usbVendorId, usbProductId }` filters), `ALIGN_NOTE` (Decisions).
  **Result (2026-11-04):** `node Tests/recorder_test.mjs` pass 11, fail 0, on synthetic data only, and all 28 injected breaks failed a test. In a separate synthetic session, every gap was recovered from the saved bytes alone: 2 dropped PCG frames by `seq`, 17 lost ECG bytes as a marker hunt, `read-error`, `lost`, and a deleted file as a numbering hole. Not run in Chrome or on the devices.
  - **`record(kind, t, bytes)`** returns the header plus payload of one record.
  - **`createLog(save)`:** `save(index, blob)` is async.
    - `add(t, ...[kind, bytes])` appends one group. A group is never split across files, so a kind 2 record and its kind 4 record stay together.
    - When the open segment reaches `SEGMENT_BYTES`, it is queued and written, one at a time, in order.
    - `event(t, object)` adds a kind 3 record.
    - `flush()` queues the rest and resolves `true` once everything is saved.
    - A failed save stays at the head of the queue, sets `stats.error` and is retried at the next roll or flush. `stats` also holds `saved` and `unsaved`.
    - Comment: `shortcut: unsaved segments stay in memory with no cap, about 600 MB per hour of failed writes (estimated); add a cap if disks ever fill mid-recording`.
  - **`createEcgChain()`:** `createParser()`, `createEcgFilter()` and `createUpsampler(2)` for lead II. `push(chunk)` returns a `Float32Array` of the new 1000 Hz samples. `stats` is the parser's, plus `skippedAfterLock`.
  - **`leadIILine({ raOff, llOff })`:** exactly `RA and LL electrodes on.`, `Lead II not valid: RA electrode off.`, `Lead II not valid: LL electrode off.`, `Lead II not valid: RA and LL electrodes off.`. LA is not part of lead II.
  - **`findPorts(ports)`:** returns `{ ecg, pcg }` by `getInfo()`, `null` where absent, in any order.
  - **`readPort(dev, now, onChunk, onError)`:** the read loop from `ecg.html`, with `dev = { port, reader, stopping }`, and **`const t = now();` the first line after `await reader.read()`**. Non-fatal errors call `onError` and the outer loop resumes. It closes the port and returns the error text, or `''` after a Stop.
  - **`startSession({ ecgPort, pcgPort, log, now, onPcg, onEcg, onLost })`** returns `{ stop, done }`.
    - Writes the `start` event, starts both `readPort` loops in the same tick, then `await send(...START)` and the `ecg-start-sent` event.
    - **PCG chunk:** `log.add(t, [PCG, value])`, then parse, `onPcg(frames)`.
    - **ECG chunk:** `y = chain.push(value)`, then `log.add(t, [ECG, value], [ECG_1K, bytes of y])`, without the kind 4 record when `y` is empty (S14), then `onEcg(y)`. Keep-alive counted, as in `ecg.html`, with a `keep-alive` event.
    - **A stream ending without Stop:** `lost` event, `onLost(name, message)`, `log.flush()`. Both lost: the session ends itself, and `done` resolves after the final flush.
    - **`stop()`:** no keep-alive follows. `await send(...STOP).then(() => ecg.port.writable.close()).catch(() => {});`, both `stopping = true`, cancel both readers, await both loops, `stop` event, `await log.flush()`. PCG keeps logging until the ECG stop is drained.

  **Test, `node:test`, synthetic only, with fake ports built on web streams and an injected `now`:**
  1. **Record layout:** f64 at 0, u32 at 8, u8 at 12, payload at 13, little-endian.
  2. **Segments:** every file starts and ends on a record boundary, a group is never split, numbering runs 1, 2, 3, and the concatenation equals all records in order.
  3. **Failed save:** `save` rejects twice, then works. Nothing is lost or reordered, `flush()` gives `false` then `true`, and `stats.error` is set then cleared.
  4. **`createEcgChain`, chunk independence:** one output for any chunking (1 byte, 41 bytes, random, whole buffer), identical to the sample. Count 2F − 1 for F frames. `y[2m]` equals `Math.fround` of a separate `createEcgFilter()` run on lead II. `skippedAfterLock` counts only bytes lost after the first frame, not the start-up junk.
  5. **`leadIILine`:** the four texts, and an LA flag changes nothing.
  6. **`findPorts`:** either order, a foreign port ignored, `null` when absent.
  7. **Normal session:** the ECG port receives exactly `START`, then `STOP`, then its writable closes, and only then are the readers cancelled. Chunks logged before and during the stop are all present, and `stop` is the last record.
  8. **Keep-alive:** counted at 30 000 frames, none after Stop.
  9. **One device lost:** the ECG stream errors with `readable` null. `lost` is logged once, PCG keeps logging, and Stop still resolves without throwing, with no writes to the dead port.
  10. **Non-fatal read error:** the stream errors, a new `readable` appears, reading resumes, and a `read-error` event sits between the two runs of records.
  11. **Both lost:** `done` resolves with everything saved, with no Stop.

  **Acceptance:** `node Tests/recorder_test.mjs` ends with `pass 11`, `fail 0`.

- [x] S6. **`Tools/load_recording.py` and the round trip (no device).** Files: `Tools/load_recording.py` (new), `Tests/recorder_test.mjs` (extended).
  **Result (2026-11-05):** `node Tests/recorder_test.mjs` pass 13, fail 0, and `git status --porcelain | grep -c ecgpcg` prints `0`. On the 300 s synthetic recording, all ten arrays came back byte for byte, with `pcg_drops` 2, one `ecg_resync` of 23 bytes from the 17 lost, `relative_ppm` 220.48, and the `read-error` and `lost` events reported. A deleted file shows in `missing_segments` and a truncated file in `errors`, and neither raises. All 42 injected breaks in the loader failed a test. Not run on a real recording: S10 does that.
  - **`load(folder)`** returns a dict, and never raises on a damaged recording:

    | Key | Type | Meaning |
    |---|---|---|
    | `pcg` | int16[N] | Samples as sent, stale first frame removed, STM32 clock |
    | `pcg_index` | int64[N] | `10·unwrapped_seq + k`, from the first live frame. Jumps across a drop |
    | `pcg_frame_index`, `pcg_frame_t` | int64, float64 per frame | Index of the frame's first sample, and `t` of the chunk that completed it |
    | `ecg_i`, `ecg_ii` | int16[M] | Raw counts per frame, module clock |
    | `ecg_a1`, `ecg_b1` | uint8[M] | Status bytes (protocol §8.3) |
    | `ecg_frame_t` | float64[M] | `t` of the chunk that completed each frame |
    | `ecg_1k` | float32[2M − 1] | Filtered, upsampled lead II. `ecg_1k[2m]` is frame `m` |
    | `ecg_resync` | list of (frame, bytes) | Each marker hunt after lock |
    | `pcg_drops` | int | Frames missing by `seq` |
    | `events` | list of (t, dict) | All events |
    | `missing_segments`, `errors` | lists | Gaps in file numbering, a record that overruns its file |

    The parsers copy the rules of `createParser` in `pcg_parser.js` and `ecg_dsp.js`.
  - **`summary(rec)`,** printed by `python3 -I Tools/load_recording.py <folder> [--json]`. It holds no samples: `note`, `seconds`, `segments`, `missing_segments`, `errors`, `pcg_frames`, `pcg_drops`, `ecg_frames`, `ecg_resyncs`, `ecg_skipped_after_lock`, `ecg_1k_ok` (`len == 2M − 1`), `lost`, `read_errors`, `keep_alives`, `pcg_hz`, `ecg_frame_hz`, `relative_ppm`, `relative_ppm_halves`, `residual_ms` (p50, p99, max per stream), `chunk_bytes` (median, max per stream).
    - `pcg_hz` and `ecg_frame_hz` come from `np.polyfit` of index against `t`, from 3 s after `ecg-start-sent`, using the longest ECG run between resyncs.
    - `relative_ppm` is `(ecg_frame_hz/500) / (pcg_hz/1000) − 1` in ppm.
    - The module docstring carries the format, the note that this fit is a report, not a correction, and that the fixed offset between the ECG and PCG paths is an unmeasured estimate of about ±3 ms.
  - **Round-trip test:** a 300 s synthetic recording, built through the real `createLog` and `createEcgChain` into `fs.mkdtemp`, and removed afterwards.
    - **Clocks:** PCG +20 ppm, ECG +240 ppm, seeded one-sided jitter.
    - **Contents:** a stale first frame, `seq` starting near 32 000 so it wraps, 2 dropped frames, ECG junk before lock, 17 bytes lost mid-stream, chunks cut mid-frame, and events.
    - **Run:** the test calls Python with `Tools` on `sys.path`, dumps the arrays with `.tofile()` into the temp folder, and compares them with what it generated, byte for byte. It also reads `--json`.
    - **Assert:** exact equality of `pcg`, `pcg_index`, `ecg_i`, `ecg_ii`, `ecg_1k`; `pcg_drops` 2; `ecg_resyncs` 1, with the right frame and bytes; `ecg_1k_ok`; `relative_ppm` within 220 ± 2; `note` equal to `ALIGN_NOTE`.
    - **Damage:** a deleted middle file appears in `missing_segments`, and a truncated last file appears in `errors`. Neither raises.

  **Acceptance:** `node Tests/recorder_test.mjs` ends with `fail 0` and at least `pass 13`, and `git status --porcelain | grep -c ecgpcg` prints `0`.

- [x] S7. **The page, `.gitignore` and the documents (no device).** Files: `Web/recorder.html` (new), `.gitignore`, `P/README.md`, `Acquisition_systems_summary.md`, `ECG_viewer_status.md`.
  **Result (2026-11-05):** `page syntax OK`, five `fail 0` lines (`recorder_test` pass 13), `recordings ignored`, `documents updated` and eight `200` lines, and `Web/` shows only `recorder.html` and `recorder.js`. By the coordinator's decision, `startSession` also returns `ecgStats` and `pcgStats`, the loader's summary gains `clean_stop`, and `.gitignore` gains `__pycache__/`. The page's real script passed 21 scenarios under a stub DOM, fake ports and a fake folder, including Start, Stop, a failed save, a lost device and a double click on Start, and all 32 injected breaks were caught. Not run in Chrome or on the devices: S10 and S11 do that.
  - **`recorder.html`, built from `ecg.html`'s markup and styles:**
    - Title and `<h1>` "ECG and PCG recorder". Buttons `allow` (Allow device) and `start` (Start, toggling to Stop).
    - `role="status"` lines: `devices`, `msg`, `leads`, `warn`. Numbers in a plain `stats` span.
    - Two `<h2>` + canvas pairs, `traceEcg` and `tracePcg`, 34vh each, labelled as in `ecg.html`.
    - **The caption gives:** ECG lead II with the forward-only filters, upsampled to 1000 Hz by linear interpolation; PCG band-passed 20–200 Hz and reduced to 1000 Hz on the board; last 5 s, newest on the right; then `ALIGN_NOTE`, which the script sets on an element with `textContent`, so there is one copy of it.
    - The start-up message and the "no Web Serial" message use port 8001. Add `'showDirectoryPicker' in window` to the capability check.
  - **Script behaviour:**
    - `refresh()` runs at load and on `navigator.serial` `connect` and `disconnect`: `findPorts(await getPorts())`, sets `devices`, and enables Start when both are present and nothing is recording.
    - **Allow device:** `requestPort({ filters: [ECG_PORT, PCG_PORT] })`, then `refresh()`, guarded and with focus restored as in `ecg.html`. Cancelling says so.
    - **Start:** button disabled. `dir ??= await showDirectoryPicker({ id: 'ecgpcg', mode: 'readwrite', startIn: 'documents' })` first, because it needs the click. Then `findPorts` again, `getDirectoryHandle('ecgpcg-YYYYMMDD-HHMMSS', { create: true })`, open PCG `{ baudRate: 115200, bufferSize: 65536 }`, open ECG `{ baudRate: 230400, bufferSize: 65536 }`, `setSignals({ dataTerminalReady: false, requestToSend: false })`.
    - **On any failure:** close only the ports opened in this attempt. `msg` says `Not started: <device>: <message>`, and hints that another page may hold the port.
    - **`save(index, blob)`:** `getFileHandle`, `createWritable`, `write`, `close`, and `abort` on failure. One comment: only `close()` puts the data in the named file, which is why each segment is its own file.
    - **Traces:** two `Float32Array(5000)` rings with their own `written`. ECG takes `y` from `onEcg`. PCG takes `counts × 3300 / 65536`. `MIN_FULL` is 50 for both. `draw(t)` is copied from `ecg.html`, plus `t.unit`.
    - **Each second:** `stats` shows ECG frames/s, PCG samples/s, PCG dropped frames, ECG bytes lost after lock, recording length m:ss, files saved, both scales.
    - **`warn`,** written only when its text changes, shows every true case: no ECG frames, or no PCG samples, for over 3 s while recording; a `lost` device, which stays until the next Start; `stats.error` from saving.
    - **`leads`** comes from `leadIILine`, written only when it changes.
    - **After Stop or a self-ended session:** if `flush()` is `false`, the button reads Retry save and calls `flush()` again. Otherwise `msg` is `Saved <m:ss> in <folder> (<n> files). <ALIGN_NOTE>`.
    - **`beforeunload`:** `preventDefault()` while recording or while unsaved data remains.
  - **`.gitignore`:** a comment, "Recordings are health data", and `ecgpcg-*/`.
  - **`P/README.md`:**
    - Update the header paragraphs (48 kHz sampling, 1000 Hz output, 24-byte frame, sample index from `seq`), the wire format and the "Browser viewer" paragraph.
    - Add a section "Synchronized recorder": what Start does, the `ALIGN_NOTE` text, how to serve it on 8001, the format tables, the loader, and the offline recipe:
      1. Fit `t = a + b·n` per stream, skipping the first 3 s and splitting at `ecg_resync` and `lost`.
      2. `pcg_index` and `j/2` give each sample's host time.
      3. Resample one stream onto the other.
      4. Allow for the filter delays in Decisions.
      5. Say that the fixed offset between the two paths stays an unmeasured estimate of about ±3 ms.
    - Say that stored lead II is distorted in T and ST and delayed about 10 ms at the QRS, and that the raw counts are not.
    - Say that a crash can leave a `.crswap` file, which is also health data.
  - **`Acquisition_systems_summary.md`:** PCG lines 13–18 (ADC still 48 kHz, 1000 Hz out, about 2.4 KB/s, 24-byte frame, 10 samples), and a short "Recorder" section, which says that the fixed path offset is an unmeasured estimate of about ±3 ms. Drop its "Known bug" line about the double click on Connect, fixed in S3.
  - **`ECG_viewer_status.md`:** drop the double-Connect reminder at the end, fixed in S3.

  **Acceptance:**
  ```
  python3 -c "import re;print(re.search(r'<script type=\"module\">(.*?)</script>',open('Web/recorder.html').read(),re.S).group(1))" > "$S/rec_page.mjs" && node --check "$S/rec_page.mjs" && echo page syntax OK
  for t in pcg_parser upsample pcg_audio ecg_dsp recorder; do node Tests/${t}_test.mjs | grep -E '^ℹ (pass|fail)'; done
  git -C ../../../../.. check-ignore -q ecgpcg-20261104-120000/00001.ecgpcg && echo recordings ignored
  grep -q '1000' README.md && ! grep -qE '964|96 ?KB|480 filtered' README.md ../../../../../Acquisition_systems_summary.md && echo documents updated
  python3 -m http.server -b 127.0.0.1 -d Web 8001 >/dev/null 2>&1 & W=$!; sleep 1; for f in recorder.html recorder.js upsample.js ecg.html index.html ecg_dsp.js pcg_parser.js pcg_audio.js; do curl -s -o /dev/null -w "%{http_code} %{content_type} /$f\n" "http://localhost:8001/$f"; done; kill $W
  ```
  Check port 8001 is free first (S1). It must print `page syntax OK`, five `fail 0` lines, `recordings ignored`, `documents updated`, and eight `200` lines. Also run the `Web/` tree through `git status --short`: only the listed files appear.

- [x] S8. **Flash the decimating firmware (tester, stop-and-ask).** No code changes. From the repo root, with `P` as above.
  **Result (2026-11-05):** the pre-flash checks passed: backup 131072 B, `text + data` 33648, ports free. The user disconnected the PA6 wire and the ECG leads first, and ran OpenOCD themselves with `!`, because the permission system refused it for the tester: `processor detected`, `** Verified OK **`. Stream check: `2400.0 True {1}`.
  1. **Pre-flash checks, nothing written:**
     ```
     ls -l ../stm32h7_blinkled_vscode/GPIO_IOToggle_Led/backup/weact_factory_internal_flash.bin
     openocd -f openocd.cfg -c "init" -c "exit"
     arm-none-eabi-size $P/build/Debug/PCG_CDC.elf
     fuser "$(tty_of 0483 5740)"
     ```
     Backup 131072 bytes, `processor detected`, `text + data < 131072`, and `fuser` prints nothing. Close any page holding the board.
  2. **STOP. Do not flash yet.** Report these results, then ask the user to disconnect, not to remove anything. Nothing on the body may be connected to the board or the module during the flash, but the sensor stays under its bandage and the electrodes stay stuck on. The user:
     - Unplugs the wire from the PCG PCB's filter output to PA6, with its ground wire if there is one, or else the piezo from its PCB, whichever connector exists.
     - Unplugs the ECG lead cable from the module, or unclips the leads.

     Flash only when the main session relays that the user has done both and says go. **If the wiring has no such connector for either one, stop here, say which, and ask.** Do not assume, and do not flash. The USB cables and the Atmel-ICE stay connected.
  3. **Flash, with `verify` only:**
     ```
     openocd -f openocd.cfg -c "program $P/build/Debug/PCG_CDC.elf verify reset exit"
     ```
     It must print `** Verified OK **`. Never `unlock`, mass erase or an option-byte command. PA13/PA14 are not reconfigured, and nothing new is connected to PA6: it stays open here and goes back to the PCG PCB's filter output in S9.
  4. **Stream check, still disconnected.** Wait for ModemManager (Rules), then:
     ```
     T=$(tty_of 0483 5740); stty -F "$T" raw -echo && timeout 5 cat "$T" > "$S/pcg.bin"; python3 -c "import sys;d=open(sys.argv[1],'rb').read();s=b'\x00\x80';i=next(i for i in range(len(d)) if all(d[i+k*24:i+k*24+2]==s for k in range(4)));f=[d[j:j+24] for j in range(i,len(d)-23,24)];print(len(d)/5,all(x[:2]==s for x in f),{(int.from_bytes(b[2:4],'little')-int.from_bytes(a[2:4],'little'))%32768 for a,b in zip(f[1:],f[2:])})" "$S/pcg.bin"; rm "$S/pcg.bin"
     ```
     **Acceptance:** `Verified OK`, then 2352–2448 B/s (2400 ± 2 %), `True` and `{1}`. The first frame is skipped for the seq check, because it is the stale one.

  **If anything fails:** stop and report, with no second attempt and no erase. Rollback is the same procedure with the firmware built from `HEAD`.

- [x] S9. **The old viewers on the new firmware (user and tester).** The user reconnects what S8 disconnected, ground before signal, and says go. Serve on 8001 (Rules).
  **Result (2026-11-05):** the user confirmed items 1–3. Item 4: the user double-clicked Connect and "the button acted the same as if were just one click", so one chooser and no error. Focus was not reported separately. Listen: 0 bytes in 2 s after Disconnect.
  1. **`http://localhost:8001/` (Connect, pick "WeAct H750 PCG"):** about 1000 samples/s, drops stay 0, the heart sounds look as before, slightly coarser. Disconnect. The user confirms.
  2. **`http://localhost:8001/ecg.html`:** within 3 s about 500 frames/s and both leads, and "Disconnected." after Disconnect. **Tester:** listen under 1000 bytes. This re-proves S4's moved commands.
  3. **Audio, a quick look only:** Start audio works and plays at low volume. The full check stays in step 6c, for the user.
  4. **The Connect fix from S3, on `http://localhost:8001/`:** double-click Connect in Chrome. One chooser opens, no "already open" message appears, and keyboard focus is still on the button.

  **Acceptance:** the user confirms 1–4, and the listen passes. If `ecg.html` misbehaves, stop before S10: the module's bytes come first.

- [x] S10. **First recording, 2 minutes (user and tester).**
  **Result (2026-11-05):** the user confirmed item 1: traces, electrode line and a responsive tab. Summary of the 247.78 s recording: `errors`, `missing_segments`, `lost` and `read_errors` empty; `pcg_frames` 24621, `pcg_drops` 0; `ecg_frames` 122806, `ecg_resyncs` 0, `ecg_skipped_after_lock` 0, `ecg_1k_ok` True; `keep_alives` 4; `clean_stop` True; `pcg_hz` 999.9965, `ecg_frame_hz` 499.7414; `relative_ppm` −513.7, `relative_ppm_halves` −521.5 and −504.8; residual p50 0.30/0.33 ms, p99 7.20/6.87 ms, max 23.6/24.7 ms; chunks ECG median 2 B (max 520), PCG median 24 B (max 72); no stall over 50 ms after lock. Listen: 0 bytes. The user keeps the recording, outside the repo.
  1. **User:** open `http://localhost:8001/recorder.html`. Allow device twice if asked. Start, and in the folder dialog make a new folder outside the repo, for example `~/Documents/ecg_pcg_recordings`. Both traces appear within about 3 s, ECG settles in about 2 s, and the line reads "RA and LL electrodes on.". Report it if the tab looks slow, or Chrome's task manager shows above about 20 % CPU. After 2 minutes or more, click Stop.
  2. **User:** tell the tester the recording's folder.
  3. **Tester:** `python3 -I Tools/load_recording.py "<folder>"` and report the whole summary. It holds no samples.

  **Acceptance:** the user confirms item 1, and the summary shows these counts for 2 minutes, scaled if the recording ran longer:
  - `errors`, `missing_segments`, `lost` and `read_errors` empty.
  - `pcg_frames` 11 800–12 200, `pcg_drops` 0.
  - `ecg_frames` 59 000–61 000, `ecg_resyncs` 0, `ecg_skipped_after_lock` 0, `ecg_1k_ok` true.
  - `keep_alives` at least 1.
  - `|relative_ppm|` under 1000.
  - `residual_ms` p99 under 20 for both.
  - Listen under 1000 bytes.

  **Measured here, and recorded in the result line:** real chunk sizes, residuals and `relative_ppm`, to replace the model in the alignment budget. If p99 is over 20 ms, or anything else fails, report it to the planner: moving the read loops into a worker is the known fallback. The tester deletes this recording once the user agrees, unless the user keeps it as a first real recording.

- [x] S11. **Failure drills (user and tester).** Each is a short recording, about 30 s, and each folder is deleted afterwards. A drill may disconnect a USB cable, never a sensor from the body.
  1. **Unplug the board's USB-C while recording.** Before Start, take the PCG PCB's signal wire off PA6, because the PCB stays live on its battery while the board has no power (Decisions). Put it back only after USB is back. Within about 3 s `warn` names the PCG board and stays, and the ECG trace keeps moving. Stop. "Saved …". The summary shows `lost` for PCG and ECG frames continuing past that time. Replug and wait (Rules).
  2. **Unplug the ECG module's USB cable while recording,** not its lead cable. The same, the other way round. Replug and wait.
  3. **Kill the tab while recording:** Shift+Esc, select the tab, End process. The folder still holds the earlier files. The summary shows empty `errors` and a length within 10 s of the elapsed time. **Tester:** listen about 40 000 bytes (module left streaming). Reload and Start: frames within 3 s, then Stop, and listen under 1000 bytes.
  4. **Try to close the tab while recording.** Chrome asks first. Cancel, and the recording continues.
  5. **Open `ecg.html`, Connect, then Start in the recorder.** `Not started: ECG module: …`, and `fuser` on the board's port prints nothing, so the PCG port was not left open. Disconnect `ecg.html`.

  **Acceptance:** the user confirms 1–5, and the tester reports each summary and listen.

  **Scope, user decision 2026-11-06:** only items 1 and 3 are done. Items 2, 4 and 5 are skipped, so the loss of the ECG module, the close prompt and a busy port stay proven on simulated devices only.

  **Item 1 result (2026-11-06):** passed. `lost` for PCG 1.0 s after the last PCG chunk, ECG ran 152 s past it with 0 resyncs, `clean_stop` true, and the user saw the warning and "Saved …". The run lasted 200 s, and USB went back before Stop. A lost stream does not return to its session, by design, and a new Start worked with frames from both devices. The first open after the replug logged one `Break received` in `read_errors`, with 0 frames dropped and no repeat on the next two opens; the cause is unknown. Measured rate after S14: about 165 KB/s, which matches the estimate. **New fault:** after the PA6 wire went back, PCG is mostly 50 Hz (about 290 mV RMS, 78 % at 49–51 Hz, against 99 mV and 1.4 % before). The cause is not known. **User decision, 2026-11-06:** the hum is not investigated further, no more drills or checks: this is not commercial software. S12 stays the user's own, as a real recording, whenever they need one.

  **Item 3 result (2026-11-06):** passed on the data. Killed recording: 49 consecutive files, none empty or half-written, `errors` empty, 78.16 s, loss at most 1.76 s, `clean_stop` false as expected. Listen: 40 001 bytes, 499.5 frames/s, nothing sent. The tab closed outright, so the page was reopened, and Chrome kept the device grant. Restart: first frame of the restarted stream at +0.397 s, `clean_stop` true, and a listen 2 min 8 s after Stop gave 0 bytes. The user saw both traces move; "Saved …" not yet confirmed. **After a takeover,** `ecg_resyncs` is 1 by design: the frames before that row (6 here) are stale and should be dropped offline, and S10's "0 resyncs" applies only to a Start on an idle module. **The ECG tail is explained:** all 8 recordings ending with a clean Stop end in the same 4 bytes, and the killed one does not, so it is a fixed trailer the module sends on stop. Its meaning is not decoded.

- [ ] S12. **A long recording (user).** Record at least 10 minutes, past nine keep-alives, doing what the real use will be, with the tab in view.

  **Acceptance:** as S10, scaled to the length. `relative_ppm_halves` differ by under 5 ppm, so a straight line per recording is enough. If not, tell the user that a piecewise fit is needed. S10's recording differed by 16.7 ppm, so this may fail: the limit stays. The user tries the offline correction with the loader's arrays and says whether the file has what they need. This recording is the user's to keep or delete.

  **Result (2026-11-06):** 11.93 minutes, 11 keep-alives, 71 451 PCG and 356 947 ECG frames, 0 drops, 0 resyncs, `clean_stop` true, `errors` and `missing_segments` empty, `ecg_1k_ok` true, `residual_ms` p99 4.23 and 7.39. `relative_ppm` −184.04. **`relative_ppm_halves` −215.90 and −150.93 differ by 64.97 ppm against the limit of 5, so a piecewise fit is needed;** the user has been told. Export: 11.14 MB, 56.0 MB/hour, and `check_export.py` found every sample and timestamp identical, with all 427 source sha256 unchanged. PCG 165 mV RMS, 1.4 % at 49–51 Hz, so the hum was absent here, cause still unknown. Open: the user's offline-correction trial.

  **User decision (2026-11-06):** keep the piecewise fit for drift correction. The user does it offline, so it changes no code.

- [x] S13. **Four-file export, offline (executioner, then tester, no device).** User decision, 2026-11-05, "Option A": the recording path stays untouched, and the small files stay the master copy. Files: `Tools/load_recording.py`, `Tests/recorder_test.mjs`, `P/README.md`.
  **Result (2026-11-05):** Code done, and the tester's run on the user's first recording (item 6) passed. On that recording: 275 source files with sha256 unchanged, `ecg_resync` 0 rows, and `pcg.npy` 246210, `ecg_raw.npy` 122806, `ecg_filtered.npy` 245611, `pcg_frame_t` 24621, `pcg_frame_index` 24621, `ecg_frame_t` 122806. The independent script, which does not use the loader, found every sample and timestamp identical, with zero bytes after the last sample in all seven arrays. The export is 3.836 MB, which is 55.7 MB/hour, 18.8× smaller than the small files' 1046 MB/hour. The ECG stream also ended with a 4-byte remainder with no frame marker, unexplained, and left out of the export. **Ruling on the tester's deviation:** a remainder under 40 bytes at the end of a stream cannot hold a whole frame, so it is not a "later break in the 40-byte step", and no sample was omitted. `node Tests/recorder_test.mjs` pass 15, fail 0, and the other four suites still pass 10, 11, 5 and 11. All 14 corruption cases in the test exit 1, name the place, and leave no `-export`, and the same wrapper with no damage exits 0. Scratch proof on synthetic data only: all 22 080 single-bit flips inside the samples of the four files were caught, the 2152 flips that passed sit outside the samples and change none, all 109 structured corruptions were caught with the right message, and all 51 injected breaks in the export code failed a test, while an unbroken copy passed. Known limit: bytes appended after the last sample of a `.npy` pass, because no reader sees them and every sample is still identical. One addition to the plan: `--json` with `--export` is refused with the usage text, because the mixed output would parse as neither. **Added after the tester's run, by the coordinator:** the export folder is created 0o700 and its files 0o600, as private as the recording, which the round-trip test asserts, and the docstring and README say that when the summary shows `ecg_1k_ok` False, `ecg_filtered[2m]` no longer equals frame `m` past the hole. The export the tester made predates this, so it keeps the default modes.
  1. **Command:** `python3 -I -B Tools/load_recording.py <folder> --export`, added to the usage text. It prints the usual summary first, so `note` (`ALIGN_NOTE`), `errors`, `missing_segments` and `clean_stop` stay in view. A damaged recording still exports as `load()` gives it. With no segments, it exits non-zero and makes no folder.
     - **Where:** `src = Path(folder).resolve()`, then `src.with_name(src.name + '-export')`. A plain `folder + '-export'` lands inside the recording when the path ends in `/`.
     - **Order:** if `<name>-export` or `<name>-export.partial` exists, exit non-zero and touch nothing. Otherwise `load()`, `write_export(rec, partial)`, `verify_export(rec, partial)`, then rename `.partial` to `-export`, so that name always means verified. Both names match `ecgpcg-*/`. Only `load()` opens the recording folder.
  2. **The four files,** described in the loader's docstring and in one README line under the loader's command:

     | File | Type | Holds |
     |---|---|---|
     | `pcg.npy` | float32[N] | `pcg`: filtered ADC counts, ×3300/65536 gives mV at PA6. Nominal 1000 Hz, STM32 clock |
     | `ecg_raw.npy` | float32[M] | `ecg_ii`: unfiltered counts, µV per count unknown. Nominal 500 Hz, module clock |
     | `ecg_filtered.npy` | float32[2M − 1] | `ecg_1k` as stored, in counts. Nominal 1000 Hz. T and ST distorted, QRS about 10 ms late (forward-only filters) |
     | `timestamps.npz` | Four named arrays | `pcg_frame_t`, `ecg_frame_t`: float64, host ms (`performance.now()`, one clock), when the chunk with the frame's last byte arrived. `pcg_frame_index`: int64. `ecg_resync`: int64[R, 2] of `(frame, bytes)`, shape (0, 2) when empty |

     `.npz` fits the last file: one `np.savez` file, uncompressed, named arrays of different lengths, no pickle. Every int16 fits float32 exactly.
     - **PCG sample index:** position `p` in `pcg.npy` is sample `pcg_frame_index[p // 10] + p % 10`, in the frame stamped `pcg_frame_t[p // 10]`. After a dropped frame, `p` alone is wrong.
     - **ECG sample index:** frame `m` is `ecg_raw[m]`, `ecg_filtered[2m]` and `ecg_frame_t[m]`, and an odd `ecg_filtered` index is halfway between two frames. ECG has no counter, so `m` counts time only between resyncs. A row `(m, bytes)` means `bytes` were skipped just before frame `m` (`m == M`: the stream ended still hunting), and the stamps give the size of the loss.
  3. **`verify_export`, sample by sample:** it reopens each file and checks for exactly four files, then each array's name, dtype and shape. It then compares raw bytes against the `rec` arrays, with `pcg` and `ecg_ii` widened to float32. Bytes, because a cast down to int16 hides a 3.5, and `==` passes −0.0 and fails NaN. A mismatch exits non-zero, naming the file (and the array in `timestamps.npz`) and the first mismatching index, and says the export is invalid, stays as `.partial`, and the recording is untouched. On success it prints the samples verified per file and per `timestamps.npz` array, never a sample. Code comment: `shortcut: the read-back may come from the OS cache, add fsync and a cache drop if a disk fault ever matters`.
  4. **What the four files omit:** lead I and the rest of each ECG frame, electrode flags, per-chunk stamps and events stay only in the small files. The docstring, the README line and the command's last output line all say so, and say to keep the recording folder.
  5. **Self-check, synthetic only: two new tests on `recording()`.** Its folder is `dir/recording`, so the export stays inside the temp `dir`.
     - **Round trip:** export with a path ending in `/`. Dump the four files with numpy, as `DUMP` does, and compare them byte for byte with `r.expected`, `pcg` and `ecg_ii` as float32. The PCG formula above gives `r.expected.pcg_index` across the 2 dropped frames, and `ecg_resync` holds its one row. Stdout has `ALIGN_NOTE`, the omission line and the counts, in under 5000 characters. The recording's names and bytes are unchanged. A second export exits non-zero and changes nothing.
     - **Corruption:** a `-c` snippet wraps `write_export` to damage its output, then runs `export()`, once each for a flipped low bit in each `.npy` and in one `timestamps.npz` array, +0.5 on one `pcg.npy` value, a file one sample short, and a float64 `pcg.npy`. Each exits non-zero, names the file and the index or length, and leaves no `-export` folder.
  6. **Tester, once, on the user's first recording.** Write `$S/check_export.py` first, then run this in one shell, so the hashes stay in memory:
     ```
     R=<the first real recording>
     before=$(cd "$R" && sha256sum *); echo "$before" | wc -l
     python3 -I -B Tools/load_recording.py "$R" --export; echo "exit $?"
     [ "$before" = "$(cd "$R" && sha256sum *)" ] && echo 'source unchanged'
     python3 -I -B "$S/check_export.py" "$R"
     du -cb "$R-export"/* | tail -1
     git status --porcelain | grep -c ecgpcg
     ```
     `check_export.py` is the tester's own, written from the format tables in Decisions and protocol §8, with no import of `load_recording` and no line copied from it. It walks the raw records, rebuilds every frame, and compares all four files, every array, with exact equality. It applies the stale first frame, unconfirmed last frame and last-byte `t` rules, hunts only for the first frame, and fails on any later break in the 24- or 40-byte step. It writes nothing and prints only counts and the first mismatching index.

  **Acceptance:**
  - `node Tests/recorder_test.mjs` ends with `fail 0` and at least `pass 15`.
  - The export prints `exit 0`, then `source unchanged`, and the first line matches the folder's segment count.
  - The command and `check_export.py` both report, with no mismatch: `pcg.npy` 246210, `ecg_raw.npy` 122806, `ecg_filtered.npy` 245611, `pcg_frame_t` and `pcg_frame_index` 24621, `ecg_frame_t` 122806, `ecg_resync` 0 rows. These follow from S10's 24621 PCG frames, 122806 ECG frames and 245611 kind 4 values.
  - The tester reports the export's size in MB and the MB/hour it implies. Expected from the array sizes: about 3.84 MB and about 56 MB/hour for 247.78 s, against about 1 GB/hour for the small files.
  - The last command prints `0`. The export stays beside the recording, the user's to keep. The tester reports counts and size only: no sample or hash is printed, and no real data goes into the repo, a fixture or `$S`.

  **Not in this step:** a drift-corrected or resampled export, other file formats, compression, an overwrite option.

- [x] S14. **No empty kind 4 records (executioner, no device).** S10's recording showed about 10 200 ECG chunks/s, of which only about 500 complete a frame, and each of the others wrote an empty kind 4 record: 13 bytes, about 126 KB/s, 95 % of kind 4 records. `startSession` now leaves the kind 4 record out when `y` is empty. Raw logging, including its `finally`, record contents, timestamps, headers and `format: 1` are unchanged. Files: `Web/recorder.js`, `Tools/load_recording.py` (docstring only), `Tests/recorder_test.mjs`, `P/README.md`, this plan.
  **Result (2026-11-06):** `recorder_test` pass 17, fail 0, and the other four suites pass 10, 11, 5 and 11. The loader held no assumption of one kind 4 record per kind 2 record: `load()` joins kind 4 payloads, so its code is unchanged. The assumption was in `makeRecording` in the test, which now writes both forms through the real `createLog`. Apart from the empty records, the two logs are identical record for record, and both give the same arrays, summary (except `segments`, the file count) and export, with `ecg_1k_ok` true, 2M − 1 values and `ecg_1k[2m]` as frame `m`. A new session test covers chunks giving 0, 1, 2 and 10 samples, a chunk that makes `chain.push` throw, and the real session's files through the loader. All 9 injected breaks failed a test, including an empty record written, non-empty records skipped, and raw bytes lost, while an unbroken copy passed. Synthetic data only. **Still open: the new rate of about 165 KB/s is an estimate.** S11 and S12 measure it, as folder bytes over `seconds`, and the roll time and the crash loss of about 1.6 s follow from it. A known race, in `HEAD` too: the keep-alive test can fail at `pcg.feed` on a busy machine (11 of 12 runs on `HEAD` and on this change with 8 CPU hogs, 0 of 12 idle).

- [x] S15. **Minimalist recorder page and one time-zoom slider (executioner, then the user in Chrome).** User request, 2026-11-06: "improve the frontend with a minimalist design. Also add a bar to allow me increase or decrease the resolution of the graphics/frequency (pcg or ecg) appearing in the screen." User changes, the same day: after the first version had one slider per trace, "the bars must be just one for both graphics"; and after the second looked only plain, "I told you a minimalist design, similar but not equal as that as apple for example https://developer.apple.com/design/resources/". One file: `Web/recorder.html`. `recorder.js`, the record format, the loader, `index.html` and `ecg.html` stay as they are. The slider needs nothing from `recorder.js`, because `onEcg` and `onPcg` already fill the rings. "Settings" under Not doing does not cover this slider, which the user asked for.
  **Result (2026-11-06):** Code done, with one slider and the design pass, and the user accepted the page in Chrome on 2026-11-06 ("Ok, it's working"). On this version: `page syntax OK`, and `pcg_parser` 10, `pcg_audio` 11, `upsample` 5, `ecg_dsp` 11 and `recorder` 17, all `fail 0`. `sha256sum` of `Web/recorder.js` (`a01b5c74…`) and `Tools/load_recording.py` (`21251db5…`) is the same before and after. With the two harness edits, 21 of 21 scenarios pass, and all 32 injected breaks fail: 31 by the tally, and `close-all-on-fail` by three `FAIL` lines before its own null `.close()` crashes the run, which the wrapper prints as `BROKEN`, on `HEAD`'s page too. A scratch check of the real `draw()` and listener, 33 checks, all 5 of its own injected breaks caught: at 5 s the new `draw` plots exactly the points of `HEAD`'s at 18 widths and fills, windows of 1, 2, 5 and 10 s show exactly their last `n` samples past the ring wrap, and the one listener sets the text, the fill and `dirty`, after which both traces draw the same window. Headless Chrome, Web Serial disabled, on a scratch copy with synthetic traces and transitions off, showed the page at 1280×800, 1920×1080 and 700 px, with a warning, in Retry save and idle, after a real `input` event to 1 and 10 s, with focus on Start and on the slider, and at 2× scale. `draw` already scaled for `devicePixelRatio`, and text and lines stay sharp. In a 1920×1080 window (937 px viewport) the second card ends at 887, and in a 950 px window (807 px viewport) with a warning at 800. Contrast: secondary 5.07:1 on white, 4.66 on the page, 4.95 on the bar; white on the accent 4.62; warning 5.72. **Three decisions, away from the coordinator's spec for accessibility:** the accent is `#0a70ec`, not `#0a7cff`, where white text is only 3.93:1. The focus ring is at alpha .8, not low alpha, because 3:1 against the page takes that, and .3 gives 1.5:1. The empty status uses zero margins (item 5). Also from the executioner: the `<span>` and `autocomplete="off"` in item 1, because a `<label>` may hold only its own control and `<output>` is labelable, and a restored slider position must not disagree with the `5 s` text. Whether Chrome would restore it here was not checked. Not run on real data, and a real mouse and real arrow keys are the user's check.
  1. **Slider:** one, for both traces. A `<label>` "Window" around a native `<input type="range" min="1" max="10" step="1" value="5" autocomplete="off">` (`seconds`), with an `<output>` showing `5 s` (`secondsValue`) beside it, both in a `<span>`. Its one `input` listener sets that text and `dirty = true`, and nothing else, so a move also redraws after Stop. Display only.
  2. **Draw:** `RING` grows from 5000 to 10000 (10 s at 1000 Hz, about 40 KB per trace). It is the only buffer that must grow. `draw` must stop using `RING` as the window, or the default silently becomes 10 s: `n = seconds.value * 1000` replaces `RING` in the column loop, and the read becomes `ring[(written + RING - n + k) % RING]`. The `Math.max(k + 1, …)` guard stays: at 1 s the canvas is usually wider than the 1000 samples, the real limit of the detail.
  3. **Text:** "Last 5 s" leaves the caption and "last 5 seconds" leaves both `aria-label`s, because both would be wrong after a move. `ALIGN_NOTE` stays in the caption.
  4. **Look: calm and polished, in our own design, with no logos, assets or names of that company.**
     - **Colours, as `:root` variables:** page `#f5f5f7`, cards white, text `#1d1d1f`, secondary `#6e6e73`, hairlines `rgba(0,0,0,.08)`, accent `#0a70ec`, warning `#b3261e` on `#fdecea`. No dark mode.
     - **Type:** a system font stack, antialiased, no web fonts, at 22, 14, 13 and 12 px.
     - **Layout:** a sticky translucent top bar with a hairline, title left, controls right. Content centred, max-width 1280 px, 28 px gutters. Each trace in a white card, radius 18 px, soft shadow, no border. Canvas height `calc(50vh - 175px)`, at least 180 px, so both cards fit a 1080p window with a warning showing. The caption is a 12 px footnote.
     - **Controls:** pill buttons with soft hover and pressed states. Start and Stop are filled accent, and Allow device and Retry save light grey, which `render()` sets with class `quiet` on `start`. Disabled is by opacity. The slider uses `appearance: none`, with a thin track filled up to the thumb through `--fill`, and a white round thumb.
     - **`draw`:** gridlines `#eeeef0`, labels 12 px in `#6e6e73` with the page's font stack, ECG line in the accent, PCG line `#e0565b`.
  5. **Stays exactly:** every ID (`allow`, `start`, `devices`, `status`, `msg`, `stats`, `leads`, `warn`, `traceEcg`, `tracePcg`, `note`), every `role="status"`, all status and warning text, the start-up hint in `msg`, and all script outside `RING`, `trace()`, `draw()`, the listener and the one `quiet` line in `render()`. The status lines stay above the traces, so `warn` and `leads` are never pushed below them. `warn` stays red and bold, on a pale red rounded banner. An empty status takes no space through zero margins, not `display: none`, which takes a live region out of the accessibility tree, so a new warning would go unannounced. Buttons and the slider keep a 3 px focus outline.

  **Known effects, left as they are:** auto-scale uses only what is on screen, so at 1–2 s the vertical scale can jump between beats.

  **Checks (executioner):**
  - S7's `page syntax OK` line.
  - The five node suites, `fail 0`, with S14's counts. None reads this page, so they prove only that nothing else moved.
  - `sha256sum Web/recorder.js Tools/load_recording.py` before and after, because S14's edits are uncommitted and `git diff` cannot show this.
  - S7's scratch harness, `$S/harness_recorder_page.mjs`, not in the repo, needs two edits. Add `value: '5'` to its stub element, or "normal recording" and "a canvas wider than the ring" fail (planner's probe on a copy of this change: 19 of 21, then 21 of 21). In its `no-column-guard` mutant, change `RING` to `n`. The other 31 mutants still find their text. Keep `id="start" type="button" disabled` in that order, because the stub matches that text.

  **Acceptance (the user, Chrome, about a minute, no tester device work):** hard-reload `http://localhost:8001/recorder.html`. The page looks right. During a short recording, the slider changes the view of both traces, by mouse and by arrow keys, and the status lines stay readable. Stop shows `Saved … (<n> files)`. The recording is the user's to keep or delete.

  **Not in this step:** an amplitude zoom, pan or scroll-back, a time axis, remembered slider positions, new tests.

- [x] S16. **PCG audio button on the recorder page (executioner, then the user with headphones).** User request, 2026-11-06: "Put again the button for hearing the audio (PCG sounds) while recording". One file: `Web/recorder.html`. `recorder.js`, `pcg_audio.js`, `upsample.js`, `index.html`, the record format and the loader stay byte-identical. "Audio" under Not doing no longer covers this page.
  **Result (2026-11-06):** Code done, with the player at 1.0 and the Volume slider, and the user's headphone check passed on 2026-11-06 ("Ok, it's working"): they hear the PCG sound on the recorder page, which answers step 6c's question about the upsampled audio. `page syntax OK`, and `pcg_parser` 10, `pcg_audio` 11, `upsample` 5, `ecg_dsp` 11 and `recorder` 17, all `fail 0`. `sha256sum` before and after is the same for `Web/recorder.js` (`a01b5c74…`), `Tools/load_recording.py` (`21251db5…`), `Web/pcg_audio.js` (`31e346a2…`), `Web/upsample.js` (`e780419a…`) and `Web/index.html` (`a95822e5…`).
  - **Harness:** 27 of 27, six runs in a row: the 21, the planner's four audio scenarios, one for a second recording in the same tab, a warning cleared by Start and by Start audio, a fade that throws and a new upsampler for each start, and one for the slider: live gain, read at Start audio, the gain node's place in the graph, samples unscaled, recorded bytes as received. All 55 mutants fail: the 32, 14 for audio and 9 for the slider. That is 54 by the tally, and `close-all-on-fail` by three `FAIL` lines before its crash, as in S15.
  - **A fault in the executioner's own scenario, found and fixed:** recording folders are named to the second, so the second-recording scenario failed whenever both recordings fell in the same second. Its earlier passes and the first mutant runs depended on that timing, so it now waits for the next second, and all 55 mutants ran again after the fix. **The page has this limit too, left as it is:** Start, Stop and Start again inside one second reuse the folder, and the second recording overwrites the first one's files.
  - **Volume:** the user heard the first version too low even with the system volume at maximum, so the player went to 1.0 (item 2), which `maxValue: 1` in `pcg_audio.js` allows. The user then asked for the slider (item 6).
  - **The planner's `edit.py`:** it cleared the warning only in `startAudio`, so `start()` now clears it as well, as item 5 says.
  - **Real graph:** the stubs prove no sound, so a scratch driver ran headless Chrome, muted, Web Serial disabled, on synthetic samples. With this version: `running` at 48000 Hz, player `volume` 1, gain 2.5 from the slider at start, then 0.5 and 1.2 live, `closed` after Stop audio, text only with audio off, and 3 at the next start. The one underrun there came from that check ending its feed. The earlier run at volume 0.1 reported 0 underruns.
  - **Top bar:** one row at 1280 px, and at 700 px title, sliders and buttons on three rows, with the buttons grouped so they wrap together.
  - **Not done:** nobody has heard the new level, and it has not run with the devices.
  1. **Reuse:** import `createUpsampler` from `upsample.js`, and load the existing `pcg-player` with `addModule('pcg_audio.js')`. Nothing moves out of `index.html`: its `startAudio` and `stopAudio` are inline, so about 12 lines (context at 48 kHz, worklet options, the 300 Hz `Q: -3` biquad, fade and close) are copied. A shared module loses: `pcg_audio.js` is marked byte-identical, so it would mean a new file and edits to a verified page and its harness, to save 12 lines. Code comment: `shortcut: this graph is copied from startAudio in index.html, share it if either page's sound ever changes`.
  2. **Button:** `<button id="audio" type="button" disabled>Start audio</button>` after `allow`, with no new CSS, so it is the same quiet pill. `render()` sets it: `Stop audio` while on, enabled only while `recording` with PCG not in `lost`, and disabled while starting. The `AudioContext` is created in the click, before any `await`. `parameterData: { volume: AUDIO_VOLUME }` fixes the volume at 1.0, not the worklet's 0.1, which stays `index.html`'s default. User's reason, 2026-11-06: the audio is too low even with the system volume at maximum. On the user's 12-minute recording, RMS 3345, p99.9 19 410 and max 25 757 counts give RMS 0.10 (−20 dBFS), p99.9 0.59 and max 0.79 at 1.0, so it is 20 dB louder and that recording does not reach the clamp. The system volume and the slider in item 6 set the level.
  3. **Stopping:** `stopAudio()` in `setState` for every state but `recording`, and in `onLost` for `pcg`, which also calls `render()`. After `await addModule`, close instead if that state has gone, or a Stop during the load leaves audio running.
  4. **Feed:** at the end of `onPcg`, inside `try`/`catch`, post `Int16Array.from(Array.from(s).flatMap((v) => up(v)))` per frame, with a new `createUpsampler(48)` per start. The `try` is required: `onPcg` runs inside `readPort`'s `try`, so a throw would become `read-error` events in the recording (planner's probe: 6). `stopAudio` must not throw: it clears its state first, and its fade has its own `try`. Audio starts after the stale first frame, so `index.html`'s skip is not needed.
  5. **Errors:** a failed start, a caught throw and `node.onprocessorerror` set one variable, shown by one new line in `warnings()`: `Audio failed: <message>. The recording is not affected.` The next Start audio or Start clears it. Every existing ID, status text and warning stays.

  6. **Volume slider.** User request, 2026-11-06: "add another bar to increasing the volume inside the app browser". This replaces the fixed level in the first version of this step.
     - **Markup:** one native range input `volume` in the top bar, label "Volume", value in `volumeValue` as a percentage, 0–300 %, step 10, default 100 %, `autocomplete="off"`, styled exactly like the Window slider, and always enabled, so it can be set before audio starts.
     - **Graph:** the player's `volume` stays at 1.0, so the fade-out in `stopAudio` keeps working. One `GainNode` sits after the biquad, before the destination. `startAudio` reads the slider when it builds the graph, and a move sets the gain live with `setTargetAtTime`, 20 ms as in `index.html`. With no audio running, a move only updates the text.
     - **Limits:** the gain is in the audio graph only, so the recording path, `onPcg`'s feed and its `try` do not change. Above 100 % loud peaks can clip what is heard. That is accepted, because it is audio only.

  **Checks (executioner):** S7's `page syntax OK`. The five node suites, `fail 0`, counts unchanged. None reads this page. `sha256sum` of the byte-identical files before and after. In `$S/harness_recorder_page.mjs`, line 12 must also rewrite `'./upsample.js'` to a file URL, or all 21 scenarios fail on the import. The 21 need no audio stubs, because audio runs only on a click. `$S/s16_probe/harness_audio.mjs` adds that rewrite, `AudioContext`, `AudioWorkletNode` and `BiquadFilterNode` stubs and four audio scenarios (planner's probe on a copy: 25 of 25, and all 32 mutants still find their text).

  **Acceptance (the user, about 3 minutes):** **headphones only, because a speaker can reach the piezo and end up in the recording.** **Set the system volume low first, and do not leave it at maximum: since the change to 1.0 the page is 20 dB louder than when it was judged too low there.** During a recording, Start audio: heart sounds fade in with no click, low thumps about 0.1 s behind the trace, with no clicks, gaps or pitch wobble. Leave Volume at 100 % at first, and raise the system volume, then Volume, slowly if faint. Moving Volume changes the level with no click, and above 100 % loud peaks may clip in the headphones only. Stop audio, then Start audio again: clean. Stop: the sound ends, the button goes back to Start audio, and the page shows `Saved …`. The tester then runs the loader on that recording: `read_errors` empty and `pcg_drops` 0.

  **Step 6c:** a pass answers its open question, how the upsampled audio sounds, so tick 6c with that note. Its `index.html`-only items (volume slider, Disconnect and reconnect, the buffered and underrun numbers) go with it, because the user records from this page. Its 10-minute run counts only if the user listens that long.

  **Not in this step:** a filter choice, an audio stats line, audio outside a recording.

## Not doing

- **Alignment on the page:** drift correction, resampling to a common clock, any automatic alignment (the user does it offline).
- **Firmware:** a start/stop command, a wider counter, averaging before decimation, host pings, a hardware trigger, any way to get 48 kHz or unfiltered PCG out of the board.
- **Recording:** an in-memory or single-file mode, a format option, pause, a recording list, compression, a worker for the read loops (the fallback if S10 demands it), a screen wake lock.
- **Page:** audio, a lead I trace, a preview before Start, a sample-aligned display, auto-reconnect, settings.
- **ECG:** a better interpolator than linear, filter changes.
- **Loader:** plotting, the drift correction itself, a re-implementation of the §12 chain.
- **Tap calibration:** dropped by the user on 2026-11-04, because refitting the piezo under the bandage is impractical. `Tools/tap_offset.py` is not written, and the fixed path offset stays an unmeasured estimate of about ±3 ms.
- **Other pages:** the stale "port 8000" text in `index.html`, `ecg.html` and the README's older sections. The `index.html` Connect fix is no longer on this list: it went in with S3 (user decision, 2026-11-04).
- **Checks skipped after the flash:** step 4b's register dump and 4c's ADC read, because clocks and ADC are unchanged and the stream check covers them.
- **Cleanup:** deleting the F1 tree, and editing the two older plan sections.

## Needs the user

- **Before S8:** do not take anything off your body. The sensor stays under its bandage and the electrodes stay stuck on. Unplug the wire from the PCG PCB's filter output to PA6, with its ground wire if there is one, or else the piezo from its PCB, and unplug the ECG lead cable from the module or unclip the leads. Keep USB and the Atmel-ICE connected, then say go. If there is no such connector, say so. Reconnect after the flash, ground before signal, and say go for S9.
- **Keep the PC awake during a recording.** Sleep would drop both ports. If it is a laptop, run it on a charged battery with the charger unplugged, because the body is connected to the PC through USB. **Open, 2026-11-06:** this PC is a mains-powered desktop, so that advice never applied, and no project document says whether the ECG module is isolated from USB. The user was told and decided the same day that isolation does not matter to them, so S11 item 3 and S12 go ahead on this PC. Keep the tab in view: drawing stops in a hidden tab, and recording does not.
- **Always use Stop.** A killed or crashed tab loses about the last 1.6 s 🔶 and leaves the module streaming until the next Start.
- **Your recordings are health data.** Keep them outside the repo, in a folder you make in the Start dialog. Chrome may refuse `~/Documents` itself, so make a subfolder. Delete any `.crswap` file a crash leaves.
- **No wire between the ECG side and the STM32.** Both are on the body through their own sensors, and this plan adds no link between them.
- **You should know, no action needed:**
  - After the flash, the PC never receives 48 kHz PCG again. Above 200 Hz, the 1000 Hz signal is only filter skirt and alias.
  - Same rate does not mean paired. Sample `j` of ECG and of PCG are not simultaneous, by about 31 ms per minute (S10) and not at a constant rate, until you correct them.
  - Stored 1000 Hz lead II inherits the forward-only filter: T and ST distorted, QRS about 10 ms late. The raw counts are there for anything finer.
- **Your ears:** done on 2026-11-06 on the recorder page, see S16.
- **Answered 2026-11-04:** the 3 V limit on the PCG PCB's output: a voltage divider on the PCB limits it to 3 V by design (Decisions, "PCG front end"). This does not change S11 item 1: the PCB stays live when the board has no power, so do not unplug the board's USB-C with the PCB connected to PA6.
- **Answered 2026-11-04:** the `index.html` Connect fix: yes. It went in with S3, and S9 item 4 checks it.
