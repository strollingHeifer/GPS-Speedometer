/**
 * @fileoverview Developer Demo & Telemetry Simulation Generator.
 * Hidden by default in the UI; unlocked via ?demo=1 / ?simulate=true or 5-tap gesture.
 * Generates realistic W3C GeolocationPosition fixes for City, Threshold Crossing,
 * Highway Cruise, Tunnel/Poor Signal, and Manual Override scenarios.
 */

import { MPS_TO_KMH } from './telemetry-engine.js';

/**
 * Checks whether the current URL query string unlocks Demo Mode (?demo=1 or ?simulate=true).
 * @param {string} [search]
 * @returns {boolean}
 */
export function isDemoUnlockedByUrl(
  search = typeof window !== 'undefined' ? window.location.search : ''
) {
  try {
    const params = new URLSearchParams(search);
    return (
      params.get('demo') === '1' ||
      params.get('demo') === 'true' ||
      params.get('simulate') === '1' ||
      params.get('simulate') === 'true'
    );
  } catch (_) {
    return false;
  }
}

/**
 * Creates a multi-tap detector (default: 5 taps within 3000ms) to unlock Developer Demo Mode.
 * Returns a function that can be invoked directly as an event handler or via `.registerTap()`.
 * @param {Object} [options]
 * @param {number} [options.requiredTaps=5]
 * @param {number} [options.windowMs=3000]
 * @param {function(): void} [options.onUnlock]
 * @returns {function(number=): boolean & { registerTap: function(number=): boolean, reset: function(): void }}
 */
export function createTapUnlockDetector({
  requiredTaps = 5,
  windowMs = 3000,
  onUnlock,
} = {}) {
  let tapTimestamps = [];
  let unlocked = false;

  function registerTap(nowMs = Date.now()) {
    const t = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
    tapTimestamps.push(t);
    const cutoff = t - windowMs;
    tapTimestamps = tapTimestamps.filter((ts) => ts >= cutoff);

    if (tapTimestamps.length >= requiredTaps) {
      tapTimestamps = [];
      unlocked = true;
      if (typeof onUnlock === 'function') {
        onUnlock();
      }
      return true;
    }
    return unlocked;
  }

  function reset() {
    tapTimestamps = [];
    unlocked = false;
  }

  registerTap.registerTap = registerTap;
  registerTap.reset = reset;
  return registerTap;
}

/**
 * Synthetic GNSS Telemetry Simulator supporting 5 deterministic & interactive scenarios.
 */
export class TelemetrySimulator {
  /**
   * @param {Object} [options]
   * @param {function(Object): void} [options.onPosition]
   * @param {function(Object): void} [options.onStatusChange]
   */
  constructor({ onPosition, onStatusChange } = {}) {
    this.onPosition = typeof onPosition === 'function' ? onPosition : null;
    this.onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : null;

    this.running = false;
    this.scenario = 'city';
    this.timerId = null;
    this.startTimeMs = 0;
    this.lastStepTimeMs = 0;

    // Default threshold in m/s (80 km/h = 22.22 m/s)
    this.thresholdMps = 80 / MPS_TO_KMH;

    // Manual override parameters
    this.manualParams = {
      speedKmh: 65,
      accuracyMeters: 4.0,
      rateHz: 1.0,
    };

    // Simulated geodesic coordinates (starting near San Francisco Embarcadero)
    this.latitude = 37.7955;
    this.longitude = -122.3937;
    this.altitude = 14.5;
    this.heading = 42;
  }

  /**
   * Updates the target speed threshold (in m/s) used by the 'threshold' crossing scenario.
   * @param {number} thresholdMps
   */
  setThresholdMps(thresholdMps) {
    if (Number.isFinite(thresholdMps) && thresholdMps > 0) {
      this.thresholdMps = thresholdMps;
    }
  }

  /**
   * Updates manual override parameters and reschedules timer if rateHz changed.
   * @param {Object} params
   * @param {number} [params.speedKmh]
   * @param {number} [params.accuracyMeters]
   * @param {number} [params.rateHz]
   */
  setManualParams({ speedKmh, accuracyMeters, rateHz } = {}) {
    let rateChanged = false;
    if (Number.isFinite(speedKmh) && speedKmh >= 0) {
      this.manualParams.speedKmh = speedKmh;
    }
    if (Number.isFinite(accuracyMeters) && accuracyMeters > 0) {
      this.manualParams.accuracyMeters = accuracyMeters;
    }
    if (Number.isFinite(rateHz) && rateHz >= 0.1 && rateHz <= 5) {
      if (Math.abs(this.manualParams.rateHz - rateHz) > 0.01) {
        rateChanged = true;
      }
      this.manualParams.rateHz = rateHz;
    }

    if (this.running && this.scenario === 'manual' && rateChanged) {
      this._scheduleLoop();
    }
  }

