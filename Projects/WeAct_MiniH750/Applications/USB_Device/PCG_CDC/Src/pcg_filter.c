#include "pcg_filter.h"

/* {b0, b1, b2, a1, a2} per biquad, a0 = 1. Generated with scipy 1.11.4:
   butter(4, 20, 'highpass', fs=48000, output='sos') followed by
   butter(4, 200, 'lowpass', fs=48000, output='sos'). */
static const double sos[4][5] = {
  {0.996585268514311, -1.993170537028622, 0.996585268514311, -1.9951674183225134, 0.9951742556729883},
  {1.0, -2.0, 1.0, -1.9979914349390582, 0.9979982819673131},
  {2.837905225123163e-08, 5.675810450246326e-08, 2.837905225123163e-08, -1.9521042830479534, 0.9527734497375733},
  {1.0, 2.0, 1.0, -1.9794851879071822, 0.980163740565381},
};

static double z[4][2]; /* transposed direct form II state */

void pcg_filter(const uint16_t *in, int16_t *out, int n)
{
  for (int i = 0; i < n; i++)
  {
    /* Removing mid-scale first avoids a full-scale step transient at power-up */
    double x = (double)in[i] - 32768.0;
    for (int s = 0; s < 4; s++)
    {
      const double *c = sos[s];
      double y = c[0] * x + z[s][0];
      z[s][0] = c[1] * x - c[3] * y + z[s][1];
      z[s][1] = c[2] * x - c[4] * y;
      x = y;
    }
    /* +-32767 keeps 0x8000 free for the frame sync word */
    if (x > 32767.0) x = 32767.0;
    if (x < -32767.0) x = -32767.0;
    out[i] = (int16_t)(x < 0 ? x - 0.5 : x + 0.5);
  }
}
