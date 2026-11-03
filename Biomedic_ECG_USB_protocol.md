# Biomedic ECG: USB Communication Protocol and Signal Filtering

Reverse-engineered from the Windows software on the installation CD. Analysis dates: 2026-10-30 (USB protocol), 2026-11-02 (filtering, §12).

**Scope:** how the PC software (`BiomedicECG.exe`) talks to the **USB model** of the Biomedic ECG acquisition module, and how it then filters the signal. The Bluetooth model uses the same frames over a Bluetooth serial port and isn't covered here.

**How this was obtained:** static analysis only. The installer was unpacked and the program was disassembled; nothing was run, and no real device was connected. Every statement is marked as one of:

- ✅ **Confirmed:** read directly from the program's code or files.
- 🔶 **Inferred:** strongly suggested by the evidence but not proven.

---

## 1. Summary

- ✅ The module appears on the PC as a **virtual serial (COM) port**. The program contains no USB code at all; it only opens the COM port and reads and writes bytes.
- ✅ The USB side is handled by a **Microchip MCP2200** USB-to-serial bridge chip (USB vendor ID `0x04D8`, product ID `0x00DF`).
- ✅ The link runs at **230400 baud, 8N1, no flow control**.
- ✅ The PC sends three one-byte commands: `0x01` (start), `0x09` (keep-alive), `0x02` (stop).
- ✅ The module sends one **40-byte frame per sample at 500 samples/s** (20,000 bytes/s). Each frame holds 12 measured channels as signed 16-bit big-endian values, electrode-off flags and a battery byte.
- ✅ The module measures I, II, III, V1–V6 (plus 3 auxiliary channels). The software calculates aVR, aVL and aVF.
- ✅ All filtering is done on the PC (§12): trend removal and a 0.25 Hz high-pass are always on; a 50 Hz notch, a 40 Hz low-pass and a 0.75 Hz baseline filter are switched on by buttons.

---

## 2. Source files

| File | Notes | SHA-256 |
|---|---|---|
| `Data/Docs/BiomedicECG-Setup.exe` | Inno Setup 5.5.7 installer | `1d090a059232023537683e410dd0e48722134cc7013cc4cd2a9fe500d6c80c79` |
| `app/BiomedicECG.exe` (inside the installer) | Main program: Qt 5, 32-bit, dated 2018-07-01 | `5f5feca4a8acacfa8ccc81eb4d4343286465bcd3b3f4e5e2916bb3f3c0a1e079` |
| `app/ecg500.dat` (inside the installer) | Demo recording | `fd19fb2b7eec1121a817b521e73632117a67502332a3d00aceea1848ef5de90a` |
| `mchpcdc.inf` (CD root and inside the installer) | Microchip USB serial driver INF (2014) | `886d77633c3624641585041dc541a52cbffc6b7bf30d82aac03703672193052c` |

Supporting evidence:

- The installer's `tmp/drivers/readme.txt` is titled **"Microchip MCP2200 USB Bridge"**.
- `Manual.pdf` (v1.0, July 2016) lists 12 leads, 500 Hz sampling, 0.05–120 Hz bandwidth and 5 V USB power. It also says "8-bit resolution", but the data stream is 16-bit (see §8).
- The other files on the CD (`autorun.exe`, `autorun.cdd`, `lua5.1.dll`, `lua51.dll`, `Data/dat01/*`) belong to the CD menu and have nothing to do with the device.

---

## 3. Hardware and USB layer

```
ECG front-end chips ─SPI─▶ microcontroller ─UART 230400─▶ MCP2200 ══USB══▶ PC driver ─▶ COMx / ttyACMx ─▶ BiomedicECG.exe
```

- ✅ **MCP2200:** a USB 2.0 full-speed to UART bridge. It enumerates as a **composite device**: a standard USB serial (CDC-ACM) function on interfaces 0–1 and a HID interface used to configure the chip. The ECG software uses **only the serial function**.
- ✅ **Windows driver:** `mchpcdc.inf` binds Windows' built-in `usbser.sys` to `USB\VID_04D8&PID_00DF&MI_00`. The port then appears in Device Manager as "USB Serial Port (COMx)".
- 🔶 **Baud rate is real:** because the MCP2200 is a genuine USB-to-UART bridge, the baud rate the PC sets is passed to the chip and applied to its UART. It must match the module's microcontroller (230400).
- 🔶 **Microcontroller:** there must be one between the ECG chips and the MCP2200, but it isn't visible from the software.
- 🔶 **ECG front end:** probably three **Texas Instruments ADS1194** chips (4 channels, 16-bit) or a close ADS119x/ADS129x relative. The `0xC0` byte and the electrode-off bit layout in each block (see §8) match the status word these chips output, and each block carries exactly 4 channels.

