# STM32 LED Blink Quick Guide

Oct 29, 2026 · @what version of claude are you?

## How it works

Blinking an LED on any STM32 with your Atmel-ICE takes the same seven steps every time. The probe, the wiring and the OpenOCD commands never change. Only a few facts about the chip and board change, and you collect those in step 1.

1. Know your chip and board: part number, LED pin, crystal.
2. Wire the Atmel-ICE and check that it can see the chip.
3. Generate a project for your exact part number.
4. Add the blink code and check the settings that must match your board.
5. Build.
6. Back up the factory firmware, then flash.
7. Check that it runs.

This guide comes from a setup that works: a WeAct MiniSTM32H7xx board (STM32H750VBT6), the Atmel-ICE, OpenOCD 0.12, Ubuntu Linux and VS Code with the STM32Cube extension. That board is the worked example in every step.

## What you need

You install the software once. After that, every new STM32 project only needs a board and five wires.

| Item | What it is for | Notes |
| --- | --- | --- |
| STM32 board | The chip you program | Find its schematic before you start (step 1) |
| Atmel-ICE | Programs and debugs the chip over SWD | It is a standard CMSIS-DAP probe and needs no hacks. Use its **SAM** port, not the AVR port. It does **not** power the board. |
| 10-pin squid cable (or jumper wires) | Connects the Atmel-ICE to the board's SWD pins | Comes with the Atmel-ICE full kit |
| USB cable for the board | Powers the board | The Atmel-ICE only senses the voltage; the board needs its own power |
| `gcc-arm-none-eabi` | Compiler for ARM Cortex-M | Ubuntu package |
| `openocd` | Talks to the Atmel-ICE: flashes, reads memory, debugs | Ubuntu package. It also installs the USB permission rule, so no `sudo` is needed |
| `cmake` + `ninja-build` | Build system | Ubuntu packages |
| STM32CubeMX | Generates a ready project for any STM32 part number | Free download from st.com |
| VS Code + STM32Cube extension | Editor, build buttons | Optional; everything also works from a terminal |

Install the Linux tools in one go:

```bash
sudo apt install gcc-arm-none-eabi libnewlib-arm-none-eabi openocd cmake ninja-build
```

## Step 1: Know your chip and board

Collect five facts before writing any code; every later setting comes from them. Most of them come from the part number printed on the chip, the rest from the board's schematic or the vendor's example code.

| Fact | Where to find it | WeAct H750 example |
| --- | --- | --- |
| Part number | Printed on the chip, or in the board's description | STM32H750VBT6 |
| Family | The letters after "STM32" | H7, so the OpenOCD file is `stm32h7x.cfg` (step 2) |
| Flash size | One letter in the part number (table below) | B = 128 KB, starting at `0x08000000` |
| LED pin | Board schematic, or the vendor's blink example | PE3 ([WeAct example](https://github.com/WeActStudio/MiniSTM32H7xx/tree/master/SDK/HAL/STM32H750/01-GPIO)) |
| Crystal (HSE) frequency | Schematic: the value written next to the crystal | 25 MHz |

The SWD pins are the same on almost every STM32: **PA13 = SWDIO** and **PA14 = SWCLK**.

### How to read a part number

Each letter of `STM32 H 750 V B T 6` means something.

| Part | In the example | Meaning |
| --- | --- | --- |
| Family | H | F and G = mainstream, H = high performance, L and U = low power, WB and WL = wireless |
| Line | 750 | The exact product line inside the family |
| Pin count | V | K = 32, C = 48, R = 64, V = 100, Z = 144, I = 176 pins |
| Flash size | B | 6 = 32 KB, 8 = 64 KB, B = 128 KB, C = 256 KB, E = 512 KB, G = 1 MB, I = 2 MB |
| Package | T | T = LQFP, U = QFN, H = BGA, Y = WLCSP |
| Temperature | 6 | 6 = −40 to 85 °C, 7 = −40 to 105 °C |

### Popular boards

These values are from memory, so confirm them on your board's schematic. The LED's polarity does not matter for blinking, because toggling works either way.

| Board | Chip | LED pin | LED lights when the pin is | Crystal |
| --- | --- | --- | --- | --- |
| WeAct MiniSTM32H7xx | STM32H750VBT6 | PE3 | not checked | 25 MHz |
| WeAct "Black Pill" | STM32F401CCU6 or STM32F411CEU6 | PC13 | LOW | 25 MHz |
| "Blue Pill" | STM32F103C8T6 | PC13 | LOW | 8 MHz |

## Step 2: Wire the Atmel-ICE and check it sees the chip

Connect four wires from the Atmel-ICE **SAM** port to the board, then power the board through its own USB. If one OpenOCD command then prints "processor detected", the wiring is right and every later step will work.

