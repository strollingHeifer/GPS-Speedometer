/**
 * @fileoverview Hybrid GNSS Velocity, Signal Confidence, Outlier Filtering & Trip Telemetry Engine.
 * Implements Hardware Doppler priority, Accuracy-Gated Haversine fallback with EMA smoothing,
 * Multipath Spike Rejection, Stationary Deadzone, 4s Staleness Watchdog, and Hybrid Compass Heading.
 */

export const MPS_TO_KMH = 3.6;
export const MPS_TO_MPH = 2.2369362920544;
export const METERS_TO_FEET = 3.280839895;

/**
 * Converts speed in meters per second to target display unit ('kmh' or 'mph').
 * @param {number} mps
 * @param {'kmh'|'mph'} [unit='kmh']
 * @returns {number}
 */
export function mpsToUnit(mps, unit = 'kmh') {
  if (!Number.isFinite(mps)) return 0;
  return unit === 'mph' ? mps * MPS_TO_MPH : mps * MPS_TO_KMH;
}

/**
 * Converts speed from display unit ('kmh' or 'mph') to meters per second.
 * @param {number} val
 * @param {'kmh'|'mph'} [unit='kmh']
 * @returns {number}
 */
export function unitToMps(val, unit = 'kmh') {
  if (!Number.isFinite(val)) return 0;
  return unit === 'mph' ? val / MPS_TO_MPH : val / MPS_TO_KMH;
}

/**
 * Converts distance/altitude in meters to target unit system ('m' for kmh, 'ft' for mph).
 * @param {number|null|undefined} meters
 * @param {'kmh'|'mph'} [unit='kmh']
 * @returns {number|null}
 */
export function metersToUnit(meters, unit = 'kmh') {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) {
    return null;
  }
  return unit === 'mph' ? meters * METERS_TO_FEET : meters;
}

/**
 * Formats a bearing in degrees (0-360) into an 8-wind cardinal direction.
 * @param {number|null|undefined} deg
 * @returns {string}
 */
export function formatCardinal(deg) {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) {
    return '--';
  }
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = ((deg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return directions[index];
}

/**
 * Computes geodesic distance in meters between two WGS84 coordinates using the IUGG mean radius.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371008.8; // Mean Earth radius in meters (IUGG)
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Evaluates multi-factor GNSS measurement confidence (0-100%) and semantic tier.
 * @param {Object} params
 * @param {number} params.accuracyMeters
 * @param {number} params.updateHz
 * @param {number} params.fixAgeSeconds
 * @param {string} params.speedSource
 * @returns {{ score: number, tier: 'excellent'|'good'|'fair'|'poor', label: string }}
 */
export function evaluateSignalConfidence({ accuracyMeters, updateHz, fixAgeSeconds, speedSource }) {
  if (!Number.isFinite(accuracyMeters) || fixAgeSeconds > 6) {
    return { score: 12, tier: 'poor', label: 'Poor / Stale Fix', shortLabel: 'Stale Fix' };
  }
  const accScore = Math.max(0, Math.min(100, 100 - (accuracyMeters - 3) * 2.8));
  const hzScore = Math.max(0, Math.min(100, (updateHz / 1.0) * 100));
  const agePenalty = fixAgeSeconds > 2.5 ? Math.min(40, (fixAgeSeconds - 2.5) * 12) : 0;
  const sourceBonus = speedSource === 'doppler' ? 8 : 0;

  const raw = 0.65 * accScore + 0.27 * hzScore + sourceBonus - agePenalty;
  const score = Math.round(Math.max(5, Math.min(100, raw)));

  let tier = 'poor';
  let label = 'Poor Signal';
  let shortLabel = 'Poor Signal';
  if (accuracyMeters <= 5.5 && updateHz >= 0.75 && fixAgeSeconds <= 2.5) {
    tier = 'excellent';
    label = 'Excellent (High Precision)';
    shortLabel = 'Excellent';
  } else if (accuracyMeters <= 12 && updateHz >= 0.35 && fixAgeSeconds <= 3.5) {
    tier = 'good';
    label = 'Good (Reliable GNSS)';
    shortLabel = 'Good Signal';
  } else if (accuracyMeters <= 30 && fixAgeSeconds <= 5.0) {
    tier = 'fair';
    label = 'Fair (Moderate Accuracy)';
    shortLabel = 'Fair Signal';
  }
  return { score, tier, label, shortLabel };
}

/**
 * Infers the active GNSS constellation lock quality from observable Web Geolocation metrics
 * (horizontal accuracy, 3D altitude availability, update cadence Hz, fix age, and Doppler velocity).
 * @param {Object} params
 * @param {number|null} params.accuracyMeters
 * @param {number|null} params.altitudeMeters
 * @param {number} params.updateHz
 * @param {number} params.fixAgeSeconds
 * @param {string} params.speedSource
 * @returns {{ state: string, label: string }}
 */
export function evaluateGnssLockState({
  accuracyMeters,
  altitudeMeters,
  updateHz,
  fixAgeSeconds,
  speedSource,
}) {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters === null) {
    return { state: 'awaiting', label: 'Awaiting Fix' };
  }
  if (fixAgeSeconds > 6) {
    return { state: 'stale', label: 'Signal Lost / Stale (>6s)' };
  }
  const has3dAltitude = altitudeMeters !== null && Number.isFinite(altitudeMeters);
  if (accuracyMeters <= 5.5 && updateHz >= 0.75 && speedSource === 'doppler') {
    return has3dAltitude
      ? { state: '3d-doppler', label: '3D Multi-GNSS Doppler Lock' }
      : { state: '2d-doppler', label: 'High-Precision Doppler Lock' };
  }
  if (accuracyMeters <= 12 && updateHz >= 0.35) {
    return has3dAltitude
      ? { state: '3d-gnss', label: 'Active 3D GNSS Lock' }
      : { state: '2d-gnss', label: 'Active 2D GNSS Lock' };
  }
  if (accuracyMeters <= 30 && fixAgeSeconds <= 5.0) {
    return { state: 'degraded-gnss', label: 'Degraded / Multipath GNSS' };
  }
  return { state: 'coarse-network', label: 'Coarse Cell / Wi-Fi Fallback' };
}