---

## 4. How the software finds the device

✅ Run when acquisition starts:

1. List all serial ports (Qt `QSerialPortInfo::availablePorts()`).
2. **Pass 1, by name:** take each port's description, convert it to upper case and replace `_` with a space. If it starts with `BIOMEDIC ECG` (or `BIOMEDIC ERGO`, a sister product), use that port.
3. **Pass 2, by USB IDs** (only if pass 1 found nothing): use the first port with vendor ID `0x04D8` and product ID `0x00DF`.
4. If neither pass finds a port, stop with the error **"Device not found"**.

🔶 The MCP2200 lets the manufacturer set the USB product name, so the units were probably programmed as "BIOMEDIC ECG". However, Qt on Windows takes the description from the driver's INF ("USB Serial Port"), so in practice **pass 2 (USB IDs) is probably what finds the device.**

---

## 5. Serial port settings

✅ From the program's port-opening code:

| Setting | Value |
|---|---|
| Port path | `\\.\COMx` |
| Baud rate | **230400** |
| Data / parity / stop | **8 / none / 1** |
| Flow control | CTS and DSR handshaking off; XON/XOFF and abort-on-error aren't set by the program and stay as the driver had them (`0x496F78`) |
| DTR / RTS | both **disabled** |
| Driver buffers | 32 KB in, 32 KB out |
| Read timeout | 10,000 ms total per read call |
| Write timeout | 3,000 ms total per write call |
| After opening | both RX and TX buffers cleared |

Data is read **one byte at a time**. A failed read or a read that returns nothing (10 s timeout) ends the acquisition with the error **"Device read error"**.

---

## 6. Commands (PC → module)

✅ Every command is a single byte. The names describe how the program uses each byte; 🔶 the module's internal meaning is inferred.

| Byte | Name | When the program sends it |
|---|---|---|
| `0x01` | Start | Twice at session start, 100 ms apart, clearing the buffers before each |
| `0x09` | Keep-alive | Once right after start, then twice (5 ms apart) every 30,000 frames (60 s) |
| `0x02` | Stop | Twice, 100 ms apart, only when the user stops |
| `0x0B` | Identify | **Not used over USB.** Only the Bluetooth "Detect" button sends it; the module replies with 7 bytes. |

No other bytes are ever sent to the module. 🔶 The gain setting (`Config/SignalGain`) doesn't seem to be sent to the device, so it's probably applied in software only.

---

## 7. Session sequence

✅

```
PC                                         Module
│  open COMx (230400 8N1), clear buffers
│  clear buffers ── 0x01 ─────────────────▶
│  wait 100 ms
│  clear buffers ── 0x01 ─────────────────▶
│  ── 0x09 ───────────────────────────────▶
│  ◀──────────── 40-byte frame ── (500 per second, continuously)
│  ...                                      after every 30,000 frames (60 s):
│  ── 0x09 ── wait 5 ms ── 0x09 ──────────▶
│  ...                                      user presses stop:
│  ── 0x02 ── wait 100 ms ── 0x02 ────────▶
│  close port
```

✅ After a read error or the 10 s timeout, the program closes the port without the stop (`0x495227`), so the module can keep streaming until the next start.

🔶 Whether the module actually stops streaming without the keep-alive hasn't been tested.

---

## 8. Data frame (module → PC)

✅ Fixed length: **40 bytes**, 500 frames per second. Data rate: 20,000 bytes/s, which is 87% of the maximum at 230400 baud (23,040 bytes/s).

All signal values are **signed 16-bit, big-endian** (high byte first).

