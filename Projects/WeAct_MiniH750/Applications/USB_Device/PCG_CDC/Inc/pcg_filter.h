#ifndef PCG_FILTER_H
#define PCG_FILTER_H

#include <stdint.h>

/* Band-passes n raw 16-bit ADC counts sampled at 48 kHz (20-200 Hz) into
   filtered counts clamped to +-32767. The state carries over between calls. */
void pcg_filter(const uint16_t *in, int16_t *out, int n);

#endif /* PCG_FILTER_H */