/**
 * Stateful Telemetry Engine managing velocity filtering, trip statistics,
 * staleness decay, and hybrid compass heading.
 */
export class TelemetryEngine {
  constructor(options = {}) {
    this.options = options;
    this.reset();
  }

  /**
   * Resets all session statistics and filter state.
   * @param {number} [nowMs=Date.now()]
   */
  reset(nowMs = Date.now()) {
    this.currentSpeedMps = 0;
    this.speedSource = 'none';
    this.isSimulated = false;
    this.maxSpeedMps = 0;
    this.totalDistanceMeters = 0;
    this.activeDurationMs = 0;
    this.startTimeMs = null;
    this.lastFix = null;
    this.lastFixTimeMs = null;
    this.lastAcceptedFixTimeMs = null;
    this.lastWatchdogTickMs = null;
    this.fixIntervals = [];
    this.updateHz = 0;
    this.recentPositions = [];
    this.emaSpeedMps = 0;
    this.headingDeg = null;
    this.lastGpsCourseDeg = null;
    this.headingSource = 'none';
    this.compassHeadingDeg = null;
    this.altitudeMeters = null;
    this.altitudeAccuracyMeters = null;
    this.accuracyMeters = null;
    this.isStale = false;
    this.spikeRejected = false;
    this.history = [];
    return this.getSnapshot(nowMs);
  }

  /**
   * Zeroes live instantaneous speed when pausing or stopping simulation while preserving session statistics.
   * @param {number} [nowMs=Date.now()]
   */
  pause(nowMs = Date.now()) {
    this.currentSpeedMps = 0;
    this.emaSpeedMps = 0;
    this.speedSource = 'none';
    this.isSimulated = false;
    this.isStale = false;
    this.spikeRejected = false;
    return this.getSnapshot(nowMs);
  }