| Offset | Size | Content |
|---:|---:|---|
| 0 | 1 | `0x01`: block 1 marker |
| 1 | 1 | `0xC0`: fixed |
| 2 | 1 | Status A1 (electrode-off flags) |
| 3 | 1 | Status B1 (electrode-off flags) |
| 4 | 2 | **V5** |
| 6 | 2 | **I** |
| 8 | 2 | **II** |
| 10 | 2 | **III** |
| 12 | 1 | `0x02`: block 2 marker |
| 13 | 1 | `0xC0`: fixed |
| 14 | 1 | Status A2 |
| 15 | 1 | Status B2 |
| 16 | 2 | **V1** |
| 18 | 2 | **V2** |
| 20 | 2 | **V3** |
| 22 | 2 | **V4** |
| 24 | 1 | `0x03`: block 3 marker |
| 25 | 1 | `0xC0`: fixed |
| 26 | 1 | Status A3 |
| 27 | 1 | Status B3 |
| 28 | 2 | **V6** |
| 30 | 2 | AUX1 |
| 32 | 2 | AUX2 |
| 34 | 2 | AUX3 |
| 36 | 1 | **Battery**: value × 0.013 = volts |
| 37 | 3 | Not used by the program |

🔶 Each 12-byte block looks like a marker byte followed by the raw output of one 4-channel ECG chip: a 3-byte status word (`0xC0`, A, B) and four 16-bit samples.

### 8.1 Synchronisation

✅ The program checks the markers in order (`0x01`, `0xC0`, `0x02`, `0xC0`, `0x03`, `0xC0`). If any marker is wrong, it discards the partial frame and resumes hunting for `0x01` from the next byte.

### 8.2 Calculated leads

✅ The program computes the augmented leads from I, II and III. Each division by 2 truncates toward zero, and the results are clamped to the 16-bit range:

```
aVR = −(I + II) / 2
aVL =  (I − III) / 2
aVF =  (II + III) / 2
```

### 8.3 Electrode-off flags

✅ A set bit means the electrode is disconnected:

| Electrode | Byte (offset) | Bits |
|---|---|---|
| RA | B1 (3) | bit 5 or bit 6 (`& 0x60`) |
| LA | A1 (2) | bit 5 (`& 0x20`) |
| LL | A1 (2) | bit 6 or bit 7 (`& 0xC0`) |
| V1 | A2 (14) | bit 4 (`& 0x10`) |
| V2 | A2 (14) | bit 5 (`& 0x20`) |
| V3 | A2 (14) | bit 6 (`& 0x40`) |
| V4 | A2 (14) | bit 7 (`& 0x80`) |
| V5 | A1 (2) | bit 4 (`& 0x10`) |
| V6 | A3 (26) | bit 4 (`& 0x10`) |

The right-leg (RL) electrode has no flag. 🔶 It's probably the driven reference.

✅ When an electrode is off, the program sets the affected leads to 0 before displaying or recording them:

| Electrode off | Leads set to 0 |
|---|---|
| RA | I, II, aVR, aVL, aVF |
| LA | I, III, aVR, aVL, aVF |
| LL | II, III, aVR, aVL, aVF |
| Vn | Vn |

### 8.4 Other processing

- ✅ **Saturation counters:** for each of the first 14 channels, the program counts consecutive samples outside ±32,000 and resets the count when the value is back in range. 🔶 This is probably used to detect saturated or disconnected channels.
- ✅ **Output order inside the program:** `I, II, III, aVR, aVL, aVF, V1, V2, V3, V4, V5, V6, AUX1, AUX2`, 14 channels. A 14-bit mask selects which channels are passed on to the display and recording. AUX3 is decoded but never used.

---

## 9. Demo file format (`ecg500.dat`)

✅ Used by the "Replay ECG file (demo)" mode. It has the same layout as the program's internal stream, not the raw USB frame:

- No header.
- 14 × signed 16-bit **little-endian** values per sample (28 bytes), in the order of §8.4.
- 500 samples/s; 131,699 samples ≈ **263.4 s**.
- Checked: in all 131,699 samples, aVR, aVL and aVF match the formulas in §8.2 exactly.

```python
import numpy as np
ecg = np.fromfile("ecg500.dat", dtype="<i2").reshape(-1, 14)   # shape (131699, 14)
```

---

## 10. Using the device from Linux

🔶 Not tested with real hardware:

- Linux's built-in `cdc_acm` driver handles the MCP2200's serial function, so the module should appear as **`/dev/ttyACM0`** with no driver install. Check with `lsusb` for `04d8:00df` and `dmesg | grep ttyACM`.
- Your user needs to be in the `dialout` group to open the port (`sudo usermod -aG dialout $USER`, then log out and back in).
- Set the baud rate to **230400**. The MCP2200 applies it to its UART (§3).
- **ModemManager** may probe new `ttyACM` devices by sending modem commands to them. If the device behaves oddly right after plugging in, stop ModemManager or add a udev rule with `ENV{ID_MM_DEVICE_IGNORE}="1"` for `04d8:00df`.
- The MCP2200 also shows up as a `/dev/hidraw*` device. That's its configuration interface and isn't needed.

