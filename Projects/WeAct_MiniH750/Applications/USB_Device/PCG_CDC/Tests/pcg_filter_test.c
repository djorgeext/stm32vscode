/* Host self-check of the band-pass: feeds 2 s of each tone in 480-sample
   blocks, as the firmware does, and measures the RMS gain over the last 1 s.
   gcc -O2 -Wall -IInc Src/pcg_filter.c Tests/pcg_filter_test.c -lm -o /tmp/pcg_filter_test && /tmp/pcg_filter_test */
#include <math.h>
#include <stdio.h>
#include "pcg_filter.h"

#define FS 48000
#define BLOCK 480
#define AMP 10000.0

static double gain_db(double f)
{
  uint16_t in[BLOCK];
  int16_t out[BLOCK];
  double sum = 0;
  for (int n0 = 0; n0 < 2 * FS; n0 += BLOCK)
  {
    for (int i = 0; i < BLOCK; i++)
      in[i] = (uint16_t)lrint(32768.0 + AMP * sin(2 * M_PI * f * (n0 + i) / FS));
    pcg_filter(in, out, BLOCK);
    if (n0 >= FS)
      for (int i = 0; i < BLOCK / PCG_DECIMATE; i++)
        sum += (double)out[i] * out[i];
  }
  return 20 * log10(sqrt(sum / (FS / PCG_DECIMATE)) / (AMP / sqrt(2)));
}

int main(void)
{
  /* {tone Hz, min dB, max dB} */
  static const double cases[][3] = {
    {100, -0.5, 0.5}, {20, -3.5, -2.5}, {200, -3.5, -2.5}, {2, -INFINITY, -30}, {2000, -INFINITY, -30},
    {600, -39, -37}, {800, -49, -47},
  };
  int fails = 0;
  for (unsigned k = 0; k < sizeof cases / sizeof cases[0]; k++)
  {
    double g = gain_db(cases[k][0]);
    int ok = g >= cases[k][1] && g <= cases[k][2];
    printf("%6.0f Hz: %8.3f dB %s\n", cases[k][0], g, ok ? "ok" : "FAIL");
    fails += !ok;
  }
  return fails != 0;
}
