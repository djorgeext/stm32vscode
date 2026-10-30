# Biomedic ECG: USB Communication Protocol

Reverse-engineered from the Windows software on the installation CD. Analysis date: 2026-10-30.

**Scope:** how the PC software (`BiomedicECG.exe`) talks to the **USB model** of the Biomedic ECG acquisition module. The Bluetooth model uses the same frames over a Bluetooth serial port and isn't covered here.

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
| Flow control | none (CTS and DSR handshaking off) |
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
| `0x02` | Stop | Twice at session end, 100 ms apart |
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

## 12. Open questions

1. **Amplitude scale:** how many µV one count represents. The program's display code would answer it; alternatively, record a known calibration signal.
2. **Bytes 37–39** of the frame: never read by the program.
3. **AUX1–AUX3:** what the three extra channels of the third chip carry (possibly unused inputs or a pacemaker-detection channel). The program has a pacemaker callback, but where its data comes from wasn't traced.
4. **Whether the keep-alive is required:** does the module stop after ~60 s without `0x09`?
5. **Exact firmware meaning** of `0x01`, `0x09` and `0x02`. For example, `0x01` could be "reset" and `0x09` "start streaming".
6. **Manual vs. code:** the manual's "8-bit resolution" contradicts the 16-bit samples.

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

A second, nearly identical acquisition thread class (vtable `0x518AD0`, run loop around `0x495E20`) uses the same commands, frame layout and electrode mapping.

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
