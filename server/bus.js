/**
 * Kênh sự kiện nội bộ giữa tầng MQTT và tầng HTTP (SSE).
 * Tách riêng để tránh import vòng giữa broker và route.
 */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
// Mỗi tab trình duyệt mở một kết nối SSE, nên số listener có thể lớn.
bus.setMaxListeners(0);

/** Tên sự kiện dùng chung. */
export const EVENTS = {
  reading: 'reading',
  device: 'device',
  pumps: 'pumps',
  alert: 'alert',
  water: 'water',
};