---

## 11. Reference implementation (Python, pyserial)

🔶 This mirrors the Windows program's behaviour. The parsing was checked against synthetic frames only, **not against a real device**.

```python
import struct
import time

import serial  # pip install pyserial

FRAME_LEN = 40
LEADS = ["I", "II", "III", "aVR", "aVL", "aVF",
         "V1", "V2", "V3", "V4", "V5", "V6", "AUX1", "AUX2", "AUX3"]


def frames(port):
    """Yield valid 40-byte frames, re-synchronising on bad markers."""
    buf = bytearray()
    while True:
        chunk = port.read(port.in_waiting or 1)
        if not chunk:
            raise TimeoutError("Device read error (no data)")
        buf += chunk
        while len(buf) >= FRAME_LEN:
            if (buf[0], buf[1], buf[12], buf[13], buf[24], buf[25]) == (0x01, 0xC0, 0x02, 0xC0, 0x03, 0xC0):
                yield bytes(buf[:FRAME_LEN])
                del buf[:FRAME_LEN]
            else:
                del buf[0]


def decode(f):
    """Return (leads dict, electrodes-off dict, battery volts) for one frame."""
    s = lambda off: struct.unpack_from(">h", f, off)[0]
    half = lambda x: int(x / 2)  # truncate toward zero, like the C++ code
    I, II, III = s(6), s(8), s(10)
    leads = {
        "I": I, "II": II, "III": III,
        "aVR": -half(I + II), "aVL": half(I - III), "aVF": half(II + III),
        "V1": s(16), "V2": s(18), "V3": s(20), "V4": s(22), "V5": s(4), "V6": s(28),
        "AUX1": s(30), "AUX2": s(32), "AUX3": s(34),
    }
    off = {
        "RA": bool(f[3] & 0x60), "LA": bool(f[2] & 0x20), "LL": bool(f[2] & 0xC0),
        "V1": bool(f[14] & 0x10), "V2": bool(f[14] & 0x20),
        "V3": bool(f[14] & 0x40), "V4": bool(f[14] & 0x80),
        "V5": bool(f[2] & 0x10), "V6": bool(f[26] & 0x10),
    }
    return leads, off, f[36] * 0.013


def acquire(device="/dev/ttyACM0", seconds=10):
    port = serial.Serial()
    port.port, port.baudrate, port.timeout = device, 230400, 10
    port.inter_byte_timeout = 0.05  # without it pyserial leaves the tty at VMIN 0 and Chrome Web Serial then fails with "The device has been lost"; the other fix is stty -F /dev/ttyACM0 min 1 time 0
    port.dtr = port.rts = False  # the Windows program disables both
    port.open()
    try:
        port.reset_input_buffer(); port.write(b"\x01")    # start
        time.sleep(0.1)
        port.reset_input_buffer(); port.write(b"\x01")    # start (repeated)
        port.write(b"\x09")                               # keep-alive
        for n, f in enumerate(frames(port), 1):
            leads, off, battery = decode(f)
            if n % 500 == 0:
                print(f"{n / 500:5.0f}s  II={leads['II']:6d}  off={[k for k, v in off.items() if v]}  bat={battery:.2f}V")
            if n % 30000 == 0:                            # every 60 s
                port.write(b"\x09"); time.sleep(0.005); port.write(b"\x09")
            if n >= seconds * 500:
                break
    finally:
        port.write(b"\x02"); time.sleep(0.1); port.write(b"\x02")  # stop
        port.close()


if __name__ == "__main__":
    acquire()
```

---

## 12. Signal filtering (PC software)

✅ The module sends unfiltered samples; all filtering happens in `BiomedicECG.exe`. Every filter below was rebuilt from the coefficients stored in the program, and its response was computed with SciPy. The cutoffs are therefore measured from the coefficients, not taken from labels.

### 12.1 Resting-ECG filter chain

