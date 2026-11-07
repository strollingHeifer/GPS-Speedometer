// js/charts.js — 240° SVG Radial Gauge Controller & High-DPI 60-Second Canvas Sparkline Renderer

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Converts polar angle (where 0° is straight up 12 o'clock, -120° is bottom-left, +120° is bottom-right)
 * to Cartesian SVG coordinates around (cx, cy).
 */
export function polarToCartesian(cx, cy, radius, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad)
  };
}

/**
 * Generates an SVG path 'd' attribute for a circular arc from startAngleDeg to endAngleDeg.
 */
export function describeSvgArc(cx, cy, radius, startAngleDeg, endAngleDeg) {
  const clampedEnd = Math.max(startAngleDeg + 0.01, Math.min(endAngleDeg, startAngleDeg + 359.9));
  const start = polarToCartesian(cx, cy, radius, startAngleDeg);
  const end = polarToCartesian(cx, cy, radius, clampedEnd);
  const largeArcFlag = clampedEnd - startAngleDeg <= 180 ? '0' : '1';
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/**
 * Chooses an auto-ranging ceiling scale based on current unit, current speed, and active threshold.
 * km/h scales: [60, 120, 180, 240]
 * mph scales:  [40, 80, 120, 160]
 */
export function selectGaugeCeiling(speedInUnit, thresholdInUnit, unit = 'kmh') {
  const scales = unit === 'mph' ? [40, 80, 120, 160] : [60, 120, 180, 240];
  const reference = Math.max(speedInUnit || 0, (thresholdInUnit || 0) * 1.05);
  for (const ceiling of scales) {
    if (reference <= ceiling * 0.88) {
      return ceiling;
    }
  }
  return scales[scales.length - 1];
}

export class RadialGaugeView {
  /**
   * @param {SVGSVGElement} svgEl - The #radial-gauge-svg element (viewBox="0 0 320 265")
   */
  constructor(svgEl) {
    this.svg = svgEl;
    this.cx = 160;
    this.cy = 152;
    this.radius = 126;
    this.startAngle = -120;
    this.endAngle = 120;
    this.sweepAngle = 240;
    this.currentCeiling = null;
    this.currentUnit = null;

    this._initSvgStructure();
  }

  _initSvgStructure() {
    if (!this.svg) return;
    this.svg.innerHTML = '';

    // Track Arc (-120° to +120°)
    this.trackPath = document.createElementNS(SVG_NS, 'path');
    this.trackPath.setAttribute('class', 'gauge-track-arc');
    this.trackPath.setAttribute(
      'd',
      describeSvgArc(this.cx, this.cy, this.radius, this.startAngle, this.endAngle)
    );

    // Threshold Warning Zone Arc (from threshold angle to +120°)
    this.limitZonePath = document.createElementNS(SVG_NS, 'path');
    this.limitZonePath.setAttribute('class', 'gauge-limit-zone-arc');

    // Active Value Arc
    this.valuePath = document.createElementNS(SVG_NS, 'path');
    this.valuePath.setAttribute('class', 'gauge-value-arc');

    // Ticks & Labels Group
    this.ticksGroup = document.createElementNS(SVG_NS, 'g');
    this.ticksGroup.setAttribute('class', 'gauge-ticks-group');

    // Threshold Marker Group (Tick + Pill along perimeter)
    this.thresholdGroup = document.createElementNS(SVG_NS, 'g');
    this.thresholdGroup.setAttribute('class', 'gauge-threshold-marker');
    this.thresholdGroup.setAttribute('visibility', 'hidden');

    this.thresholdLine = document.createElementNS(SVG_NS, 'line');
    this.thresholdLine.setAttribute('class', 'gauge-threshold-tick');

    this.thresholdDot = document.createElementNS(SVG_NS, 'circle');
    this.thresholdDot.setAttribute('class', 'gauge-threshold-dot');
    this.thresholdDot.setAttribute('r', '5.5');

    this.thresholdPillGroup = document.createElementNS(SVG_NS, 'g');
    this.thresholdPillBg = document.createElementNS(SVG_NS, 'rect');
    this.thresholdPillBg.setAttribute('class', 'gauge-threshold-pill-bg');
    this.thresholdPillBg.setAttribute('rx', '8');
    this.thresholdPillBg.setAttribute('ry', '8');
    this.thresholdPillBg.setAttribute('width', '34');
    this.thresholdPillBg.setAttribute('height', '16');
    this.thresholdPillBg.setAttribute('x', '-17');
    this.thresholdPillBg.setAttribute('y', '-8');

    this.thresholdPillText = document.createElementNS(SVG_NS, 'text');
    this.thresholdPillText.setAttribute('class', 'gauge-threshold-pill-text');
    this.thresholdPillText.setAttribute('text-anchor', 'middle');
    this.thresholdPillText.setAttribute('dominant-baseline', 'central');

    this.thresholdPillGroup.appendChild(this.thresholdPillBg);
    this.thresholdPillGroup.appendChild(this.thresholdPillText);
    this.thresholdGroup.appendChild(this.thresholdLine);
    this.thresholdGroup.appendChild(this.thresholdDot);
    this.thresholdGroup.appendChild(this.thresholdPillGroup);

    // Current Speed Tip Indicator Dot
    this.tipDot = document.createElementNS(SVG_NS, 'circle');
    this.tipDot.setAttribute('class', 'gauge-tip-dot');
    this.tipDot.setAttribute('r', '5.5');

    this.svg.appendChild(this.trackPath);
    this.svg.appendChild(this.limitZonePath);
    this.svg.appendChild(this.ticksGroup);
    this.svg.appendChild(this.valuePath);
    this.svg.appendChild(this.thresholdGroup);
    this.svg.appendChild(this.tipDot);
  }

  _renderTicks(ceiling) {
    if (!this.ticksGroup) return;
    this.ticksGroup.innerHTML = '';

    const majorSteps = 6; // e.g., 0, 20, 40, 60, 80, 100, 120
    const minorPerMajor = 4;
    const totalTicks = majorSteps * minorPerMajor;

    for (let i = 0; i <= totalTicks; i++) {
      const ratio = i / totalTicks;
      const angle = this.startAngle + ratio * this.sweepAngle;
      const isMajor = i % minorPerMajor === 0;

      const outerR = this.radius - 10;
      const innerR = isMajor ? this.radius - 17 : this.radius - 14;
      const p1 = polarToCartesian(this.cx, this.cy, outerR, angle);
      const p2 = polarToCartesian(this.cx, this.cy, innerR, angle);

      const tick = document.createElementNS(SVG_NS, 'line');
      tick.setAttribute('x1', p1.x.toFixed(2));
      tick.setAttribute('y1', p1.y.toFixed(2));
      tick.setAttribute('x2', p2.x.toFixed(2));
      tick.setAttribute('y2', p2.y.toFixed(2));
      tick.setAttribute('class', isMajor ? 'gauge-tick-major' : 'gauge-tick-minor');
      this.ticksGroup.appendChild(tick);

      if (isMajor) {
        const labelVal = Math.round(ratio * ceiling);
        const labelPos = polarToCartesian(this.cx, this.cy, this.radius - 27, angle);
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', labelPos.x.toFixed(2));
        text.setAttribute('y', labelPos.y.toFixed(2));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('class', 'gauge-tick-label');
        text.textContent = String(labelVal);
        this.ticksGroup.appendChild(text);
      }
    }
  }

  /**
   * Updates the radial gauge arc, ticks, and speed threshold marker.
   */
  render({
    speedInUnit = 0,
    unit = 'kmh',
    thresholdInUnit = 80,
    thresholdEnabled = true,
    isOverLimit = false
  }) {
    if (!this.svg) return;

    const ceiling = selectGaugeCeiling(
      speedInUnit,
      thresholdEnabled ? thresholdInUnit : 0,
      unit
    );

    if (ceiling !== this.currentCeiling || unit !== this.currentUnit) {
      this.currentCeiling = ceiling;
      this.currentUnit = unit;
      this._renderTicks(ceiling);
    }

    const clampedSpeed = Math.max(0, Math.min(ceiling, speedInUnit));
    const speedRatio = clampedSpeed / ceiling;
    const speedAngle = this.startAngle + speedRatio * this.sweepAngle;

    if (clampedSpeed <= 0.05) {
      this.valuePath.setAttribute('d', '');
      const startPt = polarToCartesian(this.cx, this.cy, this.radius, this.startAngle);
      this.tipDot.setAttribute('cx', startPt.x.toFixed(2));
      this.tipDot.setAttribute('cy', startPt.y.toFixed(2));
    } else {
      this.valuePath.setAttribute(
        'd',
        describeSvgArc(this.cx, this.cy, this.radius, this.startAngle, speedAngle)
      );
      const tipPt = polarToCartesian(this.cx, this.cy, this.radius, speedAngle);
      this.tipDot.setAttribute('cx', tipPt.x.toFixed(2));
      this.tipDot.setAttribute('cy', tipPt.y.toFixed(2));
    }

    this.svg.classList.toggle('gauge-over-limit', Boolean(isOverLimit));

    // Render Speed Threshold Tick & Pill Marker
    if (thresholdEnabled && Number.isFinite(thresholdInUnit) && thresholdInUnit > 0) {
      const clampedThreshold = Math.max(0, Math.min(ceiling, thresholdInUnit));
      const threshRatio = clampedThreshold / ceiling;
      const threshAngle = this.startAngle + threshRatio * this.sweepAngle;

      const tInner = polarToCartesian(this.cx, this.cy, this.radius - 11, threshAngle);
      const tOuter = polarToCartesian(this.cx, this.cy, this.radius + 11, threshAngle);
      const tMid = polarToCartesian(this.cx, this.cy, this.radius, threshAngle);
      const pillPos = polarToCartesian(this.cx, this.cy, this.radius + 24, threshAngle);

      this.thresholdLine.setAttribute('x1', tInner.x.toFixed(2));
      this.thresholdLine.setAttribute('y1', tInner.y.toFixed(2));
      this.thresholdLine.setAttribute('x2', tOuter.x.toFixed(2));
      this.thresholdLine.setAttribute('y2', tOuter.y.toFixed(2));

      this.thresholdDot.setAttribute('cx', tMid.x.toFixed(2));
      this.thresholdDot.setAttribute('cy', tMid.y.toFixed(2));

      this.thresholdPillGroup.setAttribute(
        'transform',
        `translate(${pillPos.x.toFixed(2)}, ${pillPos.y.toFixed(2)})`
      );
      this.thresholdPillText.textContent = String(Math.round(thresholdInUnit));
      this.thresholdGroup.setAttribute('visibility', 'visible');

      if (threshAngle < this.endAngle - 1) {
        this.limitZonePath.setAttribute(
          'd',
          describeSvgArc(this.cx, this.cy, this.radius, threshAngle, this.endAngle)
        );
      } else {
        this.limitZonePath.setAttribute('d', '');
      }
    } else {
      this.thresholdGroup.setAttribute('visibility', 'hidden');
      this.limitZonePath.setAttribute('d', '');
    }

    return ceiling;
  }
}

export class SparklineCanvasView {
  /**
   * @param {HTMLCanvasElement} canvasEl - The #sparkline-canvas element
   */
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl ? canvasEl.getContext('2d') : null;
    this.windowMs = 60000; // 60-second rolling window
  }

  _resolveCssColor(varName, fallback) {
    if (typeof window === 'undefined' || !document.documentElement) return fallback;
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return val || fallback;
  }

  /**
   * Renders the rolling 60-second speed history on a High-DPI canvas with
   * a horizontal dashed Speed Limit Reference Line and M3 Error highlighting on over-limit segments.
   *
   * @param {Object} options
   * @param {Array<{timestamp: number, speedMps: number}>} options.history
   * @param {number} options.nowMs
   * @param {function(number): number} options.convertMps - Function converting m/s to active display unit
   * @param {number} options.thresholdInUnit - Active threshold in current unit
   * @param {boolean} options.thresholdEnabled - Whether threshold line & highlighting are active
   * @param {string} options.unitLabel - 'km/h' or 'mph'
   */
  render({
    history = [],
    nowMs = Date.now(),
    convertMps = (v) => v * 3.6,
    thresholdInUnit = 80,
    thresholdEnabled = true,
    unitLabel = 'km/h'
  }) {
    if (!this.canvas || !this.ctx) return { peakSpeed: 0 };

    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(240, rect.width || 320);
    const cssHeight = Math.max(100, rect.height || 128);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const targetWidth = Math.round(cssWidth * dpr);
    const targetHeight = Math.round(cssHeight * dpr);

    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const primaryColor = this._resolveCssColor('--md-sys-color-primary', '#006874');
    const errorColor = this._resolveCssColor('--md-sys-color-error', '#ba1a1a');
    const outlineVariant = this._resolveCssColor('--md-sys-color-outline-variant', '#bfc8ca');
    const onSurfaceVariant = this._resolveCssColor('--md-sys-color-on-surface-variant', '#3f484a');

    const padLeft = 34;
    const padRight = 10;
    const padTop = 12;
    const padBottom = 20;
    const plotW = cssWidth - padLeft - padRight;
    const plotH = cssHeight - padTop - padBottom;

    // Filter samples to last 60s
    const startMs = nowMs - this.windowMs;
    const points = [];
    let peakSpeed = 0;

    for (const sample of history) {
      if (sample.timestamp >= startMs - 2000) {
        const val = Math.max(0, convertMps(sample.speedMps));
        if (val > peakSpeed) peakSpeed = val;
        points.push({ timestamp: sample.timestamp, speed: val });
      }
    }

    const minCeiling = unitLabel === 'mph' ? 30 : 50;
    const maxRef = Math.max(
      minCeiling,
      peakSpeed * 1.15,
      thresholdEnabled && thresholdInUnit > 0 ? thresholdInUnit * 1.18 : 0
    );
    const yCeiling = Math.ceil(maxRef / 10) * 10;

    const toX = (ts) => {
      const clampedTs = Math.max(startMs, Math.min(nowMs, ts));
      return padLeft + ((clampedTs - startMs) / this.windowMs) * plotW;
    };
    const toY = (spd) => {
      const clampedSpd = Math.max(0, Math.min(yCeiling, spd));
      return padTop + plotH - (clampedSpd / yCeiling) * plotH;
    };

    // Horizontal subtle grid lines (0%, 50%, 100%)
    ctx.strokeStyle = outlineVariant;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.font = '600 10px "Google Sans Mono", "Noto Sans Mono", monospace';
    ctx.fillStyle = onSurfaceVariant;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const frac of [0, 0.5, 1]) {
      const val = Math.round(yCeiling * frac);
      const y = toY(val);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.globalAlpha = 0.85;
      ctx.fillText(String(val), padLeft - 6, y);
      ctx.globalAlpha = 0.45;
    }

    // Time axis labels (-60s, -30s, Now)
    ctx.globalAlpha = 0.8;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('-60s', padLeft, padTop + plotH + 5);
    ctx.textAlign = 'center';
    ctx.fillText('-30s', padLeft + plotW * 0.5, padTop + plotH + 5);
    ctx.textAlign = 'right';
    ctx.fillText('Now', padLeft + plotW, padTop + plotH + 5);

    // Speed Limit Reference Line (dashed)
    if (thresholdEnabled && thresholdInUnit > 0 && thresholdInUnit <= yCeiling) {
      const limitY = toY(thresholdInUnit);
      ctx.save();
      ctx.strokeStyle = errorColor;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padLeft, limitY);
      ctx.lineTo(padLeft + plotW, limitY);
      ctx.stroke();
      ctx.restore();
    }

    // Plot Speed Curve & Area Fill
    if (points.length >= 2) {
      const coords = points.map((p) => ({
        x: toX(p.timestamp),
        y: toY(p.speed),
        speed: p.speed
      }));

      // Soft gradient under curve
      const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      areaGrad.addColorStop(0, primaryColor);
      areaGrad.addColorStop(1, 'rgba(0, 104, 116, 0.0)');

      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = areaGrad;
      ctx.beginPath();
      ctx.moveTo(coords[0].x, padTop + plotH);
      for (const pt of coords) {
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.lineTo(coords[coords.length - 1].x, padTop + plotH);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Base curve in M3 Primary color
      ctx.save();
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      coords.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
      ctx.restore();

      // Highlight over-limit curve segments in M3 Error color using clip region above threshold Y
      if (thresholdEnabled && thresholdInUnit > 0 && peakSpeed > thresholdInUnit) {
        const limitY = toY(thresholdInUnit);
        ctx.save();
        ctx.beginPath();
        ctx.rect(padLeft, 0, plotW, limitY);
        ctx.clip();

        ctx.strokeStyle = errorColor;
        ctx.lineWidth = 3.0;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        coords.forEach((pt, idx) => {
          if (idx === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
        ctx.restore();
      }

      // Latest point dot
      const last = coords[coords.length - 1];
      const isLastOver = thresholdEnabled && thresholdInUnit > 0 && last.speed > thresholdInUnit;
      ctx.save();
      ctx.fillStyle = isLastOver ? errorColor : primaryColor;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      // Empty state message
      ctx.save();
      ctx.fillStyle = onSurfaceVariant;
      ctx.globalAlpha = 0.65;
      ctx.font = '500 12px "Google Sans", "Noto Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Live 60s velocity trace appears when tracking', padLeft + plotW / 2, padTop + plotH / 2);
      ctx.restore();
    }

    ctx.restore();
    return { peakSpeed };
  }
}
