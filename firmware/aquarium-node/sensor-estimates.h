#pragma once
#include <math.h>
#include <stdint.h>

#if __cplusplus >= 201402L
#define SENSOR_CONSTEXPR constexpr
#else
#define SENSOR_CONSTEXPR
#endif

// User-requested approximation. These are assumptions, not measured calibration values.
namespace SensorEstimates {
constexpr bool FIXED_REFERENCE_MODE = true;
// Median of the user's 15 stable-water samples, assumed approximately pH 7.
// This single-point field reference assumes pH 7.00; slope remains provisional.
constexpr float PH_REFERENCE_ADC = 1.831f;
constexpr float TURBIDITY_REFERENCE_OUT = 3.272f;
constexpr float TAP_PH = 7.0f;
// Adjustable heuristic for this provisional display; actual module polarity/gain may differ.
constexpr float ADC_VOLTS_PER_PH = -0.10f;

SENSOR_CONSTEXPR bool validADC(float v) { return isfinite(v) && v >= 0.15f && v <= 2.60f; }
SENSOR_CONSTEXPR float ph(float adc, float referenceADC) {
  if (!validADC(adc) || !validADC(referenceADC)) return NAN;
  const float estimate = TAP_PH + (adc - referenceADC) / ADC_VOLTS_PER_PH;
  return isfinite(estimate) && estimate >= 0 && estimate <= 14 ? estimate : NAN;
}
SENSOR_CONSTEXPR bool calibrationReady(float ph7ADC, float ph4ADC) {
  return validADC(ph7ADC) && validADC(ph4ADC) && fabsf(ph4ADC - ph7ADC) > .02f;
}
SENSOR_CONSTEXPR float calibratedPH(float adc, float ph7ADC, float ph4ADC) {
  if (!validADC(adc) || !calibrationReady(ph7ADC, ph4ADC)) return NAN;
  const float result = 7.0f + (adc - ph7ADC) * (4.0f - 7.0f) / (ph4ADC - ph7ADC);
  return isfinite(result) && result >= 0 && result <= 14 ? result : NAN;
}
SENSOR_CONSTEXPR float voltageChangePercent(float adc, float referenceADC) {
  if (!isfinite(adc) || adc < 0 || adc > 2.60f || !validADC(referenceADC)) return NAN;
  return (adc - referenceADC) / referenceADC * 100.0f;
}
// A relative optical signal drop, not NTU or a percentage of suspended material.
SENSOR_CONSTEXPR float turbidityPercent(float outVoltage) {
  if (!isfinite(outVoltage) || outVoltage < 0 || outVoltage > 5.20f) return NAN;
  const float percent = (TURBIDITY_REFERENCE_OUT - outVoltage) / TURBIDITY_REFERENCE_OUT * 100.0f;
  return percent < 0 ? 0 : percent > 100 ? 100 : percent;
}
SENSOR_CONSTEXPR bool controlReady(float value, bool twoPointCalibrated, bool fixedReference) {
  return isfinite(value) && value >= 0 && value <= 14 && (twoPointCalibrated || fixedReference);
}

// Temporal median rejects isolated spikes; EMA damps small jitter. Three consistent
// large changes bypass the slow path so a real change is not held near the reference.
class PhVoltageFilter {
  float window[5] = {};
  uint8_t count = 0, index = 0, stepCount = 0;
  int8_t stepDirection = 0;
  float value = NAN;
  float stepBaseline = NAN;
public:
  void reset() { count = index = stepCount = 0; stepDirection = 0; value = NAN; }
  float update(float adc) {
    if (!validADC(adc)) { reset(); return NAN; }
    window[index] = adc; index = (index + 1) % 5;
    if (count < 5) ++count;
    float sorted[5];
    for (uint8_t i = 0; i < count; ++i) sorted[i] = window[i];
    for (uint8_t i = 1; i < count; ++i) {
      float item = sorted[i]; int j = i - 1;
      while (j >= 0 && sorted[j] > item) { sorted[j + 1] = sorted[j]; --j; }
      sorted[j + 1] = item;
    }
    const float median = count % 2 ? sorted[count / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
    if (!isfinite(value)) value = median;
    const float change = adc - (stepCount ? stepBaseline : value);
    const int8_t direction = change >= .08f ? 1 : change <= -.08f ? -1 : 0;
    if (direction && direction == stepDirection) ++stepCount;
    else { stepBaseline = value; stepCount = direction ? 1 : 0; stepDirection = direction; }
    if (stepCount >= 3) { value = median; stepCount = 0; stepDirection = 0; }
    else value += .25f * (median - value);
    return value;
  }
};
}
#undef SENSOR_CONSTEXPR