| Atmel-ICE SAM pin | Signal | Board pin |
| --- | --- | --- |
| 1 | VTref (senses the board voltage) | 3V3 |
| 2 | SWDIO | SWDIO / PA13 (often labelled DIO) |
| 3 | GND | GND |
| 4 | SWCLK | SWCLK / PA14 (often labelled CLK) |
| 10 | nRESET (optional) | NRST, only if the board has it on a pin |

- Pin 1 must be connected. The Atmel-ICE will not talk to the chip until it sees the board's voltage there.
- Never connect 5V to pin 1. Use the board's 3V3 pin.
- Pin 10 is optional. It lets you rescue a chip whose program has switched off the SWD pins (see Troubleshooting).

### The OpenOCD config file

Put a file named `openocd.cfg` in the project folder, next to `CMakeLists.txt`. Only the last line changes between chips.

```
# Atmel-ICE (CMSIS-DAP) over SWD
adapter driver cmsis-dap
cmsis_dap_vid_pid 0x03eb 0x2141
transport select swd

# Change this line for your chip family
source [find target/stm32h7x.cfg]
```

| Family | Target file |
| --- | --- |
| F0 | `stm32f0x.cfg` |
| F1 | `stm32f1x.cfg` |
| F2 | `stm32f2x.cfg` |
| F3 | `stm32f3x.cfg` |
| F4 | `stm32f4x.cfg` |
| F7 | `stm32f7x.cfg` |
| G0 | `stm32g0x.cfg` |
| G4 | `stm32g4x.cfg` |
| H7 | `stm32h7x.cfg` |
| L0 | `stm32l0.cfg` |
| L1 | `stm32l1.cfg` |
| L4 | `stm32l4x.cfg` |
| L5 | `stm32l5x.cfg` |
| U5 | `stm32u5x.cfg` |
| WB | `stm32wbx.cfg` |
| WL | `stm32wlx.cfg` |

This list comes from OpenOCD 0.12 on Ubuntu. To see the full list on your machine, run `ls /usr/share/openocd/scripts/target/ | grep stm32`.

### Check the connection

```bash
openocd -f openocd.cfg -c "init" -c "exit"
```

Success looks like this. The number and the core type depend on the chip.

```
Info : SWD DPIDR 0x6ba02477
Info : [stm32h7x.cpu0] Cortex-M7 r1p1 processor detected
```

## Step 3: Get a project for your exact chip

Generate a fresh project with STM32CubeMX for your exact part number. It writes the linker script, startup file and clock setup for that chip, so the error-prone parts are already right.

1. **New project.** Open *Access to MCU Selector* and type the full part number, for example `STM32H750VBT6`. Use the MCU selector, not the Board selector: non-ST boards such as WeAct are not in the board list.
2. **Debug pins.** Go to *System Core → SYS → Debug* and choose **Serial Wire**. This is the most important click. Without it, the program can take over PA13 and PA14, and the Atmel-ICE can no longer reach the chip.
3. **Crystal.** Go to *System Core → RCC → High Speed Clock (HSE)* and choose **Crystal/Ceramic Resonator**, if your board has a crystal.
4. **LED pin.** In the chip picture, click the LED pin (PE3 on the WeAct H750) and choose **GPIO\_Output**. Right-click it, choose *Enter User Label* and type `LED`.
5. **Clock.** On the *Clock Configuration* tab, set *Input frequency* to your crystal's value (25 for 25 MHz), select HSE and PLLCLK, type the speed you want into HCLK and press Enter. CubeMX works out the PLL numbers for you.
6. **H7 chips only.** In RCC's parameter settings, keep *Supply Source* at `PWR_LDO_SUPPLY` unless the board's schematic shows an SMPS circuit.
7. **Generate.** On *Project Manager*, set a name and folder, set *Toolchain / IDE* to **CMake**, then click *Generate Code*.

You get a folder with `CMakeLists.txt`, `CMakePresets.json`, `Core/Src/main.c`, a linker script ending in `_FLASH.ld` and a startup file. Copy your `openocd.cfg` into it.

### Starting from an ST example instead

This project started that way, and it works, but every ST example is written for one specific ST board. The example used here was for the STM32H750B-DISCO. It ran from external QSPI flash at `0x90000000` and blinked pin PJ2, and neither exists on the WeAct board. If you adapt an example, check every row of the table in step 4.

## Step 4: Add the blink code and check the settings

In a CubeMX project, the only thing missing is two lines of blink code. In an adapted example, also check every row of the table below.

### Blink code in a CubeMX project

In `Core/Src/main.c`, put the lines between the `USER CODE BEGIN 3` and `USER CODE END 3` markers inside the `while (1)` loop. Code outside the USER CODE markers is deleted the next time CubeMX regenerates the project.

