##
## STM32H7 (Cortex-M7 with double-precision FPU) target specific CMake file.
## The H7 counterpart of stm32fx.cmake: include it after toolchain-arm-none-eabi.
##

if(NOT DEFINED LINKER_SCRIPT)
    message(FATAL_ERROR "No linker script defined")
endif(NOT DEFINED LINKER_SCRIPT)
message("Linker script: ${LINKER_SCRIPT}")

# -mfpu=fpv5-d16 -mfloat-abi=hard   Use the H7's double-precision FPU with the hard-float calling convention.
set(OBJECT_GEN_FLAGS "-mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${OBJECT_GEN_FLAGS}" CACHE INTERNAL "C Compiler options")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${OBJECT_GEN_FLAGS}" CACHE INTERNAL "C++ Compiler options")
set(CMAKE_ASM_FLAGS "${CMAKE_ASM_FLAGS} ${OBJECT_GEN_FLAGS}" CACHE INTERNAL "ASM Compiler options")

# Linker flags
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} ${OBJECT_GEN_FLAGS} -T\"${LINKER_SCRIPT}\"" CACHE INTERNAL "Linker options")
