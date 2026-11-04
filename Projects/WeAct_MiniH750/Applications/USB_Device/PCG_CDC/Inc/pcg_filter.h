#ifndef PCG_FILTER_H
#define PCG_FILTER_H

#include <stdint.h>

#define PCG_DECIMATE 48 /* 48 kHz in, 1000 Hz out */

/* Band-passes n raw 16-bit ADC counts sampled at 48 kHz (20-200 Hz) and writes
   every PCG_DECIMATE-th result to out, so n / PCG_DECIMATE filtered counts
   clamped to +-32767. n must be a multiple of PCG_DECIMATE. The state carries
   over between calls. */
void pcg_filter(const uint16_t *in, int16_t *out, int n);

#endif /* PCG_FILTER_H */