```c
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
    HAL_GPIO_TogglePin(LED_GPIO_Port, LED_Pin);
    HAL_Delay(1000);   /* 1 s on, 1 s off */
  }
  /* USER CODE END 3 */
```

`LED_GPIO_Port` and `LED_Pin` exist because you gave the pin the label `LED` in step 3. `HAL_Delay()` counts in milliseconds: `1000` gives 1 s on and 1 s off, and `500` gives one blink per second.

### Blink code written by hand

This is what this project's `main.c` does, for when you are not using CubeMX:

```c
__HAL_RCC_GPIOE_CLK_ENABLE();             /* 1. turn on port E's clock */

GPIO_InitTypeDef gpio = {0};
gpio.Pin   = GPIO_PIN_3;
gpio.Mode  = GPIO_MODE_OUTPUT_PP;         /* 2. make PE3 an output */
gpio.Pull  = GPIO_NOPULL;
gpio.Speed = GPIO_SPEED_FREQ_LOW;
HAL_GPIO_Init(GPIOE, &gpio);

while (1)
{
  HAL_GPIO_TogglePin(GPIOE, GPIO_PIN_3);  /* 3. flip the pin */
  HAL_Delay(1000);                        /* wait 1000 ms */
}
```

For another board, change the port letter in the three places it appears (`GPIOE`, `__HAL_RCC_GPIOE_CLK_ENABLE`) and the pin number (`GPIO_PIN_3`).

### Settings that must match your chip and board

CubeMX gets these right by itself. An ST example written for a different board usually gets several of them wrong.

| Setting | Where it lives | WeAct H750 value |
| --- | --- | --- |
| Where the program is stored | Linker script, the `FLASH` line in `MEMORY` | `ORIGIN = 0x08000000, LENGTH = 128K` |
| Vector table address | `system_stm32xxxx.c`, or a define in CMake | `APPLICATION_ADDRESS=0x08000000U` |
| Chip define | Compile definitions in CMake | `STM32H750xx` |
| LED pin | `main.c` | `GPIOE`, `GPIO_PIN_3` |
| Crystal frequency | `HSE_VALUE` in `stm32xxxx_hal_conf.h`, plus the PLL numbers | `25000000` |
| Power supply (H7 only) | Define `USE_PWR_LDO_SUPPLY`, or `HAL_PWREx_ConfigSupply()` | LDO |
| Compiler flags | CMake files | Remove `-fcyclomatic-complexity`: only ST's own GCC knows it |

Internal flash starts at `0x08000000` on almost every STM32. A program linked for any other address, such as external QSPI flash, needs a separate bootloader to start it.

## Step 5: Build

Building turns the C code into one `.elf` file, and that file is what you flash in step 6. CubeMX projects come with the presets `Debug` and `Release`.

From a terminal in the project folder:

```bash
cmake --preset Debug            # once: prepares the build folder
cmake --build --preset Debug    # every time you change the code
```

The result is `build/Debug/<ProjectName>.elf`. In this project, the preset is `WeAct_InternalFlash_Debug` and the file is `build/WeAct_InternalFlash_Debug/GPIO_IOToggle.elf`.

In VS Code, open the project folder. In the CMake panel, pick the configure preset and click **Build** (or press F7).

To check that the program fits in the chip's flash, run:

```bash
arm-none-eabi-size build/Debug/<ProjectName>.elf
```

`text` + `data` must be smaller than the flash size. The blink program here uses about 7.5 KB of 128 KB.

## Step 6: Back up the factory firmware, then flash

Flashing erases whatever the board came with, so save a copy of a new board's flash first. The backup takes about 3 seconds and makes the flash undoable.

### Back up (once per new board)

```bash
openocd -f openocd.cfg -c "init" -c "reset halt" -c "dump_image backup.bin 0x08000000 0x20000" -c "reset run" -c "exit"
```

The last number is the flash size, written in hex:

| Flash size | Value to use |
| --- | --- |
| 64 KB | `0x10000` |
| 128 KB | `0x20000` |
| 256 KB | `0x40000` |
| 512 KB | `0x80000` |
| 1 MB | `0x100000` |
| 2 MB | `0x200000` |

### Flash

```bash
openocd -f openocd.cfg -c "program build/Debug/<ProjectName>.elf verify reset exit"
```

It worked if you see `** Verified OK **`. The board restarts by itself and runs the new program.

### Put the factory firmware back

```bash
openocd -f openocd.cfg -c "program backup.bin 0x08000000 verify reset exit"
```

A `.bin` file has no addresses inside it, so this command must include `0x08000000`. An `.elf` file carries its own addresses and needs none.