  /**
   * Updates device magnetometer heading from DeviceOrientationEvent.
   * Used when stationary (< 0.8 m/s) and no prior GPS course is locked, or as fallback.
   * @param {number|null} deg
   */
  updateCompassHeading(deg) {
    if (deg === null || deg === undefined || !Number.isFinite(deg)) {
      return;
    }
    this.compassHeadingDeg = ((deg % 360) + 360) % 360;
    if (this.currentSpeedMps < 0.8 && this.lastGpsCourseDeg === null) {
      this.headingDeg = this.compassHeadingDeg;
      this.headingSource = 'Compass';
    }
  }

  /**
   * Processes a W3C GeolocationPosition fix through the telemetry pipeline.
   * @param {Object} position
   * @param {number} [nowMs]
   * @returns {Object} Telemetry snapshot
   */
  processPosition(position, nowMs = position?.timestamp ?? Date.now()) {
    const coords = position?.coords || {};
    const fixTimeMs = Number.isFinite(nowMs)
      ? nowMs
      : Number.isFinite(position?.timestamp)
        ? position.timestamp
        : Date.now();

    this.isSimulated = Boolean(position?.isSimulated);
    this.isStale = false;
    this.spikeRejected = false;

    if (this.startTimeMs === null) {
      this.startTimeMs = fixTimeMs;
    }

    const dtSeconds =
      this.lastFixTimeMs !== null ? Math.max(0, (fixTimeMs - this.lastFixTimeMs) / 1000) : 0;
    const acceptedDtSeconds =
      this.lastAcceptedFixTimeMs !== null
        ? Math.max(0, (fixTimeMs - this.lastAcceptedFixTimeMs) / 1000)
        : dtSeconds;

    // Background Gap Guard: if > 15s elapsed (e.g., tab backgrounded), reset derivative window
    const isBackgroundGap = dtSeconds > 15 || acceptedDtSeconds > 15;
    if (isBackgroundGap) {
      this.recentPositions = [];
      this.fixIntervals = [];
      this.emaSpeedMps = 0;
    }

    // Update rolling fix frequency (Hz)
    if (this.lastFixTimeMs !== null && dtSeconds > 0.05 && !isBackgroundGap) {
      this.fixIntervals.push(dtSeconds);
      if (this.fixIntervals.length > 6) {
        this.fixIntervals.shift();
      }
      const avgDt =
        this.fixIntervals.reduce((sum, val) => sum + val, 0) / this.fixIntervals.length;
      this.updateHz = Number((1 / avgDt).toFixed(2));
    } else if (this.fixIntervals.length === 0) {
      this.updateHz = 1.0;
    }

    const currAcc =
      Number.isFinite(coords.accuracy) && coords.accuracy > 0 ? coords.accuracy : 10;
    this.accuracyMeters = currAcc;

    if (coords.altitude !== null && coords.altitude !== undefined && Number.isFinite(coords.altitude)) {
      this.altitudeMeters = coords.altitude;
    }
    if (
      coords.altitudeAccuracy !== null &&
      coords.altitudeAccuracy !== undefined &&
      Number.isFinite(coords.altitudeAccuracy)
    ) {
      this.altitudeAccuracyMeters = coords.altitudeAccuracy;
    }

    const hasLatLon =
      Number.isFinite(coords.latitude) && Number.isFinite(coords.longitude);
    const stepDistMeters =
      this.lastFix && hasLatLon && Number.isFinite(this.lastFix.latitude) && Number.isFinite(this.lastFix.longitude)
        ? haversineMeters(
            this.lastFix.latitude,
            this.lastFix.longitude,
            coords.latitude,
            coords.longitude
          )
        : 0;

    // 1. Hybrid Velocity Calculation & Multipath Spike Filter
    const hasDoppler =
      typeof coords.speed === 'number' && !Number.isNaN(coords.speed) && coords.speed >= 0;

    let rawSpeedMps = 0;
    let rawSource = 'none';

    if (hasDoppler) {
      rawSpeedMps = coords.speed;
      rawSource = 'doppler';
    } else {
      rawSource = 'haversine';
      if (this.lastFix && acceptedDtSeconds > 0 && !isBackgroundGap) {
        const prevAcc = this.lastFix.accuracy ?? currAcc;
        const accuracyGate = 0.55 * Math.max(prevAcc, currAcc);
        const passesGate = stepDistMeters > accuracyGate || this.currentSpeedMps > 1.2;
        rawSpeedMps = passesGate ? stepDistMeters / acceptedDtSeconds : 0;
      } else {
        rawSpeedMps = 0;
      }
    }

    // 2. Outlier & Multipath Spike Filter (> 15 m/s^2 with horizontal accuracy > 15m)
    // Evaluated against rawSpeedMps and time since last accepted fix before EMA smoothing
    if (this.lastFix && acceptedDtSeconds > 0 && !isBackgroundGap) {
      const accelMps2 = Math.abs(rawSpeedMps - this.currentSpeedMps) / acceptedDtSeconds;
      if (accelMps2 > 15 && currAcc > 15) {
        this.spikeRejected = true;
      }
    }

    let candidateSpeedMps = this.currentSpeedMps;
    if (!this.spikeRejected) {
      if (hasDoppler) {
        candidateSpeedMps = rawSpeedMps;
      } else if (this.lastFix && acceptedDtSeconds > 0 && !isBackgroundGap) {
        const alpha = 0.35;
        candidateSpeedMps = this.lastFix.hadVelocity
          ? alpha * rawSpeedMps + (1 - alpha) * this.emaSpeedMps
          : rawSpeedMps;
      } else {
        candidateSpeedMps = 0;
      }
    }

    // Update 3-second recent position window for stationary deadzone check (only on non-rejected fixes)
    if (hasLatLon && !this.spikeRejected) {
      this.recentPositions.push({
        latitude: coords.latitude,
        longitude: coords.longitude,
        timestamp: fixTimeMs,
        accuracy: currAcc,
      });
      const windowCutoff = fixTimeMs - 3000;
      while (
        this.recentPositions.length > 1 &&
        this.recentPositions[0].timestamp < windowCutoff
      ) {
        this.recentPositions.shift();
      }
    }

    // 3. Stationary Deadzone (< 0.45 m/s clamped to 0 when 3s displacement is within accuracy circle)
    const oldestPos = this.recentPositions[0];
    const net3sDisplacement =
      oldestPos && hasLatLon && !this.spikeRejected
        ? haversineMeters(
            oldestPos.latitude,
            oldestPos.longitude,
            coords.latitude,
            coords.longitude
          )
        : 0;

    if (!this.spikeRejected) {
      if (candidateSpeedMps < 0.45 && net3sDisplacement <= currAcc) {
        candidateSpeedMps = 0;
        this.emaSpeedMps = 0;
      } else {
        this.emaSpeedMps = candidateSpeedMps;
      }
    }

    this.currentSpeedMps = Math.max(0, candidateSpeedMps);
    this.speedSource = rawSource;

    // 4. Session Statistics (Max Speed, Distance, Active Duration)
    if (!this.spikeRejected && this.currentSpeedMps > this.maxSpeedMps) {
      this.maxSpeedMps = this.currentSpeedMps;
    }

    if (this.lastFix && acceptedDtSeconds > 0 && !isBackgroundGap && !this.spikeRejected) {
      this.activeDurationMs += acceptedDtSeconds * 1000;
      if (this.currentSpeedMps > 0) {
        const distDelta =
          stepDistMeters > 0 ? stepDistMeters : this.currentSpeedMps * acceptedDtSeconds;
        this.totalDistanceMeters += distDelta;
      }
    }

    // 5. Hybrid Compass Heading (GPS COG >= 0.8 m/s -> Last Course -> Compass Fallback)
    const hasGpsHeading =
      coords.heading !== null &&
      coords.heading !== undefined &&
      Number.isFinite(coords.heading) &&
      coords.heading >= 0;

    if (!this.spikeRejected) {
      if (this.currentSpeedMps >= 0.8 && hasGpsHeading) {
        this.headingDeg = ((coords.heading % 360) + 360) % 360;
        this.lastGpsCourseDeg = this.headingDeg;
        this.headingSource = 'GPS COG';
      } else if (this.currentSpeedMps < 0.8) {
        if (this.lastGpsCourseDeg !== null) {
          this.headingDeg = this.lastGpsCourseDeg;
          this.headingSource = 'Last Course';
        } else if (this.compassHeadingDeg !== null) {
          this.headingDeg = this.compassHeadingDeg;
          this.headingSource = 'Compass';
        }
      } else if (hasGpsHeading) {
        this.headingDeg = ((coords.heading % 360) + 360) % 360;
        this.lastGpsCourseDeg = this.headingDeg;
        this.headingSource = 'GPS COG';
      }

      this.lastFix = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: currAcc,
        hadVelocity: this.currentSpeedMps > 0,
      };
      this.lastAcceptedFixTimeMs = fixTimeMs;
    }

