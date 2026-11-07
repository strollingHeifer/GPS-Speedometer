/**
 * @fileoverview Automated Unit Test Suite for Mobile Velocity & GNSS Telemetry Engine,
 * Multi-Modal Threshold Alert Hysteresis, Signal Confidence Scoring, and Simulation.
 * Run with: node --test tests/telemetry.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MPS_TO_KMH,
  MPS_TO_MPH,
  METERS_TO_FEET,
  mpsToUnit,
  unitToMps,
  metersToUnit,
  formatCardinal,
  haversineMeters,
  evaluateSignalConfidence,
  TelemetryEngine,
} from '../js/telemetry-engine.js';

import { ThresholdAlertController } from '../js/alerts.js';
import { WakeLockManager } from '../js/wake-lock.js';
import {
  TelemetrySimulator,
  createTapUnlockDetector,
  isDemoUnlockedByUrl,
} from '../js/simulator.js';
import {
  polarToCartesian,
  describeSvgArc,
  selectGaugeCeiling,
  RadialGaugeView,
  SparklineCanvasView,
} from '../js/charts.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Unit Conversions & Cardinal Formatting', () => {
  it('accurately converts between m/s, km/h, and mph', () => {
    assert.ok(Math.abs(mpsToUnit(10, 'kmh') - 36.0) < 1e-9);
    assert.ok(Math.abs(mpsToUnit(10, 'mph') - 22.36936292) < 1e-6);
    assert.ok(Math.abs(unitToMps(36, 'kmh') - 10.0) < 1e-9);
    assert.ok(Math.abs(unitToMps(22.369362920544, 'mph') - 10.0) < 1e-9);
    assert.equal(mpsToUnit(NaN, 'kmh'), 0);
    assert.equal(unitToMps(Infinity, 'mph'), 0);
  });

  it('converts meters to feet in mph mode and preserves meters in kmh mode', () => {
    assert.equal(metersToUnit(100, 'kmh'), 100);
    assert.ok(Math.abs(metersToUnit(100, 'mph') - 328.0839895) < 1e-6);
    assert.equal(metersToUnit(null, 'kmh'), null);
    assert.equal(metersToUnit(undefined, 'mph'), null);
  });

  it('formats 0-360 bearings into 8-wind cardinal directions', () => {
    assert.equal(formatCardinal(0), 'N');
    assert.equal(formatCardinal(360), 'N');
    assert.equal(formatCardinal(45), 'NE');
    assert.equal(formatCardinal(90), 'E');
    assert.equal(formatCardinal(135), 'SE');
    assert.equal(formatCardinal(180), 'S');
    assert.equal(formatCardinal(225), 'SW');
    assert.equal(formatCardinal(270), 'W');
    assert.equal(formatCardinal(315), 'NW');
    assert.equal(formatCardinal(null), '--');
    assert.equal(formatCardinal(NaN), '--');
  });
});

describe('Haversine Geodesic Distance', () => {
  it('computes 0 meters for identical coordinates', () => {
    assert.equal(haversineMeters(37.7749, -122.4194, 37.7749, -122.4194), 0);
  });

  it('matches reference geodesic distance for 1 degree of latitude (~111,195 m)', () => {
    const dist = haversineMeters(0, 0, 1, 0);
    assert.ok(Math.abs(dist - 111195.08) < 1.0, `Expected ~111195.08m, got ${dist}`);
  });

  it('accurately computes short 100m urban displacement', () => {
    // ~0.00089932 degrees latitude at equator is ~100 meters
    const d = haversineMeters(0, 0, 0.00089932, 0);
    assert.ok(Math.abs(d - 100.0) < 0.2, `Expected ~100m, got ${d}`);
  });
});

describe('Multi-Factor Signal Confidence Model', () => {
  it('classifies high-precision Doppler lock as Excellent tier', () => {
    const res = evaluateSignalConfidence({
      accuracyMeters: 3.5,
      updateHz: 1.0,
      fixAgeSeconds: 0.8,
      speedSource: 'doppler',
    });
    assert.equal(res.tier, 'excellent');
    assert.equal(res.label, 'Excellent (High Precision)');
    assert.ok(res.score >= 90 && res.score <= 100);
  });

  it('classifies moderate GNSS lock (8m, 0.5 Hz) as Good tier', () => {
    const res = evaluateSignalConfidence({
      accuracyMeters: 8.0,
      updateHz: 0.5,
      fixAgeSeconds: 1.5,
      speedSource: 'doppler',
    });
    assert.equal(res.tier, 'good');
    assert.equal(res.label, 'Good (Reliable GNSS)');
    assert.ok(res.score >= 65 && res.score < 95);
  });

  it('classifies coarse accuracy (20m, 0.25 Hz Haversine) as Fair tier', () => {
    const res = evaluateSignalConfidence({
      accuracyMeters: 20.0,
      updateHz: 0.25,
      fixAgeSeconds: 2.0,
      speedSource: 'haversine',
    });
    assert.equal(res.tier, 'fair');
    assert.equal(res.label, 'Fair (Moderate Accuracy)');
  });

  it('classifies stale (>6s) or >30m accuracy fixes as Poor tier', () => {
    const stale = evaluateSignalConfidence({
      accuracyMeters: 4.0,
      updateHz: 1.0,
      fixAgeSeconds: 6.5,
      speedSource: 'doppler',
    });
    assert.equal(stale.tier, 'poor');
    assert.equal(stale.score, 12);

    const lowAcc = evaluateSignalConfidence({
      accuracyMeters: 45.0,
      updateHz: 0.2,
      fixAgeSeconds: 1.0,
      speedSource: 'haversine',
    });
    assert.equal(lowAcc.tier, 'poor');
  });
});

describe('TelemetryEngine Filtering, Velocity & Heading Pipeline', () => {
  it('prioritizes hardware GNSS Doppler speed when coords.speed >= 0', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;
    const snap = engine.processPosition(
      {
        coords: {
          latitude: 37.7749,
          longitude: -122.4194,
          accuracy: 4.0,
          speed: 15.5,
          heading: 90,
          altitude: 25,
        },
        timestamp: t0,
      },
      t0
    );

    assert.equal(snap.speedSource, 'doppler');
    assert.ok(Math.abs(snap.speedMps - 15.5) < 1e-6);
    assert.ok(Math.abs(snap.maxSpeedMps - 15.5) < 1e-6);
  });

  it('falls back to accuracy-gated Haversine + EMA when coords.speed is null', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;

    // First fix at origin
    engine.processPosition(
      {
        coords: { latitude: 0, longitude: 0, accuracy: 5.0, speed: null },
        timestamp: t0,
      },
      t0
    );

    // Move ~20m North in 1 second (~20 m/s), exceeding accuracy gate (0.55 * 5 = 2.75m)
    const dLat20m = 20 / 111195.08;
    const snap1 = engine.processPosition(
      {
        coords: { latitude: dLat20m, longitude: 0, accuracy: 5.0, speed: null },
        timestamp: t0 + 1000,
      },
      t0 + 1000
    );

    assert.equal(snap1.speedSource, 'haversine');
    assert.ok(Math.abs(snap1.speedMps - 20.0) < 0.2);

    // Next fix moves ~30m North in 1s (instantSpeed ~30 m/s, EMA with alpha=0.35 -> 0.35*30 + 0.65*20 = 23.5 m/s)
    const snap2 = engine.processPosition(
      {
        coords: { latitude: dLat20m * 2.5, longitude: 0, accuracy: 5.0, speed: null },
        timestamp: t0 + 2000,
      },
      t0 + 2000
    );
    assert.ok(
      Math.abs(snap2.speedMps - 23.5) < 0.3,
      `Expected EMA ~23.5 m/s, got ${snap2.speedMps}`
    );
  });

  it('clamps stationary jitter (< 0.45 m/s within accuracy circle) to 0.0 m/s', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;
    const snap = engine.processPosition(
      {
        coords: {
          latitude: 37.7749,
          longitude: -122.4194,
          accuracy: 6.0,
          speed: 0.32, // < 0.45 m/s stationary jitter
        },
        timestamp: t0,
      },
      t0
    );

    assert.equal(snap.speedMps, 0);
  });

  it('rejects urban-canyon multipath velocity spikes (> 15 m/s² with accuracy > 15m)', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;

    // Normal cruise at 10 m/s with good accuracy
    engine.processPosition(
      {
        coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 4.0, speed: 10.0 },
        timestamp: t0,
      },
      t0
    );

    // 1 second later, multipath reflection reports 45 m/s (+35 m/s² > 15 m/s²) with degraded 28m accuracy
    const spikeSnap = engine.processPosition(
      {
        coords: { latitude: 37.775, longitude: -122.4194, accuracy: 28.0, speed: 45.0 },
        timestamp: t0 + 1000,
      },
      t0 + 1000
    );

    assert.equal(spikeSnap.spikeRejected, true);
    assert.equal(spikeSnap.speedMps, 10.0);
    assert.equal(spikeSnap.maxSpeedMps, 10.0);
  });

  it('rejects Haversine multipath coordinate spikes before EMA smoothing and prevents trip distance corruption', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;
    const dLat10m = 10 / 111195.08;

    // Fix 1 at origin
    engine.processPosition(
      { coords: { latitude: 0, longitude: 0, accuracy: 4.0, speed: null }, timestamp: t0 },
      t0
    );
    // Fix 2 at +10m (10 m/s)
    const snap1 = engine.processPosition(
      { coords: { latitude: dLat10m, longitude: 0, accuracy: 4.0, speed: null }, timestamp: t0 + 1000 },
      t0 + 1000
    );
    assert.ok(Math.abs(snap1.speedMps - 10.0) < 0.2);

    // Fix 3: multipath reflection jumps +60m in 1s (raw 50 m/s -> 40 m/s² > 15 m/s²) with 25m accuracy
    const dLat60m = 60 / 111195.08;
    const spikeSnap = engine.processPosition(
      { coords: { latitude: dLat60m, longitude: 0, accuracy: 25.0, speed: null }, timestamp: t0 + 2000 },
      t0 + 2000
    );
    assert.equal(spikeSnap.spikeRejected, true);
    assert.ok(Math.abs(spikeSnap.speedMps - 10.0) < 0.2);

    // Fix 4: returns to true road path at +20m (10 m/s average over 2s from Fix 2)
    const snapAfter = engine.processPosition(
      { coords: { latitude: dLat10m * 2, longitude: 0, accuracy: 4.0, speed: null }, timestamp: t0 + 3000 },
      t0 + 3000
    );
    assert.equal(snapAfter.spikeRejected, false);
    assert.ok(Math.abs(snapAfter.totalDistanceMeters - 20.0) < 0.5);
  });

  it('preserves session statistics while zeroing live speed on pause()', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;
    engine.processPosition(
      { coords: { latitude: 0, longitude: 0, accuracy: 4.0, speed: 15.0 }, timestamp: t0 },
      t0
    );
    engine.processPosition(
      { coords: { latitude: 0.000135, longitude: 0, accuracy: 4.0, speed: 15.0 }, timestamp: t0 + 1000 },
      t0 + 1000
    );

    const paused = engine.pause(t0 + 1500);
    assert.equal(paused.speedMps, 0);
    assert.equal(paused.speedSource, 'none');
    assert.equal(paused.maxSpeedMps, 15.0);
    assert.ok(paused.totalDistanceMeters > 14.0);
  });

  it('guards against background tab gaps (dt > 15s) and decays stale fixes (> 4s)', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;

    engine.processPosition(
      {
        coords: { latitude: 0, longitude: 0, accuracy: 4.0, speed: 20.0 },
        timestamp: t0,
      },
      t0
    );

    // 5 seconds without a fix triggers watchdog staleness & velocity decay
    const staleSnap = engine.tickWatchdog(t0 + 5000);
    assert.equal(staleSnap.isStale, true);
    assert.ok(staleSnap.speedMps < 20.0 && staleSnap.speedMps > 0);

    // Returning after 25s background gap with coords.speed = null does not spike distance or speed
    const gapSnap = engine.processPosition(
      {
        coords: { latitude: 0.01, longitude: 0, accuracy: 5.0, speed: null },
        timestamp: t0 + 25000,
      },
      t0 + 25000
    );
    assert.equal(gapSnap.isStale, false);
    assert.equal(gapSnap.speedMps, 0);
    assert.equal(gapSnap.totalDistanceMeters, 0);
  });

  it('manages Hybrid Compass Heading (GPS COG -> Last Course -> Compass fallback)', () => {
    const engine = new TelemetryEngine();
    const t0 = 1000000;

    // Stationary before any GPS movement -> uses device magnetometer Compass
    engine.updateCompassHeading(215);
    let snap = engine.getSnapshot(t0);
    assert.equal(snap.headingDeg, 215);
    assert.equal(snap.headingSource, 'Compass');
    assert.equal(snap.headingCardinal, 'SW');

    // Moving >= 0.8 m/s with valid GPS course -> switches to GPS COG
    snap = engine.processPosition(
      {
        coords: {
          latitude: 37.7749,
          longitude: -122.4194,
          accuracy: 4.0,
          speed: 12.0,
          heading: 90,
        },
        timestamp: t0 + 1000,
      },
      t0 + 1000
    );
    assert.equal(snap.headingDeg, 90);
    assert.equal(snap.headingSource, 'GPS COG');
    assert.equal(snap.headingCardinal, 'E');

    // Stopping at traffic light (< 0.8 m/s) -> retains Last Course (90° E)
    snap = engine.processPosition(
      {
        coords: {
          latitude: 37.7749,
          longitude: -122.4194,
          accuracy: 4.0,
          speed: 0.0,
          heading: null,
        },
        timestamp: t0 + 2000,
      },
      t0 + 2000
    );
    assert.equal(snap.headingDeg, 90);
    assert.equal(snap.headingSource, 'Last Course');
  });
});

describe('ThresholdAlertController Hysteresis & Repeat Cadence', () => {
  it('triggers when crossing limit, holds within 0.42 m/s hysteresis band, and clears below band', () => {
    const alerts = new ThresholdAlertController({
      hysteresisMps: 0.42,
      repeatIntervalMs: 10000,
    });
    const limitMps = 20.0; // 72 km/h
    const t0 = 50000;

    // Below threshold
    let res = alerts.evaluate(19.8, limitMps, true, t0);
    assert.equal(res.isOverLimit, false);
    assert.equal(res.justTriggered, false);

    // Crosses above threshold (20.3 > 20.0)
    res = alerts.evaluate(20.3, limitMps, true, t0 + 1000);
    assert.equal(res.isOverLimit, true);
    assert.equal(res.justTriggered, true);
    assert.equal(res.shouldRemind, false);

    // Slight dip inside hysteresis band (19.7 > 20.0 - 0.42 = 19.58) -> remains over limit without re-triggering
    res = alerts.evaluate(19.7, limitMps, true, t0 + 2000);
    assert.equal(res.isOverLimit, true);
    assert.equal(res.justTriggered, false);
    assert.equal(res.shouldRemind, false);

    // 10 seconds elapsed while still over limit -> fires reminder pulse
    res = alerts.evaluate(20.5, limitMps, true, t0 + 11000);
    assert.equal(res.isOverLimit, true);
    assert.equal(res.justTriggered, false);
    assert.equal(res.shouldRemind, true);

    // Drops at or below (threshold - 0.42 = 19.58 m/s) -> clears over-limit state
    res = alerts.evaluate(19.55, limitMps, true, t0 + 12000);
    assert.equal(res.isOverLimit, false);
    assert.equal(res.justTriggered, false);
    assert.equal(res.shouldRemind, false);
  });

  it('immediately clears alert state when disabled', () => {
    const alerts = new ThresholdAlertController();
    alerts.evaluate(25.0, 20.0, true, 1000);
    assert.equal(alerts.isOverLimit, true);

    const res = alerts.evaluate(25.0, 20.0, false, 2000);
    assert.equal(res.isOverLimit, false);
  });
});

describe('Simulator, 5-Tap Unlock & WakeLockManager', () => {
  it('unlocks Demo Mode on 5 taps within 3 seconds and ignores slow taps', () => {
    let unlockedCount = 0;
    const detector = createTapUnlockDetector({
      requiredTaps: 5,
      windowMs: 3000,
      onUnlock: () => {
        unlockedCount += 1;
      },
    });

    // 4 taps at t=0..900ms -> not yet unlocked
    assert.equal(detector(100), false);
    assert.equal(detector(300), false);
    assert.equal(detector(600), false);
    assert.equal(detector(900), false);
    assert.equal(unlockedCount, 0);

    // 5th tap at t=4500ms (outside 3000ms window from first taps) -> still not unlocked
    assert.equal(detector(4500), false);

    // 4 more rapid taps within 3s of 4500ms -> unlocks!
    assert.equal(detector(4800), false);
    assert.equal(detector(5100), false);
    assert.equal(detector(5400), false);
    assert.equal(detector(5700), true);
    assert.equal(unlockedCount, 1);
  });

  it('detects ?demo=1 and ?simulate=true URL query parameters', () => {
    assert.equal(isDemoUnlockedByUrl('?demo=1'), true);
    assert.equal(isDemoUnlockedByUrl('?simulate=true'), true);
    assert.equal(isDemoUnlockedByUrl('?unit=mph'), false);
  });

  it('generates valid simulated positions across all 5 scenarios and degrades safely for WakeLock in Node', async () => {
    const positions = [];
    const sim = new TelemetrySimulator({
      onPosition: (pos) => positions.push(pos),
    });

    sim.setThresholdMps(25.0);
    for (const scenario of ['city', 'threshold', 'highway', 'tunnel', 'manual']) {
      sim.scenario = scenario;
      sim.startTimeMs = 10000;
      sim.lastStepTimeMs = 10000;
      const pos = sim.step(12000);
      assert.ok(pos, `Expected position for scenario ${scenario}`);
      assert.equal(pos.isSimulated, true);
      assert.equal(pos.scenario, scenario);
      if (scenario === 'tunnel') {
        assert.equal(pos.coords.speed, null);
        assert.equal(pos.coords.accuracy, 48.0);
      } else {
        assert.equal(typeof pos.coords.speed, 'number');
      }
    }

    const wakeLock = new WakeLockManager();
    const acquired = await wakeLock.request();
    assert.equal(acquired, false);
    assert.equal(wakeLock.getStatus().supported, false);
  });
});

describe('Charts Geometry, Auto-Ranging Scales & Manifest/DOM Integrity', () => {
  it('selects auto-ranging gauge ceiling scales for km/h (60/120/180/240) and mph (40/80/120/160)', () => {
    assert.equal(selectGaugeCeiling(25, 30, 'kmh'), 60);
    assert.equal(selectGaugeCeiling(55, 80, 'kmh'), 120);
    assert.equal(selectGaugeCeiling(130, 100, 'kmh'), 180);
    assert.equal(selectGaugeCeiling(190, 120, 'kmh'), 240);

    assert.equal(selectGaugeCeiling(15, 25, 'mph'), 40);
    assert.equal(selectGaugeCeiling(45, 55, 'mph'), 80);
    assert.equal(selectGaugeCeiling(85, 65, 'mph'), 120);
    assert.equal(selectGaugeCeiling(130, 75, 'mph'), 160);
  });

  it('computes polarToCartesian and describeSvgArc for 240° sweep', () => {
    const top = polarToCartesian(150, 148, 100, 0);
    assert.ok(Math.abs(top.x - 150) < 1e-6);
    assert.ok(Math.abs(top.y - 48) < 1e-6);

    const arc = describeSvgArc(150, 148, 112, -120, 120);
    assert.ok(arc.startsWith('M '));
    assert.ok(arc.includes(' A 112 112 0 1 1 '));
  });

  it('verifies every DOM ID referenced in js/app.js exists in index.html and all PWA assets exist', () => {
    const rootDir = path.resolve(import.meta.dirname, '..');
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');

    const idRegex = /\$\('([^']+)'\)/g;
    let match;
    while ((match = idRegex.exec(appJs)) !== null) {
      const id = match[1];
      assert.ok(
        html.includes(`id="${id}"`),
        `DOM ID "${id}" referenced in js/app.js is missing from index.html`
      );
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'manifest.webmanifest'), 'utf8')
    );
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.orientation, 'any');
    for (const icon of manifest.icons) {
      const iconPath = path.join(rootDir, icon.src);
      assert.ok(fs.existsSync(iconPath), `Missing manifest icon: ${icon.src}`);
    }
  });
});

