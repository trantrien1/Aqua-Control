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
// Live post-flash tap-water samples: median ADC is approximately 1.927 V.
// This single-point field reference assumes pH 7.00; slope remains provisional.
constexpr float PH_REFERENCE_ADC = 1.927f;
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
}
#undef SENSOR_CONSTEXPR
