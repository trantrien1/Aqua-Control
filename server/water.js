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

export function waterSettings(deviceId) {
  return db.getWaterSettings(deviceId) ?? {
    revision: 0, tankLiters: null, autoEnabled: false,
    thresholds: structuredClone(DEFAULT_THRESHOLDS),
  };
}

export function validateSettings(body, previous) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!body || body.revision !== previous.revision) {
    throw Object.assign(new Error('Cấu hình đã thay đổi. Tải lại trước khi lưu.'), { statusCode: 409 });
  }
  if (typeof body.tankLiters !== 'number' || !Number.isFinite(body.tankLiters) || body.tankLiters < 1 || body.tankLiters > 500) fail('Thể tích bể phải từ 1 đến 500 lít.');
  if (typeof body.autoEnabled !== 'boolean') fail('Chế độ tự động phải là bật hoặc tắt.');
  const thresholds = {};
  for (const [key, domain] of Object.entries(DOMAINS)) {
    const r = body.thresholds?.[key];
    if (!r || !['min', 'max', 'criticalMin', 'criticalMax'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]))) fail(`Ngưỡng ${PARAMS[key].short} phải là các số hợp lệ.`);
    if (!(domain[0] <= r.criticalMin && r.criticalMin <= r.min && r.min < r.max && r.max <= r.criticalMax && r.criticalMax <= domain[1])) fail(`Ngưỡng ${PARAMS[key].short}: nguy hiểm thấp ≤ an toàn thấp < an toàn cao ≤ nguy hiểm cao, trong ${domain.join('–')}.`);
    thresholds[key] = Object.fromEntries(['min', 'max', 'criticalMin', 'criticalMax'].map(k => [k, r[k]]));
  }
  return { revision: previous.revision + 1, tankLiters: body.tankLiters, autoEnabled: body.autoEnabled, thresholds };
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