  /**
   * Starts the telemetry simulation for the specified scenario.
   * @param {'city'|'threshold'|'highway'|'tunnel'|'manual'} [scenario='city']
   */
  start(scenario = 'city') {
    this.stop();
    this.scenario = scenario;
    this.running = true;
    const now = Date.now();
    this.startTimeMs = now;
    this.lastStepTimeMs = now;

    if (this.onStatusChange) {
      this.onStatusChange({ running: true, scenario: this.scenario });
    }

    this._emitTick(now);
    this._scheduleLoop();
  }

  /**
   * Stops the active simulation timer.
   */
  stop() {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning && this.onStatusChange) {
      this.onStatusChange({ running: false, scenario: this.scenario });
    }
  }

  /**
   * Returns true if simulation is currently active.
   * @returns {boolean}
   */
  isRunning() {
    return this.running;
  }

  /**
   * Schedules the periodic fix emission interval according to scenario cadence.
   * @private
   */
  _scheduleLoop() {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (!this.running) return;

    let rateHz = 1.0;
    if (this.scenario === 'manual') {
      rateHz = this.manualParams.rateHz || 1.0;
    } else if (this.scenario === 'tunnel') {
      rateHz = 0.5;
    } else {
      rateHz = 1.0;
    }

    const intervalMs = Math.max(200, Math.round(1000 / rateHz));
    this.timerId = setInterval(() => {
      if (this.running) {
        this._emitTick(Date.now());
      }
    }, intervalMs);
  }

  /**
   * Generates a single synthetic GeolocationPosition fix and advances coordinates.
   * @param {number} [nowMs=Date.now()]
   * @returns {Object|null}
   */
  step(nowMs = Date.now()) {
    return this._emitTick(nowMs);
  }

  /**
   * Internal tick generator for the active scenario.
   * @param {number} nowMs
   * @returns {Object|null}
   * @private
   */
  _emitTick(nowMs) {
    const elapsedSec = Math.max(0, (nowMs - this.startTimeMs) / 1000);
    const dtSec = Math.max(0.1, (nowMs - this.lastStepTimeMs) / 1000);
    this.lastStepTimeMs = nowMs;

    let speedMps = 0;
    let accuracy = 3.8;
    let useDoppler = true;
    let suppressFix = false;

    switch (this.scenario) {
      case 'city': {
        // 30s stop-and-go urban cycle:
        // 0-4s: stopped at traffic light (0 m/s, tests stationary deadzone & Last Course)
        // 4-12s: smooth acceleration to 52 km/h (14.44 m/s)
        // 12-20s: urban cruise ~48-56 km/h
        // 20-26s: braking to stop
        // 26-30s: stationary at intersection
        const phase = elapsedSec % 30;
        if (phase < 4) {
          speedMps = 0.15; // Below 0.45 m/s deadzone
        } else if (phase < 12) {
          const p = (phase - 4) / 8;
          speedMps = 14.44 * (0.5 - 0.5 * Math.cos(p * Math.PI));
        } else if (phase < 20) {
          speedMps = 14.44 + Math.sin((phase - 12) * 0.8) * 1.2;
        } else if (phase < 26) {
          const p = (phase - 20) / 6;
          speedMps = 14.44 * (0.5 + 0.5 * Math.cos(p * Math.PI));
        } else {
          speedMps = 0.08;
        }
        accuracy = 4.6 + Math.sin(elapsedSec * 0.5) * 0.8;
        this.heading = (42 + Math.sin(elapsedSec * 0.12) * 28 + 360) % 360;
        this.altitude = 18.0 + Math.sin(elapsedSec * 0.08) * 3.5;
        break;
      }

      case 'threshold': {
        // 24s cycle around configured thresholdMps:
        // 0-5s: accelerates from (threshold - 15 km/h) up to threshold
        // 5-14s: climbs to (threshold + 18 km/h) and holds to test urgent + 10s reminder alerts & red sparkline
        // 14-20s: decelerates through the 0.42 m/s (1.5 km/h) hysteresis band
        // 20-24s: cruises safely 15 km/h below threshold
        const baseLimit = Math.max(5, this.thresholdMps);
        const lowSpeed = Math.max(0, baseLimit - 15 / MPS_TO_KMH); // -4.17 m/s
        const highSpeed = baseLimit + 18 / MPS_TO_KMH; // +5.0 m/s
        const phase = elapsedSec % 24;

        if (phase < 5) {
          const p = phase / 5;
          speedMps = lowSpeed + (baseLimit - lowSpeed + 0.8) * p;
        } else if (phase < 15) {
          const p = Math.min(1, (phase - 5) / 2.5);
          speedMps = baseLimit + 0.8 + (highSpeed - (baseLimit + 0.8)) * p;
        } else if (phase < 20) {
          const p = (phase - 15) / 5;
          speedMps = highSpeed - (highSpeed - lowSpeed) * p;
        } else {
          speedMps = lowSpeed;
        }
        accuracy = 3.4;
        this.heading = (75 + elapsedSec * 0.6) % 360;
        this.altitude = 42.0 + Math.sin(elapsedSec * 0.1) * 2.0;
        break;
      }

      case 'highway': {
        // High-precision highway cruise (95 - 126 km/h, ±3.2m, 1.0 Hz Doppler)
        const baseMps = 110 / MPS_TO_KMH;
        speedMps =
          baseMps +
          Math.sin(elapsedSec * 0.25) * (12 / MPS_TO_KMH) +
          Math.cos(elapsedSec * 0.11) * (4 / MPS_TO_KMH);
        accuracy = 3.2;
        this.heading = (118 + Math.sin(elapsedSec * 0.05) * 8 + 360) % 360;
        this.altitude = 112.0 + Math.sin(elapsedSec * 0.04) * 9.0;
        break;
      }

      case 'airplane': {
        // Commercial jetliner high-altitude cruise (~910 - 1110 km/h groundspeed with jet stream tailwinds,
        // cruising altitude ~10,668 m / 35,000 ft, ±6.2m cabin window GNSS lock, 1.0 Hz Doppler)
        const baseMps = 1010 / MPS_TO_KMH;
        speedMps =
          baseMps +
          Math.sin(elapsedSec * 0.22) * (75 / MPS_TO_KMH) +
          Math.cos(elapsedSec * 0.09) * (25 / MPS_TO_KMH);
        accuracy = 6.2 + Math.sin(elapsedSec * 0.3) * 0.8;
        this.heading = (84 + Math.sin(elapsedSec * 0.03) * 3 + 360) % 360;
        this.altitude = 10668.0 + Math.sin(elapsedSec * 0.05) * 45.0;
        break;
      }

      case 'tunnel': {
        // Degraded tunnel/urban canyon scenario:
        // coords.speed = null (forces accuracy-gated Haversine fallback)
        // accuracy = 48m (Poor Signal tier)
        // Every 16s, suppresses fixes for 5.5s to trigger 4s Staleness Watchdog decay
        useDoppler = false;
        accuracy = 48.0;
        const phase = elapsedSec % 16;
        if (phase >= 9 && phase <= 14.5) {
          suppressFix = true;
        }
        speedMps = 72 / MPS_TO_KMH + Math.sin(elapsedSec * 0.3) * 2.5;
        this.heading = 210;
        break;
      }

      case 'manual':
      default: {
        speedMps = Math.max(0, this.manualParams.speedKmh / MPS_TO_KMH);
        accuracy = Math.max(1, this.manualParams.accuracyMeters);
        useDoppler = accuracy <= 32;
        this.heading = (this.heading + (speedMps > 0.5 ? 1.5 : 0)) % 360;
        break;
      }
    }

    if (suppressFix) {
      return null;
    }

    // Advance simulated WGS84 position along current heading by (speedMps * dtSec)
    const distMeters = speedMps * dtSec;
    if (distMeters > 0) {
      const earthRadius = 6371008.8;
      const headingRad = (this.heading * Math.PI) / 180;
      const latRad = (this.latitude * Math.PI) / 180;

      const dLat = (distMeters * Math.cos(headingRad)) / earthRadius;
      const dLon =
        (distMeters * Math.sin(headingRad)) / (earthRadius * Math.cos(latRad));

      this.latitude += (dLat * 180) / Math.PI;
      this.longitude += (dLon * 180) / Math.PI;
    }

    const position = {
      coords: {
        latitude: this.latitude,
        longitude: this.longitude,
        accuracy: Number(accuracy.toFixed(1)),
        altitude: Number(this.altitude.toFixed(1)),
        altitudeAccuracy: Number((accuracy * 1.4).toFixed(1)),
        heading: speedMps >= 0.4 ? Number(this.heading.toFixed(1)) : null,
        speed: useDoppler ? Number(speedMps.toFixed(3)) : null,
      },
      timestamp: nowMs,
      isSimulated: true,
      scenario: this.scenario,
    };

    if (this.onPosition) {
      this.onPosition(position);
    }

    return position;
  }
}