    this.lastFixTimeMs = fixTimeMs;
    this.lastWatchdogTickMs = fixTimeMs;

    this._pushHistory(fixTimeMs, this.currentSpeedMps);
    return this.getSnapshot(fixTimeMs);
  }

  /**
   * Monitors fix staleness; if > 4000ms since last fix, marks signal stale and decays velocity toward 0.
   * @param {number} [nowMs=Date.now()]
   * @returns {Object} Telemetry snapshot
   */
  tickWatchdog(nowMs = Date.now()) {
    if (this.lastFixTimeMs !== null && nowMs - this.lastFixTimeMs > 4000) {
      this.isStale = true;
      const prevTick = this.lastWatchdogTickMs ?? this.lastFixTimeMs + 4000;
      const decayDtSec = Math.max(0.2, (nowMs - prevTick) / 1000);
      this.currentSpeedMps = this.currentSpeedMps * Math.pow(0.55, decayDtSec);
      if (this.currentSpeedMps < 0.15) {
        this.currentSpeedMps = 0;
      }
      this.emaSpeedMps = this.currentSpeedMps;
      this.lastWatchdogTickMs = nowMs;
      this._pushHistory(nowMs, this.currentSpeedMps);
    }
    return this.getSnapshot(nowMs);
  }

  /**
   * Appends a speed sample to the rolling 65-second history buffer.
   * @param {number} timestamp
   * @param {number} speedMps
   * @private
   */
  _pushHistory(timestamp, speedMps) {
    this.history.push({ timestamp, speedMps });
    const cutoff = timestamp - 65000;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }
  }

  /**
   * Returns a complete immutable-style telemetry state snapshot.
   * @param {number} [nowMs=Date.now()]
   * @returns {Object}
   */
  getSnapshot(nowMs = Date.now()) {
    const fixAgeSeconds =
      this.lastFixTimeMs !== null ? Math.max(0, (nowMs - this.lastFixTimeMs) / 1000) : Infinity;

    const confidence = evaluateSignalConfidence({
      accuracyMeters: this.accuracyMeters ?? NaN,
      updateHz: this.updateHz,
      fixAgeSeconds,
      speedSource: this.speedSource,
    });

    const lockState = evaluateGnssLockState({
      accuracyMeters: this.accuracyMeters ?? NaN,
      altitudeMeters: this.altitudeMeters,
      updateHz: this.updateHz,
      fixAgeSeconds,
      speedSource: this.speedSource,
    });

    const elapsedMs =
      this.startTimeMs !== null ? Math.max(0, nowMs - this.startTimeMs) : 0;

    const avgSpeedMps =
      this.activeDurationMs > 1000
        ? this.totalDistanceMeters / (this.activeDurationMs / 1000)
        : 0;

    return {
      speedMps: this.currentSpeedMps,
      speedSource: this.speedSource,
      isSimulated: this.isSimulated,
      accuracyMeters: this.accuracyMeters,
      altitudeMeters: this.altitudeMeters,
      altitudeAccuracyMeters: this.altitudeAccuracyMeters,
      headingDeg: this.headingDeg,
      headingCardinal: formatCardinal(this.headingDeg),
      headingSource: this.headingSource,
      updateHz: this.updateHz,
      fixAgeSeconds,
      isStale: this.isStale,
      spikeRejected: this.spikeRejected,
      confidence,
      lockState,
      maxSpeedMps: this.maxSpeedMps,
      avgSpeedMps,
      totalDistanceMeters: this.totalDistanceMeters,
      elapsedMs,
      history: this.history.slice(),
    };
  }
}
