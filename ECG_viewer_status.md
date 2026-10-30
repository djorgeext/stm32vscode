# ECG viewer: status on Friday 2026-10-30 and next steps for Monday

## Status

| Step | State |
|---|---|
| E1: real stream and sample rate | ✅ 500.12 frames/s; RATE stays 500 |
| E2: parser and filters, node test | ✅ 7/7 tests pass; replay of the real capture matches |
| E3: page `ecg.html` and README | ⏳ items 1–5 and 7 pass; **item 6 open**: the module must stop after Disconnect |

**What works live:**
- Lead I at 500 frames/s, filtered with a 50 Hz notch and a 0.5–150 Hz band-pass.
- Clean QRS complexes about 7 s after Connect.
- The LA-off warning.
- More than 3 minutes of streaming, keep-alives included.

The amplitude is in counts, because the µV per count is unknown.

Files (all in `Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/`):
- `Web/ecg.html`
- `Web/ecg_dsp.js`
- `Tests/ecg_dsp_test.mjs`
- the README section "ECG viewer (Biomedic ECG module)"

The plan is the "PLAN: ECG viewer" section at the end of `PLAN.md`.

## Bugs found and fixed today

1. **Double Connect:** a second click while the port was opening gave "port is already open". Connect is now disabled while the port opens.
2. **"The device has been lost." on Connect:** pyserial had left `/dev/ttyACM0` at `min 0`, and Chrome treats a 0-byte read as an unplug.
   - Fix: the plan's pyserial commands now set `inter_byte_timeout = 0.05`.
   - The README has a recovery line: `stty -F /dev/ttyACM0 min 1 time 0`, or replug the module.
3. **Last stop byte dropped:** `port.close()` threw away the second `0x02`. Disconnect now drains the output (`writable.close()`) before closing the port.

## Open problem: the module stopped obeying commands

- By the end of the session, the module ignored **every** command, start and stop, from both Chrome and pyserial. It kept streaming.
- In E1 it had obeyed both, so the page's stop (fix 3 above) has never been tested from a clean state.
- Suspected trigger: start sequences sent while the module was already streaming, during the earlier failed sessions. This is unproven.
- The module was unplugged at the end of the session to reset it.

## Monday, in order (revised E3 in `PLAN.md`, run through the agents)

Serve the page from the repo root first:
`python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8000`

**Item 6: the page's stop from a clean state** (page unchanged)
1. Plug in the module. The tester waits until `fuser /dev/ttyACM0` prints nothing, then listens. Expect under 1000 B in 2 s (idle) and `stty` showing `min = 1; time = 0`.
2. You: open http://localhost:8000/ecg.html and click Connect. Expect about 500 frames/s, then the slow swing. Note the bytes-skipped count after 10 s, then click Disconnect.
3. The tester listens. Expect under 1000 B.
   - If it shows about 40 000 B: replug, then the tester runs the E1 capture and listens again.

**Only if item 6 passes: the planner's change**
4. Executioner: Connect sends the stop before the start: `02`, 100 ms, `02`, 100 ms, `01`, 100 ms, `01 09`. A tab closed without Disconnect then can't leave the next start hitting a module that is still streaming. The executioner also adds a README recovery line.
5. Tester: static checks.

**Item 7: the stop-before-start change**
6. You: hard-reload (Ctrl+Shift+R), Connect, then Disconnect. The tester listens: under 1000 B.
7. You: Connect, then close the tab **without** Disconnect. The tester listens: about 40 000 B, still streaming, as intended.
8. You: wait 1 minute, open a new tab, Connect, then Disconnect. The tester listens: under 1000 B.
   - If 6 shows 0 frames/s, the plan raises the stop-to-start gap to 1000 ms.

Steps 7–8 deliberately leave the module streaming, and may cost one more replug.

## Rules until this is solved

- Always click **Disconnect** before closing the tab.
- If the module keeps streaming after Disconnect, or ignores commands, unplug it and plug it back in.
- After any pyserial use on the module, the port must be at `min 1`. Check with `stty -F /dev/ttyACM0 -a`.

## Waiting for your decision

- Commit the ECG files and `Biomedic_ECG_USB_protocol.md`? Nothing is committed yet.
- Add the `inter_byte_timeout` line to the Python example in §11 of the protocol document?

## Reminder

The PCG page (`Web/index.html`) has the same double-Connect bug. Fix it the same way the next time you work on PCG.
