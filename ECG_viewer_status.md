# ECG viewer: status on 2026-11-03

All steps E1–E7 of the "PLAN: ECG viewer (Biomedic ECG, leads I and II)" section in `PLAN.md` pass on the real module.

**What the page does:**
- Shows leads I and II live at 500 frames/s, with a separate auto-scale for each lead.
- Filters with the vendor's §12 resting-ECG chain, forward only, so there is no display delay:
  - 0.25 Hz high-pass;
  - 50 + 100 Hz notch;
  - 40 Hz FIR low-pass;
  - 0.75 Hz baseline filter.
- Shows electrode-off warnings for RA, LA and LL.
- Uses the vendor's command bytes for Connect and Disconnect, one byte per write, with the stop sent before every start.

**Files** (in `Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/`):
- `Web/ecg.html`
- `Web/ecg_dsp.js`
- `Tests/ecg_dsp_test.mjs` (`node Tests/ecg_dsp_test.mjs`)
- the README section "ECG viewer (Biomedic ECG module)"

**Serve** from the repo root:
`python3 -m http.server -b 127.0.0.1 -d Projects/WeAct_MiniH750/Applications/USB_Device/PCG_CDC/Web 8001`
Then open http://localhost:8001/ecg.html. Port 8000 is used by `strategy_app.py`.

## Rules

- **End sessions with Disconnect.** Click Disconnect before closing the tab. A closed tab leaves the module streaming; the next Connect recovers it, which was tested after 17.5 min.
- **Recovery if the module keeps streaming or ignores commands:** unplug it, plug it back in, then wait until `fuser /dev/ttyACM0` prints nothing.
- **After pyserial use:** the port must be at `min 1`. Fix it with `stty -F /dev/ttyACM0 min 1 time 0`.
- **ST segments:** the forward-only 0.75 Hz baseline filter shifts them. Use the trace for rhythm and QRS, not for ST analysis.

## Open

- Committed on 2026-11-03, with `Acquisition_systems_summary.md`.
- `Biomedic_ECG_USB_protocol.md` was corrected on 2026-11-03 (`PLAN.md` step D1): §5, §6, §7, §11 (`inter_byte_timeout` line), §12.1, §12.2 and Appendix A. Not committed yet.
- Reminder: the PCG page (`Web/index.html`) has the double-Connect bug. Fix it the same way as `ecg.html` the next time you work on PCG.
