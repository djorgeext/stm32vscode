cmake_minimum_required(VERSION 3.20)

# Standalone project: the root CMakeLists.txt hard-codes F1 flags, includes and startup
get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." ABSOLUTE)
list(APPEND CMAKE_MODULE_PATH "${REPO_ROOT}/cmake")

include(toolchain-arm-none-eabi)
set(LINKER_SCRIPT "${REPO_ROOT}/GCC/STM32H750VBTX_FLASH.ld")
include(stm32h7)

project(PCG_CDC C ASM)

add_definitions(-DSTM32H750xx -DUSE_HAL_DRIVER -DUSE_PWR_LDO_SUPPLY)

include_directories(
    Inc
    ${REPO_ROOT}/Drivers/CMSIS/Include
    ${REPO_ROOT}/Drivers/CMSIS/Device/ST/STM32H7xx/Include
    ${REPO_ROOT}/Drivers/STM32H7xx_HAL_Driver/Inc
    ${REPO_ROOT}/Middlewares/ST/STM32_USB_Device_Library/Core/Inc
    ${REPO_ROOT}/Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc
    )

FILE(GLOB HAL_SRC "${REPO_ROOT}/Drivers/STM32H7xx_HAL_Driver/Src/*.c")
list(FILTER HAL_SRC EXCLUDE REGEX ".*template\\.c$")

FILE(GLOB PROJECT_SRC "Src/*.c")

add_executable(PCG_CDC.elf
    ${PROJECT_SRC}
    ${HAL_SRC}
    ${REPO_ROOT}/GCC/startup_stm32h750xx.s
    ${REPO_ROOT}/Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_core.c
    ${REPO_ROOT}/Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ctlreq.c
    ${REPO_ROOT}/Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ioreq.c
    ${REPO_ROOT}/Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Src/usbd_cdc.c
    )
set_target_properties(PCG_CDC.elf PROPERTIES LINK_DEPENDS "${LINKER_SCRIPT}")