### One-click flashing in VS Code

Save this as `.vscode/tasks.json`, then run it from *Terminal → Run Task*.

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Flash (OpenOCD + Atmel-ICE)",
            "type": "shell",
            "command": "openocd",
            "args": [
                "-f", "openocd.cfg",
                "-c", "program build/Debug/<ProjectName>.elf verify reset exit"
            ],
            "options": { "cwd": "${workspaceFolder}" },
            "problemMatcher": []
        }
    ]
}
```

## Step 7: Check that it runs

If the LED blinks with the timing you set, you are done. To be sure it is your program and not leftover factory firmware, change the `HAL_Delay()` value, then rebuild, reflash and watch the speed change.

### Optional: read the pin through the Atmel-ICE

`mdw` reads a register while the program keeps running. On the WeAct H750, `0x58021014` is port E's output register:

```bash
openocd -f openocd.cfg -c "init" -c "mdw 0x58021014" -c "exit"
```

Run it a few times. The value switches between `0x00000008` and `0x00000000`, because bit 3 is PE3. For another chip, look up the GPIO port's base address in the reference manual's memory map and add `0x14` to it (`0x0C` on F1 chips).

## Troubleshooting

Most problems come down to wiring, a setting that doesn't match the board, or the Atmel-ICE needing a second try. Find your symptom in the first column.

| What you see | Likely cause | Fix |
| --- | --- | --- |
| `CMSIS-DAP command CMD_INFO failed` | A USB hiccup in the Atmel-ICE, often right after another OpenOCD run | Run the same command again. It happened several times on this project and the retry always worked |
| `Error connecting DP: cannot read IDR`, or no "processor detected" | Board not powered, pin 1 (VTref) not connected, or SWDIO and SWCLK swapped | Power the board through USB and check the step 2 wiring table. If that looks right, swap the two signal wires |
| `LIBUSB_ERROR_ACCESS` | Linux does not let you use the USB device | Install OpenOCD from apt (it adds the permission rule), then unplug and replug the Atmel-ICE |
| `unrecognized command-line option '-fcyclomatic-complexity'` | That flag only exists in ST's own GCC | Delete the flag from the CMake files |
| `Verified OK`, but the LED does nothing | Wrong LED pin, program linked for the wrong address, or the program is stuck in `Error_Handler` because the crystal setting is wrong | Check the step 4 table, then find where it is stuck (below) |
| The LED blinks, but too fast or too slow | `HSE_VALUE` or the CubeMX input frequency doesn't match the crystal | Set it to the value written next to the crystal on the schematic |
| It worked once, now the Atmel-ICE can't connect | The program took over the SWD pins (Debug not set to Serial Wire) or put the chip to sleep | Hold BOOT0, press and release RESET, then release BOOT0. The chip now starts its built-in bootloader instead of your program, so flash a fixed version |
| Flash or backup fails with a protection error | The chip has read protection turned on | `openocd -f openocd.cfg -c "init" -c "reset halt" -c "stm32h7x unlock 0" -c "exit"`, then power-cycle. **This erases everything.** Replace `stm32h7x` with `stm32f1x` (F0/F1/F3), `stm32f2x` (F2/F4/F7) or `stm32l4x` (L4/G0/G4/WB/WL) |

### Find where a program is stuck

Halt the chip for a moment to see which instruction it is on (the `pc` value):

```bash
openocd -f openocd.cfg -c "init" -c "halt" -c "resume" -c "exit"
```

Then turn that address into a function name:

```bash
arm-none-eabi-addr2line -f -e build/Debug/<ProjectName>.elf 0x08000ae4
```

If it says `Error_Handler`, a HAL call failed, usually the clock setup.

## Cheat sheet

Every command in this guide, in the order you use them. Run them from the project folder, with `openocd.cfg` set for your chip family.

```bash
# Is the Atmel-ICE plugged in? (shows "Atmel Corp. ICE debugger")
lsusb | grep 03eb:2141

# Can it see the chip? (look for "processor detected")
openocd -f openocd.cfg -c "init" -c "exit"

# Build
cmake --preset Debug
cmake --build --preset Debug

# Back up the factory firmware (last number = flash size)
openocd -f openocd.cfg -c "init" -c "reset halt" -c "dump_image backup.bin 0x08000000 0x20000" -c "reset run" -c "exit"

# Flash and verify
openocd -f openocd.cfg -c "program build/Debug/<ProjectName>.elf verify reset exit"

# Restore the backup
openocd -f openocd.cfg -c "program backup.bin 0x08000000 verify reset exit"

# Read a register while the program runs (WeAct H750: port E output)
openocd -f openocd.cfg -c "init" -c "mdw 0x58021014" -c "exit"
```
