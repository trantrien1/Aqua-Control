import { PARAMS } from './config.js';
import * as db from './db.js';

export const FLOW_LPH = 96;
export const ACTIVE_STAGES = ['draining', 'switching', 'filling', 'settling'];
export const DEFAULT_THRESHOLDS = {
  temperature: { min: 24, max: 28, criticalMin: 20, criticalMax: 32 },
  ph: { min: 6.8, max: 8.2, criticalMin: 6, criticalMax: 9 },
  tds: { min: 180, max: 280, criticalMin: 60, criticalMax: 450 },
  turbidity_percent: { min: 0, max: 30, criticalMin: 0, criticalMax: 60 },
};
const DOMAINS = { temperature: [-55, 125], ph: [0, 14], tds: [0, 5000], turbidity_percent: [0, 100] };
export const DEFAULT_LIGHTING = {
  scheduleEnabled: false, onMinute: 480, offMinute: 960, utcOffsetMinutes: 420,
  heatEnabled: false, heatOn: 24, heatOff: 25,
};

export function validateLighting(value) {
  const fail = () => { throw Object.assign(new Error('Cấu hình đèn: giờ bật/tắt phải khác nhau, phút trong 0–1439, múi giờ −720 đến 840; nhiệt độ 0–40 °C, ngưỡng tắt cao hơn bật ít nhất 0,1 °C.'), { statusCode: 400 }); };
  if (!value || typeof value.scheduleEnabled !== 'boolean' || typeof value.heatEnabled !== 'boolean') fail();
  for (const key of ['onMinute', 'offMinute']) if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 1439) fail();
  if (value.onMinute === value.offMinute || !Number.isInteger(value.utcOffsetMinutes) || value.utcOffsetMinutes < -720 || value.utcOffsetMinutes > 840) fail();
  if (![value.heatOn, value.heatOff].every(n => typeof n === 'number' && Number.isFinite(n)) || value.heatOn < 0 || value.heatOff > 40 || value.heatOff - value.heatOn < 0.1 - 1e-6) fail();
  return Object.fromEntries(Object.keys(DEFAULT_LIGHTING).map(key => [key, value[key]]));
}

export function waterSettings(deviceId) {
  const settings = db.getWaterSettings(deviceId) ?? {
    revision: 0, tankLiters: null, autoEnabled: false,
    thresholds: structuredClone(DEFAULT_THRESHOLDS),
  };
  return { ...settings, lighting: { ...DEFAULT_LIGHTING, ...settings.lighting } };
}

export function validateSettings(body, previous) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!body || body.revision !== previous.revision) {
    throw Object.assign(new Error('Cấu hình đã thay đổi. Tải lại trước khi lưu.'), { statusCode: 409 });
  }
  if (body.tankLiters !== null && (typeof body.tankLiters !== 'number' || !Number.isFinite(body.tankLiters) || body.tankLiters < 1 || body.tankLiters > 500)) fail('Thể tích bể phải từ 1 đến 500 lít.');
  if (typeof body.autoEnabled !== 'boolean') fail('Chế độ tự động phải là bật hoặc tắt.');
  if (body.autoEnabled && body.tankLiters === null) fail('Nhập thể tích bể trước khi bật tự thay nước.');
  const thresholds = {};
  for (const [key, domain] of Object.entries(DOMAINS)) {
    const r = body.thresholds?.[key];
    if (!r || !['min', 'max', 'criticalMin', 'criticalMax'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]))) fail(`Ngưỡng ${PARAMS[key].short} phải là các số hợp lệ.`);
    if (!(domain[0] <= r.criticalMin && r.criticalMin <= r.min && r.min < r.max && r.max <= r.criticalMax && r.criticalMax <= domain[1])) fail(`Ngưỡng ${PARAMS[key].short}: nguy hiểm thấp ≤ an toàn thấp < an toàn cao ≤ nguy hiểm cao, trong ${domain.join('–')}.`);
    thresholds[key] = Object.fromEntries(['min', 'max', 'criticalMin', 'criticalMax'].map(k => [k, r[k]]));
  }
  const lighting = validateLighting(body.lighting === undefined ? { ...DEFAULT_LIGHTING, ...previous.lighting } : body.lighting);
  return { revision: previous.revision + 1, tankLiters: body.tankLiters, autoEnabled: body.autoEnabled, thresholds, lighting };
}

export function parameterDef(key, settings) {
  const def = PARAMS[key];
  const r = settings?.thresholds?.[key];
  return !r ? def : { ...def, min: r.min, max: r.max, warnLow: r.min, warnHigh: r.max, criticalLow: r.criticalMin, criticalHigh: r.criticalMax };
}

export function changeEstimate(tankLiters, percent) {
  const liters = tankLiters * percent / 100;
  const phaseSeconds = Math.round(liters / FLOW_LPH * 3600 * 1000) / 1000;
  return { liters, phaseSeconds, totalSeconds: phaseSeconds * 2 + 61, flowLph: FLOW_LPH };
}