✅ Used by the live monitor (`EcgMonitorWindow`), the review screen (`EcgReviewWindow`) and the printed report. The chain is built over a record of known length (the trend's first and last 3 s are set at build time, `0x466C43`, `0x46FE70`), processed in 4096-sample blocks (`0x447034`, `0x461C46`), and rebuilt by the monitor's filter buttons (`0x43CE90`–`0x43CEC1`). 🔶 How the monitor filters while it's still acquiring wasn't traced. Stages run in this order (values for 500 Hz, the device's rate):

| # | Stage | When it runs | What it is | Actual response |
|---|---|---|---|---|
| 0 | Trend removal | Always | Per channel: subtracts a straight line from the mean of the first 3 s to the mean of the last 3 s of the record | Removes offset and slow drift |
| 1 | Permanent high-pass | Always | 2nd-order Butterworth, 0.25 Hz | −3 dB at **0.31 Hz** |
| 2 | **NF** (line notch) | Button | 4th-order IIR with notches at **50 Hz and 100 Hz** | ≈ −70 dB at 50 Hz; −3 dB band 46.9–53.2 Hz |
| 3 | **MF** (muscle noise) | Button | FIR low-pass: **40 Hz** (12 taps, default) or 25 Hz (19 taps) | 40 Hz version: −3 dB at 39.5 Hz, only −5 dB at 50 Hz. 25 Hz version: −3 dB at 24.7 Hz |
| 4 | **HF** (baseline) | Button | 4th-order Butterworth high-pass, 0.75 Hz | −3 dB at **0.84 Hz** |

How the stages are applied:

- ✅ **Standard designs:** stages 1 and 4 match SciPy `butter(2, 0.25, 'high', fs=500)` and `butter(4, 0.75, 'high', fs=500)` to at least 6 decimals. The notch is a custom design (zeros at ≈49.97 Hz and ≈99.99 Hz, pole radius 0.975).
- ✅ **Zero phase:** the IIR stages (1, 2, 4) run forward and then backward over the data, like SciPy `filtfilt`. This cancels their phase shift but squares their magnitude response; the cutoffs in the table already include that. The program implements them as `y[n] = Σ b[k]·x[n−k] − Σ a[k]·y[n−k]`.
- ✅ **Settling margin:** to avoid edge transients, each IIR stage also filters samples borrowed from the neighbouring data blocks: 2000 samples (4 s) for stage 1, 500 (1 s) for the notch, 3000 (6 s) for the baseline filter.
- ✅ **FIR stage:** single pass, symmetric taps, re-centred by taps/2, so there is no time shift (the even-length 12-tap filter is off by half a sample, 1 ms).
- ✅ **16-bit output:** the output of the IIR and FIR stages is truncated and clamped to 16 bits (`0x472C7F`–`0x472CB7` for the IIR stages).
- ✅ **Defaults:** notch `50hz`, low-pass `40hz`. A notch setting other than `50hz` (e.g. `60hz`) throws the error *"pendiente - filtro no definido"* ("pending – filter not defined"): **the 60 Hz notch is not implemented** in this chain. 🔶 No interface text that changes either default was found, so 25 Hz and 60 Hz are probably unreachable from the interface.
- 🔶 **Filters are re-applied, not stored:** the study file saves only three on/off flags under `ecgFilters` (`notch 50hz`, `muscle noise`, `baseline fix`). The stored signal is therefore probably unfiltered, with the filters re-applied whenever it's displayed or printed.

### 12.2 Coefficients (500 Hz)

IIR stages, standard form `a[0] = 1`. In the program the feedback terms are stored with the opposite sign, and `a[0]` is ignored.

```python
# Stage 1: permanent high-pass, Butterworth order 2, 0.25 Hz
b1 = [0.997781024102941, -1.99556204820588, 0.997781024102941]
a1 = [1, -1.99555712434579, 0.995566972065975]

# Stage 2: NF notch, 50 Hz + 100 Hz
b2 = [0.951558090821252, -2.1284207536999, 2.85527558178394, -2.1284207536999, 0.951558090821252]
a2 = [1, -2.18192506761969, 2.85407296314357, -2.07491643978012, 0.904318800282871]

# Stage 4: HF baseline, Butterworth order 4, 0.75 Hz
b4 = [0.987761389276826, -3.9510455571073, 5.92656833566095, -3.9510455571073, 0.987761389276826]
a4 = [1, -3.97537191256092, 5.92641855596542, -3.92671919775679, 0.975672562146085]

# Stage 3: MF low-pass FIR, "40hz" (12 taps, default)
h40 = [-0.00812031626499363, 0.00279430037155961, 0.0363062486230826, 0.0960723789024121,
       0.163761187856556, 0.209186200511384, 0.209186200511384, 0.163761187856556,
       0.0960723789024121, 0.0363062486230826, 0.00279430037155961, -0.00812031626499363]

# Stage 3: MF low-pass FIR, "25hz" (19 taps)
h25 = [-0.00689843760973636, -0.00246292660156455, 0.00342437007210368, 0.0159428667892704,
       0.0354180533171441, 0.060307062743425, 0.0871989329020898, 0.111461378354002,
       0.128381833793646, 0.134453732479239, 0.128381833793646, 0.111461378354002,
       0.0871989329020898, 0.060307062743425, 0.0354180533171441, 0.0159428667892704,
       0.00342437007210368, -0.00246292660156455, -0.00689843760973636]
```

🔶 Approximate offline equivalent with SciPy, for an `ecg` array of shape `(samples, channels)` at 500 Hz. It ignores the block-boundary handling and the 16-bit rounding between stages. It also differs at the edges: it pads with `filtfilt`'s odd extension and uses `mode="nearest"` for the FIR, while the program starts each pass from zero state, reads zeros beyond the data, and starts the backward pass `margin` samples after the end (`0x472838`, `0x472E5D`):

```python
import numpy as np
from scipy import ndimage, signal

def biomedic_filter(ecg, nf=False, mf=False, hf=False, fs=500):
    x = ecg.astype(float)
    n, t = int(3 * fs + 0.5), np.arange(len(x))[:, None]
    m0, m1 = x[:n].mean(axis=0), x[-n:].mean(axis=0)
    x -= m0 + (m1 - m0) * (t - n // 2) / (len(x) - n)          # stage 0: line through the 3 s end means
    x = signal.filtfilt(b1, a1, x, axis=0)                     # stage 1 (always)
    if nf: x = signal.filtfilt(b2, a2, x, axis=0)              # stage 2: 50 + 100 Hz notch
    if mf: x = ndimage.convolve1d(x, h40, axis=0, mode="nearest")  # stage 3: centred FIR
    if hf: x = signal.filtfilt(b4, a4, x, axis=0)              # stage 4: 0.75 Hz baseline
    return x
```

### 12.3 Observations

- **Low-frequency cutoff:** the manual says 0.05–120 Hz, but the always-on stage 1 makes the effective lower limit **0.31 Hz** (0.84 Hz with the baseline filter on).
- **Baseline filter vs. guidelines:** 0.84 Hz is above the 0.67 Hz commonly cited from the AHA 2007 recommendations as the maximum for zero-phase baseline filters, so it can affect ST segments.
- **The 40 Hz muscle filter is gentle:** it reduces 50 Hz by only about 5 dB, so mains interference really depends on the notch.
- **Other sampling rates:** the program also has tables for 250 and 1000 Hz, which this device doesn't use. At 250 Hz the notch is silently skipped. At 1000 Hz the baseline filter has a pole exactly on the unit circle, cancelled by a zero, so it is numerically fragile.

### 12.4 Second chain (stress test only)

✅ The stress-test analysis code (ST trends per stage) uses a separate chain built only from long FIR filters (500 Hz values):

- an always-on 1501-tap high-pass (−3 dB at 0.42 Hz);
- 195-tap notches, which **do** include 60 Hz (−60 dB at 50 or 60 Hz; −3 dB band ±3 Hz);
- a 501-tap baseline filter (−3 dB at 1.3 Hz), or an FFT option that processes 1024-sample blocks and zeroes the lowest frequency bins.

It doesn't affect resting ECGs. 🔶 Only the 500 Hz tables were checked in detail; two of the 250/1000 Hz baseline tables don't come out clean (one isn't symmetric, the other doesn't sum to zero), so their exact lengths may be slightly off.

---

## 13. Open questions

1. **Amplitude scale:** how many µV one count represents. The program's display code would answer it; alternatively, record a known calibration signal.
2. **Bytes 37–39** of the frame: never read by the program.
3. **AUX1–AUX3:** what the three extra channels of the third chip carry (possibly unused inputs or a pacemaker-detection channel). The program has a pacemaker callback, but where its data comes from wasn't traced.
4. **Whether the keep-alive is required:** does the module stop after ~60 s without `0x09`?
5. **Exact firmware meaning** of `0x01`, `0x09` and `0x02`. For example, `0x01` could be "reset" and `0x09` "start streaming".
6. **Manual vs. code:** the manual's "8-bit resolution" contradicts the 16-bit samples.
7. **Filter settings:** whether any screen or configuration file can switch the notch to 60 Hz (which would trigger the "filtro no definido" error) or the low-pass to 25 Hz.
8. **Stored data:** confirm that study files contain the unfiltered signal (§12.1).

---

## Appendix A: Where to look in `BiomedicECG.exe`

32-bit PE, image base `0x00400000`. Addresses are virtual addresses in this exact build (SHA-256 in §2).

| Address | What it is |
|---|---|
| `0x491AF0` | Acquisition thread constructor: port discovery (§4), stores baud 230400 (`0x38400`) |
| `0x493D80` | Acquisition thread `run()`: start sequence, frame parser, lead calculation, electrode-off flags, keep-alive, stop |
| `0x496EF0` | Serial open: `CreateFileA`, `SetupComm`, `SetCommState`, `SetCommTimeouts`, `PurgeComm` |
| `0x497240` | `read(buf, n)` wrapper around `ReadFile` |
| `0x497270` | Clear buffers, then send `0x01` |
| `0x497210` | Send `0x09` |
| `0x4972C0` | Send `0x02` |
| `0x497140` | Send `0x0B`, read 7-byte reply (Bluetooth Detect only) |
| `0x492510` | Bluetooth probe (opens port at 230400, calls `0x497140`) |
| `0x5065F0` | Format string `\\.\%.8s` used for the port path |
| `0x518A38` / `0x518A48` | Strings `BIOMEDIC ECG` / `BIOMEDIC ERGO` |
| `0x518AC0` | `double 0.013` (battery scale) |
| `0x4E6D74`… | Electrode names `LL`, `LA`, `RA`, `V1`…`V6` |

Filtering (§12):

| Address | What it is |
|---|---|
| `0x4664E0` | Resting-ECG filter object constructor (defaults `50hz`, `40hz`) |
| `0x466BF0` | Builds the resting-ECG chain from the NF / MF / HF flags |
| `0x472440` | Trend-removal stage (curve through 3 points, subtracted per sample) |
| `0x472650` / `0x472760` | IIR filter constructor / processing (forward + backward passes) |
| `0x472CE0` / `0x472DA0` | FIR filter constructor / processing (centred, 16-bit output) |
| `0x470070` | Seconds → samples (`fs × s + 0.5`) |
| `0x506C60` | Error string `pendiente - filtro no definido` |
| `0x506CA0`–`0x506DF8` | IIR coefficients |
| `0x509B28`–`0x509FD0` | Low-pass FIR tables (250 / 500 / 1000 Hz) |
| `0x467890` | Stress-test FIR/FFT chain; tables `0x506FB8`–`0x509B28` and `0x509FD0`–`0x50E5C0`+1501 taps |

A second, nearly identical acquisition thread class (vtable `0x518AD0`, run loop around `0x495E20`) is the "HRProtocol" variant. It's chosen only when the setting `Config/HRProtocol` is true (default false, `0x40701F`, `0x407123`, `0x407253`). Its commands and timings are the same, but it opens at 570,000 baud (`0x4958FA`, `0x407150`), sends the keep-alive every 60,000 frames (`0x495F08`, `0x496D94`), and its blocks start with `C0` only, with no `01`/`02`/`03` markers (`0x495F56`).

The program also contains drivers for a treadmill (Kipnet; ASCII commands such as `;0GO00:`) and an ergometer, for the stress-test version. They aren't related to the ECG module.

## Appendix B: Reproducing the analysis

```bash
# Unpack the installer (innoextract, without a system install)
apt-get download innoextract && dpkg -x innoextract_*.deb ./innoextract
./innoextract/usr/bin/innoextract -d extracted Data/Docs/BiomedicECG-Setup.exe

# Disassemble (Intel syntax)
objdump -d -M intel --no-show-raw-insn extracted/app/BiomedicECG.exe > dis.txt
objdump -p extracted/app/BiomedicECG.exe > imports.txt
```

To make the disassembly readable, map the import table slots and string addresses to names. Then search for calls to `CreateFileA`, `ReadFile` and `WriteFile`, and for references to the strings listed in Appendix A.
