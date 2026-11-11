/**
 * Biểu đồ đường vẽ bằng canvas, không phụ thuộc thư viện ngoài.
 * Hiển thị giá trị trung bình theo bucket, dải min–max mờ và vùng an toàn.
 */

const CSS_VAR = {
  surface: "--surface",
  border: "--border",
  text: "--text",
  muted: "--text-muted",
  accent: "--accent",
  good: "--good",
  warn: "--warn",
};

function readColor(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export class LineChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.points = [];
    this.meta = null;
    this.hoverIndex = -1;
    this.colors = {
      surface: readColor(CSS_VAR.surface, "#161b22"),
      border: readColor(CSS_VAR.border, "#30363d"),
      text: readColor(CSS_VAR.text, "#e6edf3"),
      muted: readColor(CSS_VAR.muted, "#8b949e"),
      accent: readColor(CSS_VAR.accent, "#2f81f7"),
      good: readColor(CSS_VAR.good, "#3fb950"),
      warn: readColor(CSS_VAR.warn, "#d29922"),
    };

    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(canvas.parentElement);

    canvas.addEventListener("pointermove", (event) =>
      this.handlePointer(event),
    );
    canvas.addEventListener("pointerleave", () => {
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this.render();
      }
    });
  }

  setData(points, meta) {
    this.points = Array.isArray(points) ? points : [];
    this.meta = meta || null;
    this.hoverIndex = -1;
    this.render();
  }

  get padding() {
    return { top: 18, right: 16, bottom: 28, left: 52 };
  }

  layout() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(140, Math.round(rect.width));
    const height = Math.max(120, Math.round(rect.height));

    if (
      this.canvas.width !== Math.round(width * dpr) ||
      this.canvas.height !== Math.round(height * dpr)
    ) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = this.padding;
    return {
      width,
      height,
      plot: {
        x: pad.left,
        y: pad.top,
        w: Math.max(1, width - pad.left - pad.right),
        h: Math.max(1, height - pad.top - pad.bottom),
      },
    };
  }

  scales(points, plot) {
    const values = [];
    for (const p of points) {
      if (Number.isFinite(p.avg)) values.push(p.avg);
      if (Number.isFinite(p.min)) values.push(p.min);
      if (Number.isFinite(p.max)) values.push(p.max);
    }
    const safe = this.meta && this.meta.safeRange;
    if (safe && Number.isFinite(safe.low) && Number.isFinite(safe.high))
      values.push(safe.low, safe.high);

    let min = Math.min(...values);
    let max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    if (max - min < 1e-9) {
      const pad = Math.max(Math.abs(max) * 0.1, 1);
      min -= pad;
      max += pad;
    } else {
      const pad = (max - min) * 0.12;
      min -= pad;
      max += pad;
    }

    const first = points.length ? points[0].ts : Date.now() - 3600_000;
    const last = points.length ? points[points.length - 1].ts : Date.now();
    const span = Math.max(1, last - first);

    return {
      min,
      max,
      tsMin: first,
      tsMax: last,
      span,
      y: (value) => plot.y + plot.h - ((value - min) / (max - min)) * plot.h,
      x: (ts) =>
        plot.x +
        (points.length <= 1 ? plot.w / 2 : ((ts - first) / span) * plot.w),
    };
  }

  render() {
    const { ctx } = this;
    const { width, height, plot } = this.layout();
    const showsDay =
      this.meta && this.meta.rangeMs && this.meta.rangeMs > 36 * 3600 * 1000;

    ctx.clearRect(0, 0, width, height);

    if (!this.points.length) {
      ctx.fillStyle = this.colors.muted;
      ctx.font = '14px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        "Chưa có dữ liệu trong khoảng thời gian này",
        width / 2,
        height / 2,
      );
      return;
    }

    const s = this.scales(this.points, plot);
    const decimals = this.meta ? (this.meta.decimals ?? 1) : 1;

    // Lưới ngang + nhãn trục tung
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const steps = 4;
    for (let i = 0; i <= steps; i += 1) {
      const value = s.min + ((s.max - s.min) * i) / steps;
      const y = s.y(value);
      ctx.strokeStyle = this.colors.border;
      ctx.globalAlpha = i === 0 ? 0.7 : 0.35;
      ctx.beginPath();
      ctx.moveTo(plot.x, y + 0.5);
      ctx.lineTo(plot.x + plot.w, y + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.colors.muted;
      ctx.fillText(
        value.toLocaleString("vi-VN", {
          maximumFractionDigits: decimals,
          minimumFractionDigits: decimals,
        }),
        plot.x - 8,
        y,
      );
    }

    // Dải an toàn
    const safe = this.meta && this.meta.safeRange;
    if (safe && Number.isFinite(safe.low) && Number.isFinite(safe.high)) {
      const yTop = s.y(Math.min(safe.high, s.max));
      const yBottom = s.y(Math.max(safe.low, s.min));
      if (yBottom > yTop) {
        ctx.fillStyle = this.colors.good;
        ctx.globalAlpha = 0.08;
        ctx.fillRect(plot.x, yTop, plot.w, yBottom - yTop);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.colors.good;
        ctx.globalAlpha = 0.3;
        ctx.setLineDash([4, 4]);
        for (const y of [yTop, yBottom]) {
          ctx.beginPath();
          ctx.moveTo(plot.x, y + 0.5);
          ctx.lineTo(plot.x + plot.w, y + 0.5);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Dải min–max mờ
    const hasSpread = this.points.some(
      (p) =>
        Number.isFinite(p.min) &&
        Number.isFinite(p.max) &&
        p.max - p.min > 1e-9,
    );
    if (hasSpread && this.points.length > 2) {
      ctx.beginPath();
      this.points.forEach((p, i) => {
        const y = s.y(Number.isFinite(p.max) ? p.max : p.avg);
        if (i === 0) ctx.moveTo(s.x(p.ts), y);
        else ctx.lineTo(s.x(p.ts), y);
      });
      for (let i = this.points.length - 1; i >= 0; i -= 1) {
        const p = this.points[i];
        ctx.lineTo(s.x(p.ts), s.y(Number.isFinite(p.min) ? p.min : p.avg));
      }
      ctx.closePath();
      ctx.fillStyle = this.colors.accent;
      ctx.globalAlpha = 0.12;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Đường trung bình
    const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    gradient.addColorStop(0, "rgba(15, 118, 110, 0.16)");
    gradient.addColorStop(1, "rgba(15, 118, 110, 0)");

    ctx.beginPath();
    this.points.forEach((p, i) => {
      const x = s.x(p.ts);
      const y = s.y(p.avg);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const linePath = ctx;

    // Vùng tô dưới đường
    const lastPoint = this.points[this.points.length - 1];
    const firstPoint = this.points[0];
    linePath.lineTo(s.x(lastPoint.ts), plot.y + plot.h);
    linePath.lineTo(s.x(firstPoint.ts), plot.y + plot.h);
    linePath.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Vẽ lại đường viền cho sắc nét
    ctx.beginPath();
    this.points.forEach((p, i) => {
      const x = s.x(p.ts);
      const y = s.y(p.avg);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Điểm cuối
    if (this.points.length > 0) {
      const x = s.x(lastPoint.ts);
      const y = s.y(lastPoint.avg);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = this.colors.accent;
      ctx.fill();
      ctx.strokeStyle = this.colors.surface;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Nhãn trục hoành
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = this.colors.muted;
    const ticks = 4;
    for (let i = 0; i <= ticks; i += 1) {
      const ts = s.tsMin + (s.span * i) / ticks;
      const x = Math.min(plot.x + plot.w - 20, Math.max(plot.x + 20, s.x(ts)));
      const date = new Date(ts);
      const label = showsDay
        ? `${date.getDate()}/${date.getMonth() + 1}`
        : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      ctx.fillText(label, x, plot.y + plot.h + 8);
    }

    this.drawHover(s, plot, width, height);
  }

  drawHover(s, plot, width, height) {
    const index = this.hoverIndex;
    if (index < 0 || index >= this.points.length) return;
    const { ctx } = this;
    const point = this.points[index];
    const x = s.x(point.ts);
    const y = s.y(point.avg);
    const decimals = this.meta ? (this.meta.decimals ?? 1) : 1;
    const unit = this.meta ? this.meta.unit || "" : "";

    ctx.strokeStyle = this.colors.muted;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, plot.y);
    ctx.lineTo(x + 0.5, plot.y + plot.h);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.accent;
    ctx.fill();
    ctx.strokeStyle = this.colors.surface;
    ctx.lineWidth = 2;
    ctx.stroke();

    const date = new Date(point.ts);
    const timeText = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const valueText = `${Number(point.avg).toLocaleString("vi-VN", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}${unit ? ` ${unit}` : ""}`;
    const lines = [timeText, valueText];
    if (
      Number.isFinite(point.min) &&
      Number.isFinite(point.max) &&
      point.max - point.min > 1e-9
    ) {
      lines.push(
        `min ${Number(point.min).toLocaleString("vi-VN", { maximumFractionDigits: decimals })} · max ${Number(point.max).toLocaleString("vi-VN", { maximumFractionDigits: decimals })}`,
      );
    }

    ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const boxWidth =
      Math.max(...lines.map((line) => ctx.measureText(line).width)) + 20;
    const boxHeight = lines.length * 16 + 12;
    let boxX = x + 12;
    if (boxX + boxWidth > width - 4) boxX = x - boxWidth - 12;
    let boxY = Math.min(
      plot.y + plot.h - boxHeight,
      Math.max(plot.y, y - boxHeight / 2),
    );

    ctx.fillStyle = this.colors.surface;
    ctx.strokeStyle = this.colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 8);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? this.colors.muted : this.colors.text;
      ctx.fillText(line, boxX + 10, boxY + 8 + i * 16);
    });
  }

  handlePointer(event) {
    if (!this.points.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const { plot } = this.layout();
    const s = this.scales(this.points, plot);
    let best = 0;
    let bestDistance = Infinity;
    this.points.forEach((p, i) => {
      const distance = Math.abs(s.x(p.ts) - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    if (best !== this.hoverIndex) {
      this.hoverIndex = best;
      this.render();
    }
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}
