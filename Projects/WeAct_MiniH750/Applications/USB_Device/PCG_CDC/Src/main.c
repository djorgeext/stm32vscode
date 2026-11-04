/* PCG_CDC: samples PA6 at 48 kHz, band-passes it 20-200 Hz, keeps every 48th
   sample and streams it over USB CDC as little-endian int16 frames, one every
   10 ms:
   [0x8000 sync][seq 0-32767, wrapping][10 filtered samples at 1000 Hz] */
#include "main.h"
#include "usb_device.h"
#include "usbd_cdc_if.h"
#include "pcg_filter.h"

#define HALF 480 /* samples per DMA half: 10 ms at 48 kHz */
#define FRAME_SAMPLES (HALF / PCG_DECIMATE) /* 10 samples at 1000 Hz */

ADC_HandleTypeDef hadc1;
static TIM_HandleTypeDef htim3;
/* DMA target: all RAM is AXI SRAM (DMA1 cannot reach DTCM) and the D-cache stays off */
static uint16_t adc_buf[2 * HALF];
static volatile uint32_t halves_done; /* even count: the first half is next to read */
static int16_t frame[2 + FRAME_SAMPLES];

static void SystemClock_Config(void);
static void ADC1_Init(void);
static void TIM3_Init(void);

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_USB_DEVICE_Init();
  ADC1_Init();
  TIM3_Init();

  if (HAL_ADC_Start_DMA(&hadc1, (uint32_t *)adc_buf, 2 * HALF) != HAL_OK)
  {
    Error_Handler();
  }
  if (HAL_TIM_Base_Start(&htim3) != HAL_OK)
  {
    Error_Handler();
  }

  frame[0] = INT16_MIN; /* 0x8000 sync */
  uint32_t taken = 0;
  while (1)
  {
    if (taken == halves_done)
    {
      continue;
    }
    /* Every half is filtered, sent or not, so the filter state stays continuous */
    pcg_filter(&adc_buf[(taken & 1) * HALF], &frame[2], HALF);
    frame[1] = (int16_t)(taken & 0x7FFF);
    taken++;
    /* BUSY means the host is not reading: the frame is dropped and the seq gap shows it */
    CDC_Transmit_FS((uint8_t *)frame, sizeof frame);
  }
}

void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *hadc)
{
  halves_done++;
}

void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
  halves_done++;
}

/* HSE 25 MHz / M5 = 5 MHz, x N96 = 480 MHz VCO: P2 = 240 MHz SYSCLK, Q10 = 48 MHz USB.
   HCLK 120 MHz, APB1-4 60 MHz (100 MHz max in VOS1), so TIM3 runs at 2 x 60 = 120 MHz. */
static void SystemClock_Config(void)
{
  RCC_OscInitTypeDef osc = {0};
  RCC_ClkInitTypeDef clk = {0};
  RCC_PeriphCLKInitTypeDef periph = {0};

  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);
  while (!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {}

  /* Only HSE is touched: HSI stays on because it feeds per_ck, the ADC clock */
  osc.OscillatorType = RCC_OSCILLATORTYPE_HSE;
  osc.HSEState = RCC_HSE_ON;
  osc.PLL.PLLState = RCC_PLL_ON;
  osc.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  osc.PLL.PLLM = 5;
  osc.PLL.PLLN = 96;
  osc.PLL.PLLP = 2;
  osc.PLL.PLLQ = 10;
  osc.PLL.PLLR = 2;
  osc.PLL.PLLRGE = RCC_PLL1VCIRANGE_2;
  osc.PLL.PLLVCOSEL = RCC_PLL1VCOWIDE;
  osc.PLL.PLLFRACN = 0;
  if (HAL_RCC_OscConfig(&osc) != HAL_OK)
  {
    Error_Handler();
  }

  clk.ClockType = RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_D1PCLK1 |
                  RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2 | RCC_CLOCKTYPE_D3PCLK1;
  clk.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  clk.SYSCLKDivider = RCC_SYSCLK_DIV1;
  clk.AHBCLKDivider = RCC_HCLK_DIV2;
  clk.APB3CLKDivider = RCC_APB3_DIV2;
  clk.APB1CLKDivider = RCC_APB1_DIV2;
  clk.APB2CLKDivider = RCC_APB2_DIV2;
  clk.APB4CLKDivider = RCC_APB4_DIV2;
  /* VOS1 needs 1 wait state up to 140 MHz; the second is margin */
  if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_2) != HAL_OK)
  {
    Error_Handler();
  }

  /* After reset the USB kernel clock is off and the ADC sits on PLL2P, which is not running */
  periph.PeriphClockSelection = RCC_PERIPHCLK_USB | RCC_PERIPHCLK_ADC;
  periph.UsbClockSelection = RCC_USBCLKSOURCE_PLL;
  periph.AdcClockSelection = RCC_ADCCLKSOURCE_CLKP;
  if (HAL_RCCEx_PeriphCLKConfig(&periph) != HAL_OK)
  {
    Error_Handler();
  }
}

static void ADC1_Init(void)
{
  ADC_ChannelConfTypeDef ch = {0};

  hadc1.Instance = ADC1;
  hadc1.Init.ClockPrescaler = ADC_CLOCK_ASYNC_DIV4; /* per_ck = HSI 64 MHz */
  hadc1.Init.Resolution = ADC_RESOLUTION_16B;
  hadc1.Init.ScanConvMode = ADC_SCAN_DISABLE;
  hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
  hadc1.Init.ContinuousConvMode = DISABLE;
  hadc1.Init.NbrOfConversion = 1;
  hadc1.Init.ExternalTrigConv = ADC_EXTERNALTRIG_T3_TRGO;
  hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_RISING;
  hadc1.Init.ConversionDataManagement = ADC_CONVERSIONDATA_DMA_CIRCULAR;
  hadc1.Init.Overrun = ADC_OVR_DATA_OVERWRITTEN;
  hadc1.Init.LeftBitShift = ADC_LEFTBITSHIFT_NONE;
  hadc1.Init.OversamplingMode = DISABLE;
  if (HAL_ADC_Init(&hadc1) != HAL_OK)
  {
    Error_Handler();
  }

  if (HAL_ADCEx_Calibration_Start(&hadc1, ADC_CALIB_OFFSET_LINEARITY, ADC_SINGLE_ENDED) != HAL_OK)
  {
    Error_Handler();
  }

  ch.Channel = ADC_CHANNEL_3; /* PA6 = ADC12_INP3 */
  ch.Rank = ADC_REGULAR_RANK_1;
  ch.SamplingTime = ADC_SAMPLETIME_64CYCLES_5;
  ch.SingleDiff = ADC_SINGLE_ENDED;
  ch.OffsetNumber = ADC_OFFSET_NONE;
  if (HAL_ADC_ConfigChannel(&hadc1, &ch) != HAL_OK)
  {
    Error_Handler();
  }
}

static void TIM3_Init(void)
{
  TIM_MasterConfigTypeDef master = {0};

  /* 120 MHz / (PSC 0 + 1) / (ARR 2499 + 1) = 48 000 Hz, locked to the crystal */
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 0;
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 2499;
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim3) != HAL_OK)
  {
    Error_Handler();
  }

  master.MasterOutputTrigger = TIM_TRGO_UPDATE;
  master.MasterSlaveMode = TIM_MASTERSLAVEMODE_DISABLE;
  if (HAL_TIMEx_MasterConfigSynchronization(&htim3, &master) != HAL_OK)
  {
    Error_Handler();
  }
}

void Error_Handler(void)
{
  __disable_irq();
  while (1)
  {
  }
}
