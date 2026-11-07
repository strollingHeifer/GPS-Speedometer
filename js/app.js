/**
 * @fileoverview Main Application Controller for the Mobile Velocity & GNSS Telemetry PWA.
 * Coordinates M3 Expressive theming (System/Light/Dark), Geolocation watchPosition lifecycle,
 * Hybrid Telemetry Engine, Multi-Modal Speed Threshold Alerts, Screen Wake Lock,
 * SVG Radial Gauge & High-DPI 60s Sparkline, and Hidden-by-Default Developer Simulation Mode.
 */

import {
  MPS_TO_KMH,
  mpsToUnit,
  unitToMps,
  metersToUnit,
  TelemetryEngine,
} from './telemetry-engine.js';
import { ThresholdAlertController } from './alerts.js';
import { WakeLockManager } from './wake-lock.js';
import {
  TelemetrySimulator,
  createTapUnlockDetector,
  isDemoUnlockedByUrl,
} from './simulator.js';
import { RadialGaugeView, SparklineCanvasView } from './charts.js';

const PRESETS_BY_UNIT = {
  kmh: [30, 50, 80, 100, 120],
  mph: [20, 30, 50, 65, 75],
};

const STORAGE_KEYS = {
  theme: 'theme',
  unit: 'gnss_velocity_unit',
  thresholdMps: 'gnss_velocity_threshold_mps',
  thresholdEnabled: 'gnss_velocity_threshold_enabled',
  audioMuted: 'gnss_velocity_audio_muted',
};

function safeGetStorage(key, fallback = null) {
  try {
    const val = window.localStorage.getItem(key);
    return val !== null ? val : fallback;
  } catch (_) {
    return fallback;
  }
}

function safeSetStorage(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (_) {
    // Ignore storage quota or private mode errors
  }
}

function formatDurationMmSs(ms) {
  const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export class VelocityTelemetryApp {
  constructor() {
    // Core state
    this.themeMode = safeGetStorage(STORAGE_KEYS.theme, 'system') || 'system';
    this.unit = safeGetStorage(STORAGE_KEYS.unit, 'kmh') === 'mph' ? 'mph' : 'kmh';

    const savedThreshMps = parseFloat(safeGetStorage(STORAGE_KEYS.thresholdMps, ''));
    this.thresholdMps =
      Number.isFinite(savedThreshMps) && savedThreshMps > 0
        ? savedThreshMps
        : 80 / MPS_TO_KMH; // Default 80 km/h (22.222 m/s)

    const savedEnabled = safeGetStorage(STORAGE_KEYS.thresholdEnabled, 'true');
    this.thresholdEnabled = savedEnabled !== 'false';

    const savedMuted = safeGetStorage(STORAGE_KEYS.audioMuted, 'false') === 'true';

    // Subsystems
    this.engine = new TelemetryEngine();
    this.alerts = new ThresholdAlertController({
      hysteresisMps: 0.42, // 1.5 km/h hysteresis
      repeatIntervalMs: 10000,
    });
    this.alerts.setMuted(savedMuted);

    this.wakeLock = new WakeLockManager({
      onStatusChange: (status) => this._renderWakeLockStatus(status),
    });

    this.simulator = new TelemetrySimulator({
      onPosition: (pos) => this._handleIncomingPosition(pos),
      onStatusChange: (simState) => this._renderSimulatorStatus(simState),
    });
    this.simulator.setThresholdMps(this.thresholdMps);

    this.isTrackingLive = false;
    this.watchId = null;
    this.retryTimerId = null;
    this.uiTickTimerId = null;
    this.snackbarTimerId = null;
    this.demoUnlocked = false;

    this._cacheDom();
    this.gaugeView = new RadialGaugeView(this.dom.radialGaugeSvg);
    this.sparklineView = new SparklineCanvasView(this.dom.sparklineCanvas);
  }

  _cacheDom() {
    const $ = (id) => document.getElementById(id);
    this.dom = {
      metaThemeColor: $('meta-theme-color'),
      secureContextBanner: $('secure-context-banner'),
      permissionBanner: $('permission-error-banner'),
      permissionTitle: $('permission-error-title'),
      permissionMessage: $('permission-error-message'),
      permissionSteps: $('permission-error-steps'),
      permissionRetryBtn: $('permission-retry-btn'),
      permissionDismissBtn: $('permission-dismiss-btn'),

      gpsStatusBadge: $('gps-status-badge'),
      gpsStatusText: $('gps-status-text'),
      wakeLockChip: $('wake-lock-chip'),
      wakeLockText: $('wake-lock-text'),
      audioMuteBtn: $('audio-mute-btn'),
      audioMuteIcon: $('audio-mute-icon'),
      audioMuteLabel: $('audio-mute-label'),
      themeSwitcher: $('theme-switcher'),
      gnssInfoBtn: $('gnss-info-btn'),

      demoControlBar: $('demo-control-bar'),
      demoStatusLabel: $('demo-status-label'),
      demoStopBtn: $('demo-stop-btn'),
      demoManualControls: $('demo-manual-controls'),
      simSpeedSlider: $('sim-speed-slider'),
      simSpeedVal: $('sim-speed-val'),
      simAccSlider: $('sim-acc-slider'),
      simAccVal: $('sim-acc-val'),
      simRateSlider: $('sim-rate-slider'),
      simRateVal: $('sim-rate-val'),

      heroSpeedCard: $('hero-speed-card'),
      unitKmhBtn: $('unit-kmh-btn'),
      unitMphBtn: $('unit-mph-btn'),
      gaugeScaleBadge: $('gauge-scale-badge'),
      radialGaugeSvg: $('radial-gauge-svg'),
      heroSpeedValue: $('hero-speed-value'),
      heroSpeedUnit: $('hero-speed-unit'),
      heroSpeedSource: $('hero-speed-source'),
      thresholdAlertBanner: $('threshold-alert-banner'),
      thresholdAlertText: $('threshold-alert-text'),
      startStopBtn: $('start-stop-btn'),
      startStopIcon: $('start-stop-icon'),
      startStopLabel: $('start-stop-label'),
      resetSessionBtn: $('reset-session-btn'),

      thresholdDisplayValue: $('threshold-display-value'),
      thresholdEnableToggle: $('threshold-enable-toggle'),
      thresholdPresetsContainer: $('threshold-presets-container'),
      thresholdMinusBtn: $('threshold-minus-btn'),
      thresholdPlusBtn: $('threshold-plus-btn'),
      thresholdSlider: $('threshold-slider'),

      confidenceTierBadge: $('confidence-tier-badge'),
      confidenceProgressbar: $('confidence-progressbar'),
      confidenceProgressFill: $('confidence-progress-fill'),
      confidenceScoreValue: $('confidence-score-value'),
      metricAccuracyVal: $('metric-accuracy-val'),
      metricHzVal: $('metric-hz-val'),
      metricAgeVal: $('metric-age-val'),
      metricSourceVal: $('metric-source-val'),
      metricSatellitesVal: $('metric-satellites-val'),

      sparklineCurrentVal: $('sparkline-current-val'),
      sparklinePeakVal: $('sparkline-peak-val'),
      sparklineLimitVal: $('sparkline-limit-val'),
      sparklineCanvas: $('sparkline-canvas'),

      statElapsed: $('stat-elapsed'),
      statMaxSpeed: $('stat-max-speed'),
      statAvgSpeed: $('stat-avg-speed'),
      statDistance: $('stat-distance'),
      statAltitude: $('stat-altitude'),
      statAltAcc: $('stat-alt-acc'),

      compassDial: $('compass-dial'),
      compassDegVal: $('compass-deg-val'),
      compassCardinalVal: $('compass-cardinal-val'),
      compassSourceBadge: $('compass-source-badge'),

      gnssSheetBackdrop: $('gnss-sheet-backdrop'),
      gnssSheetCloseBtn: $('gnss-sheet-close-btn'),
      appSnackbar: $('app-snackbar'),
    };
  }

  init() {
    this._initThemeSystem();
    this._checkSecureContext();
    this._bindEvents();
    this._initCompassListener();
    this._initDemoUnlockState();
    this._syncAudioMuteUi();
    this._syncUnitAndThresholdControls();
    this._renderWakeLockStatus(this.wakeLock.getStatus());
    this._renderSnapshot(this.engine.getSnapshot(Date.now()));
    this._startUiTickLoop();
    this._registerServiceWorker();
  }

  /* ==========================================================================
   * 1. Theme System (System | Light | Dark with Light Fallback)
   * ========================================================================== */
  _initThemeSystem() {
    this._applyTheme(this.themeMode);

    if (typeof window.matchMedia === 'function') {
      const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleSystemChange = () => {
        if (this.themeMode === 'system') {
          this._updateMetaThemeColor();
          this._renderSnapshot(this.engine.getSnapshot(Date.now()));
        }
      };
      if (typeof darkQuery.addEventListener === 'function') {
        darkQuery.addEventListener('change', handleSystemChange);
      }
    }
  }

  _applyTheme(mode) {
    const validMode = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
    this.themeMode = validMode;
    safeSetStorage(STORAGE_KEYS.theme, validMode);

    const root = document.documentElement;
    if (validMode === 'light') {
      root.setAttribute('data-theme', 'light');
    } else if (validMode === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.setAttribute('data-theme', 'system');
    }

    if (this.dom.themeSwitcher) {
      const buttons = this.dom.themeSwitcher.querySelectorAll('[data-theme-opt]');
      buttons.forEach((btn) => {
        const isSelected = btn.getAttribute('data-theme-opt') === validMode;
        btn.setAttribute('aria-pressed', String(isSelected));
      });
    }

    this._updateMetaThemeColor();
    if (this.sparklineView) {
      this._renderSnapshot(this.engine.getSnapshot(Date.now()));
    }
  }

  _updateMetaThemeColor() {
    if (!this.dom.metaThemeColor) return;
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDarkEffective =
      this.themeMode === 'dark' || (this.themeMode === 'system' && prefersDark);
    this.dom.metaThemeColor.setAttribute(
      'content',
      isDarkEffective ? '#0e1415' : '#f5fafb'
    );
  }

  /* ==========================================================================
   * 2. Secure Context & Geolocation Permission Lifecycle
   * ========================================================================== */
  _checkSecureContext() {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      if (this.dom.secureContextBanner) {
        this.dom.secureContextBanner.hidden = false;
      }
    }
  }

  startLiveTracking() {
    // Unlock Web Audio API & Screen Wake Lock on user gesture
    this.alerts.unlockHardwareOnUserGesture();
    this.wakeLock.request();

    // If simulator is running, stop it when switching to live GNSS
    if (this.simulator.isRunning()) {
      this.simulator.stop();
    }

    if (!('geolocation' in navigator)) {
      this._showPermissionBanner({
        title: 'Geolocation API Not Supported',
        message: 'This browser does not expose navigator.geolocation. Use Demo Mode to test telemetry.',
        showSteps: false,
      });
      this._updateGpsStatusBadge('error', 'No GNSS API');
      return;
    }

    this.isTrackingLive = true;
    this._syncStartStopButton();
    this._updateGpsStatusBadge('acquiring', 'Acquiring GNSS...');

    if (this.dom.permissionBanner) {
      this.dom.permissionBanner.hidden = true;
    }

    this._attachGeolocationWatch();
  }

  _attachGeolocationWatch() {
    if (this.watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.retryTimerId !== null) {
      clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }

    try {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this._handleIncomingPosition(pos),
        (err) => this._handleGeolocationError(err),
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000,
        }
      );
    } catch (err) {
      this._handleGeolocationError(err);
    }
  }

  pauseTracking() {
    this.isTrackingLive = false;
    if (this.watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.retryTimerId !== null) {
      clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }
    if (this.simulator.isRunning()) {
      this.simulator.stop();
    }
    this.wakeLock.release();
    this.alerts.reset();
    const snapshot = this.engine.pause(Date.now());
    this._syncStartStopButton();
    this._updateGpsStatusBadge('idle', 'Paused');
    this._renderSnapshot(snapshot);
  }

  _handleGeolocationError(error) {
    const code = error?.code;
    // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
    if (code === 1) {
      this.pauseTracking();
      this._updateGpsStatusBadge('error', 'Permission Denied');
      this._showPermissionBanner({
        title: 'Location Permission Denied',
        message:
          'Precise GNSS access is required to measure real-time speed. To re-enable in Chrome for Android:',
        showSteps: true,
      });
    } else if (code === 2 || code === 3) {
      const reason = code === 3 ? 'GNSS Fix Timeout' : 'Position Unavailable';
      this._updateGpsStatusBadge('warning', `${reason} (Retrying)`);
      this._showPermissionBanner({
        title: `${reason} — Searching for Satellites`,
        message:
          'Ensure device Location is enabled and you have a clear view of the sky. Automatically retrying high-accuracy GNSS lock...',
        showSteps: false,
      });

      if (this.isTrackingLive && this.retryTimerId === null) {
        this.retryTimerId = setTimeout(() => {
          this.retryTimerId = null;
          if (this.isTrackingLive) {
            this._attachGeolocationWatch();
          }
        }, 2500);
      }
    } else {
      this._updateGpsStatusBadge('error', 'GNSS Error');
    }
  }

  _showPermissionBanner({ title, message, showSteps }) {
    if (!this.dom.permissionBanner) return;
    if (this.dom.permissionTitle) this.dom.permissionTitle.textContent = title;
    if (this.dom.permissionMessage) this.dom.permissionMessage.textContent = message;
    if (this.dom.permissionSteps) this.dom.permissionSteps.hidden = !showSteps;
    this.dom.permissionBanner.hidden = false;
  }

  /* ==========================================================================
   * 3. Incoming Fix Processing & Periodic Watchdog Loop
   * ========================================================================== */
  _handleIncomingPosition(position) {
    if (this.dom.permissionBanner && !position?.isSimulated) {
      this.dom.permissionBanner.hidden = true;
    }

    const nowMs = Date.now();
    const snapshot = this.engine.processPosition(position, nowMs);

    if (snapshot.isSimulated) {
      this._updateGpsStatusBadge('sim', `SIM: ${this.simulator.scenario.toUpperCase()}`);
    } else {
      const accText = Number.isFinite(snapshot.accuracyMeters)
        ? `±${Math.round(snapshot.accuracyMeters)}m`
        : 'Locked';
      this._updateGpsStatusBadge('active', `GNSS ${accText}`);
    }

    this._renderSnapshot(snapshot, nowMs);
  }

  _startUiTickLoop() {
    if (this.uiTickTimerId !== null) {
      clearInterval(this.uiTickTimerId);
    }
    this.uiTickTimerId = setInterval(() => {
      const isActive = this.isTrackingLive || this.simulator.isRunning();
      if (!isActive) return;

      const nowMs = Date.now();
      const snapshot = this.engine.tickWatchdog(nowMs);
      if (snapshot.isStale) {
        this._updateGpsStatusBadge(
          'stale',
          snapshot.isSimulated ? 'SIM Stale (Tunnel)' : 'Signal Stale (>4s)'
        );
      }
      this._renderSnapshot(snapshot, nowMs);
    }, 250);
  }

  /* ==========================================================================
   * 4. Rendering Telemetry Snapshot to M3 UI, Gauge & Sparkline
   * ========================================================================== */
  _renderSnapshot(snapshot, nowMs = Date.now()) {
    const isActive = this.isTrackingLive || this.simulator.isRunning();
    const unitLabel = this.unit === 'mph' ? 'mph' : 'km/h';
    const distUnitLabel = this.unit === 'mph' ? 'ft' : 'm';

    const speedInUnit = mpsToUnit(snapshot.speedMps, this.unit);
    const thresholdInUnit = mpsToUnit(this.thresholdMps, this.unit);

    // Evaluate multi-modal threshold alert (with 1.5 km/h hysteresis)
    const alertState = isActive
      ? this.alerts.evaluate(
          snapshot.speedMps,
          this.thresholdMps,
          this.thresholdEnabled,
          nowMs
        )
      : { isOverLimit: false };

    const isOverLimit = Boolean(alertState.isOverLimit);

    // 1. Hero Readout & Card Over-Limit State
    if (this.dom.heroSpeedCard) {
      this.dom.heroSpeedCard.classList.toggle('is-over-limit', isOverLimit);
    }
    if (this.dom.heroSpeedValue) {
      this.dom.heroSpeedValue.textContent = speedInUnit.toFixed(1);
    }
    if (this.dom.heroSpeedUnit) {
      this.dom.heroSpeedUnit.textContent = unitLabel;
    }

    // Speed Source Pill (DOPPLER / CALC / SIM / IDLE)
    if (this.dom.heroSpeedSource) {
      let badgeLabel = 'IDLE';
      let sourceAttr = 'idle';
      if (snapshot.isSimulated) {
        badgeLabel = snapshot.speedSource === 'doppler' ? 'SIM DOPPLER' : 'SIM CALC';
        sourceAttr = snapshot.speedSource;
      } else if (snapshot.speedSource === 'doppler') {
        badgeLabel = 'DOPPLER';
        sourceAttr = 'doppler';
      } else if (snapshot.speedSource === 'haversine') {
        badgeLabel = 'CALC';
        sourceAttr = 'haversine';
      }
      this.dom.heroSpeedSource.textContent = badgeLabel;
      this.dom.heroSpeedSource.setAttribute('data-source', sourceAttr);
    }

    // Over-Limit Warning Banner
    if (this.dom.thresholdAlertBanner) {
      this.dom.thresholdAlertBanner.hidden = !isOverLimit;
      if (isOverLimit && this.dom.thresholdAlertText) {
        this.dom.thresholdAlertText.textContent = `SPEED LIMIT EXCEEDED (Limit: ${Math.round(thresholdInUnit)} ${unitLabel})`;
      }
    }

    // 2. 240° SVG Radial Gauge
    if (this.gaugeView) {
      const ceiling = this.gaugeView.render({
        speedInUnit,
        unit: this.unit,
        thresholdInUnit,
        thresholdEnabled: this.thresholdEnabled,
        isOverLimit,
      });
      if (this.dom.gaugeScaleBadge && ceiling) {
        this.dom.gaugeScaleBadge.textContent = `Scale: 0–${ceiling} ${unitLabel}`;
      }
    }

    // 3. Signal Accuracy & Confidence Card
    const hasFix = snapshot.accuracyMeters !== null && Number.isFinite(snapshot.accuracyMeters);
    if (this.dom.confidenceTierBadge) {
      if (!hasFix) {
        this.dom.confidenceTierBadge.textContent = 'Awaiting Fix';
        this.dom.confidenceTierBadge.setAttribute('data-tier', 'poor');
      } else {
        this.dom.confidenceTierBadge.textContent = snapshot.confidence.label;
        this.dom.confidenceTierBadge.setAttribute('data-tier', snapshot.confidence.tier);
      }
    }

    const confScore = hasFix ? snapshot.confidence.score : 0;
    const confTier = hasFix ? snapshot.confidence.tier : 'poor';
    if (this.dom.confidenceProgressFill) {
      this.dom.confidenceProgressFill.style.width = `${confScore}%`;
      this.dom.confidenceProgressFill.setAttribute('data-tier', confTier);
    }
    if (this.dom.confidenceProgressbar) {
      this.dom.confidenceProgressbar.setAttribute('aria-valuenow', String(confScore));
    }
    if (this.dom.confidenceScoreValue) {
      this.dom.confidenceScoreValue.textContent = `${confScore}%`;
    }

    if (this.dom.metricAccuracyVal) {
      if (hasFix) {
        const accConverted = metersToUnit(snapshot.accuracyMeters, this.unit);
        this.dom.metricAccuracyVal.textContent = `\u00B1 ${accConverted.toFixed(1)} ${distUnitLabel}`;
      } else {
        this.dom.metricAccuracyVal.textContent = `\u00B1 -- ${distUnitLabel}`;
      }
    }

    if (this.dom.metricHzVal) {
      this.dom.metricHzVal.textContent = hasFix
        ? `${snapshot.updateHz.toFixed(1)} Hz`
        : '0.0 Hz';
    }

    if (this.dom.metricAgeVal) {
      if (hasFix && Number.isFinite(snapshot.fixAgeSeconds)) {
        this.dom.metricAgeVal.textContent = `${snapshot.fixAgeSeconds.toFixed(1)}s`;
      } else {
        this.dom.metricAgeVal.textContent = '-- s';
      }
    }

    if (this.dom.metricSourceVal) {
      if (!hasFix) {
        this.dom.metricSourceVal.textContent = 'Awaiting Fix';
      } else if (snapshot.speedSource === 'doppler') {
        this.dom.metricSourceVal.textContent = 'GNSS Doppler';
      } else {
        this.dom.metricSourceVal.textContent = 'Geodesic \u0394d/\u0394t';
      }
    }

    if (this.dom.metricSatellitesVal) {
      const lockLabel =
        hasFix && snapshot.lockState && snapshot.lockState.label
          ? snapshot.lockState.label
          : 'Awaiting Fix';
      const lockState =
        hasFix && snapshot.lockState && snapshot.lockState.state
          ? snapshot.lockState.state
          : 'awaiting';
      this.dom.metricSatellitesVal.textContent = lockLabel;
      this.dom.metricSatellitesVal.setAttribute('data-lock-state', lockState);
    }

    // 4. 60-Second High-DPI Sparkline
    if (this.sparklineView) {
      const { peakSpeed } = this.sparklineView.render({
        history: snapshot.history,
        nowMs,
        convertMps: (mps) => mpsToUnit(mps, this.unit),
        thresholdInUnit,
        thresholdEnabled: this.thresholdEnabled,
        unitLabel,
      });

      if (this.dom.sparklineCurrentVal) {
        this.dom.sparklineCurrentVal.textContent = `${speedInUnit.toFixed(1)} ${unitLabel}`;
      }
      if (this.dom.sparklinePeakVal) {
        this.dom.sparklinePeakVal.textContent = `${peakSpeed.toFixed(1)} ${unitLabel}`;
      }
      if (this.dom.sparklineLimitVal) {
        this.dom.sparklineLimitVal.textContent = this.thresholdEnabled
          ? `${Math.round(thresholdInUnit)} ${unitLabel}`
          : 'Off';
      }
    }

    // 5. Session Statistics & Compass / Altitude
    if (this.dom.statElapsed) {
      this.dom.statElapsed.textContent = formatDurationMmSs(snapshot.elapsedMs);
    }
    if (this.dom.statMaxSpeed) {
      const maxInUnit = mpsToUnit(snapshot.maxSpeedMps, this.unit);
      this.dom.statMaxSpeed.textContent = `${maxInUnit.toFixed(1)} ${unitLabel}`;
    }
    if (this.dom.statAvgSpeed) {
      const avgInUnit = mpsToUnit(snapshot.avgSpeedMps, this.unit);
      this.dom.statAvgSpeed.textContent = `${avgInUnit.toFixed(1)} ${unitLabel}`;
    }
    if (this.dom.statDistance) {
      if (this.unit === 'mph') {
        const miles = snapshot.totalDistanceMeters / 1609.344;
        this.dom.statDistance.textContent = `${miles.toFixed(2)} mi`;
      } else {
        const km = snapshot.totalDistanceMeters / 1000;
        this.dom.statDistance.textContent = `${km.toFixed(2)} km`;
      }
    }
    if (this.dom.statAltitude) {
      if (snapshot.altitudeMeters !== null && Number.isFinite(snapshot.altitudeMeters)) {
        const altVal = metersToUnit(snapshot.altitudeMeters, this.unit);
        const altAccVal = metersToUnit(snapshot.altitudeAccuracyMeters, this.unit);
        const accSuffix =
          altAccVal !== null ? ` (\u00B1${Math.round(altAccVal)}${distUnitLabel})` : '';
        if (this.dom.statAltAcc && this.dom.statAltAcc.parentNode === this.dom.statAltitude) {
          this.dom.statAltitude.firstChild.nodeValue = `${Math.round(altVal)} ${distUnitLabel}`;
          this.dom.statAltAcc.textContent = accSuffix;
        } else {
          this.dom.statAltitude.textContent = `${Math.round(altVal)} ${distUnitLabel}${accSuffix}`;
        }
      } else if (this.dom.statAltAcc && this.dom.statAltAcc.parentNode === this.dom.statAltitude) {
        this.dom.statAltitude.firstChild.nodeValue = `-- ${distUnitLabel} `;
        this.dom.statAltAcc.textContent = '';
      } else {
        this.dom.statAltitude.textContent = `-- ${distUnitLabel}`;
      }
    }

    // Compass Rose & Heading
    if (snapshot.headingDeg !== null && Number.isFinite(snapshot.headingDeg)) {
      const deg = Math.round(snapshot.headingDeg);
      if (this.dom.compassDial) {
        this.dom.compassDial.style.transform = `rotate(${deg}deg)`;
      }
      if (this.dom.compassDegVal) {
        this.dom.compassDegVal.textContent = `${String(deg).padStart(3, '0')}\u00B0`;
      }
      if (this.dom.compassCardinalVal) {
        this.dom.compassCardinalVal.textContent = snapshot.headingCardinal;
      }
      if (this.dom.compassSourceBadge) {
        this.dom.compassSourceBadge.textContent = snapshot.headingSource;
      }
    } else {
      if (this.dom.compassDial) {
        this.dom.compassDial.style.transform = 'rotate(0deg)';
      }
      if (this.dom.compassDegVal) {
        this.dom.compassDegVal.textContent = '---\u00B0';
      }
      if (this.dom.compassCardinalVal) {
        this.dom.compassCardinalVal.textContent = '--';
      }
      if (this.dom.compassSourceBadge) {
        this.dom.compassSourceBadge.textContent = 'No Heading';
      }
    }
  }

  /* ==========================================================================
   * 5. Unit Switching & Speed Limit Threshold Controls
   * ========================================================================== */
  setUnit(nextUnit) {
    const normalized = nextUnit === 'mph' ? 'mph' : 'kmh';
    if (normalized === this.unit) return;
    this.unit = normalized;
    safeSetStorage(STORAGE_KEYS.unit, normalized);
    this._syncUnitAndThresholdControls();
    this._renderSnapshot(this.engine.getSnapshot(Date.now()));
  }

  setThresholdInCurrentUnit(valInUnit) {
    const numeric = Number(valInUnit);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    this.thresholdMps = unitToMps(numeric, this.unit);
    safeSetStorage(STORAGE_KEYS.thresholdMps, this.thresholdMps.toFixed(4));
    this.simulator.setThresholdMps(this.thresholdMps);
    this._syncUnitAndThresholdControls();
    this._renderSnapshot(this.engine.getSnapshot(Date.now()));
  }

  _syncUnitAndThresholdControls() {
    const isMph = this.unit === 'mph';
    const unitLabel = isMph ? 'mph' : 'km/h';

    if (this.dom.unitKmhBtn && this.dom.unitMphBtn) {
      this.dom.unitKmhBtn.setAttribute('aria-pressed', String(!isMph));
      this.dom.unitMphBtn.setAttribute('aria-pressed', String(isMph));
    }

    const thresholdInUnit = Math.round(mpsToUnit(this.thresholdMps, this.unit));

    if (this.dom.thresholdEnableToggle) {
      this.dom.thresholdEnableToggle.checked = this.thresholdEnabled;
    }

    if (this.dom.thresholdDisplayValue) {
      this.dom.thresholdDisplayValue.textContent = this.thresholdEnabled
        ? `${thresholdInUnit} ${unitLabel}`
        : `Off (${thresholdInUnit} ${unitLabel})`;
    }

    if (this.dom.thresholdSlider) {
      this.dom.thresholdSlider.min = isMph ? '5' : '10';
      this.dom.thresholdSlider.max = isMph ? '140' : '220';
      this.dom.thresholdSlider.value = String(thresholdInUnit);
      this.dom.thresholdSlider.disabled = !this.thresholdEnabled;
    }

    // Rebuild or update preset chips for active unit
    if (this.dom.thresholdPresetsContainer) {
      const presets = PRESETS_BY_UNIT[this.unit];
      this.dom.thresholdPresetsContainer.innerHTML = '';
      presets.forEach((presetVal) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isMatch = Math.abs(thresholdInUnit - presetVal) <= 1;
        btn.className = `chip-btn${isMatch ? ' is-active' : ''}`;
        btn.setAttribute('data-preset', String(presetVal));
        btn.setAttribute('aria-pressed', String(isMatch));
        btn.textContent = `${presetVal} ${unitLabel}`;
        btn.addEventListener('click', () => {
          if (!this.thresholdEnabled) {
            this.thresholdEnabled = true;
            safeSetStorage(STORAGE_KEYS.thresholdEnabled, 'true');
          }
          this.setThresholdInCurrentUnit(presetVal);
        });
        this.dom.thresholdPresetsContainer.appendChild(btn);
      });
    }
  }

  /* ==========================================================================
   * 6. Hidden-by-Default Developer Demo Mode (?demo=1 or 5-Tap Unlock)
   * ========================================================================== */
  _initDemoUnlockState() {
    if (isDemoUnlockedByUrl()) {
      this.unlockDemoMode(false);
    }
  }

  unlockDemoMode(showNotification = true) {
    this.demoUnlocked = true;
    if (this.dom.demoControlBar) {
      this.dom.demoControlBar.hidden = false;
    }
    if (showNotification) {
      this.showSnackbar('Developer Demo Mode unlocked');
    }
  }

  startSimulationScenario(scenario) {
    this.alerts.unlockHardwareOnUserGesture();
    this.wakeLock.request();

    if (this.isTrackingLive) {
      this.isTrackingLive = false;
      if (this.watchId !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
    }

    if (this.dom.demoManualControls) {
      this.dom.demoManualControls.hidden = scenario !== 'manual';
    }

    this.simulator.setThresholdMps(this.thresholdMps);
    this.simulator.start(scenario);
    this._syncStartStopButton();
  }

  _renderSimulatorStatus({ running, scenario }) {
    if (this.dom.demoStatusLabel) {
      this.dom.demoStatusLabel.textContent = running
        ? `(Active: ${scenario.toUpperCase()})`
        : '(Inactive)';
    }
    if (this.dom.demoControlBar) {
      const buttons = this.dom.demoControlBar.querySelectorAll('[data-scenario]');
      buttons.forEach((btn) => {
        const isCurr = running && btn.getAttribute('data-scenario') === scenario;
        btn.classList.toggle('is-active', isCurr);
        btn.setAttribute('aria-pressed', String(isCurr));
      });
    }
    if (!running && !this.isTrackingLive) {
      this._updateGpsStatusBadge('idle', 'Standby');
      this._syncStartStopButton();
    }
  }

  /* ==========================================================================
   * 7. DOM Event Bindings, Compass Listener & PWA Service Worker
   * ========================================================================== */
  _bindEvents() {
    // 5-tap within 3 seconds unlock detector on GPS Status Badge
    const tapDetector = createTapUnlockDetector({
      requiredTaps: 5,
      windowMs: 3000,
      onUnlock: () => this.unlockDemoMode(true),
    });

    if (this.dom.gpsStatusBadge) {
      this.dom.gpsStatusBadge.addEventListener('click', () => {
        tapDetector(Date.now());
      });
    }

    // Theme Switcher (System | Light | Dark)
    if (this.dom.themeSwitcher) {
      this.dom.themeSwitcher.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-theme-opt]');
        if (!btn) return;
        this._applyTheme(btn.getAttribute('data-theme-opt'));
      });
    }

    // Audio Chime Mute Toggle
    if (this.dom.audioMuteBtn) {
      this.dom.audioMuteBtn.addEventListener('click', () => {
        this.alerts.unlockHardwareOnUserGesture();
        const muted = this.alerts.toggleMute();
        safeSetStorage(STORAGE_KEYS.audioMuted, String(muted));
        this._syncAudioMuteUi();
      });
    }

    // Unit Segmented Control (km/h | mph)
    if (this.dom.unitKmhBtn) {
      this.dom.unitKmhBtn.addEventListener('click', () => this.setUnit('kmh'));
    }
    if (this.dom.unitMphBtn) {
      this.dom.unitMphBtn.addEventListener('click', () => this.setUnit('mph'));
    }

    // Start / Pause Tracking Button
    if (this.dom.startStopBtn) {
      this.dom.startStopBtn.addEventListener('click', () => {
        const isActive = this.isTrackingLive || this.simulator.isRunning();
        if (isActive) {
          this.pauseTracking();
        } else {
          this.startLiveTracking();
        }
      });
    }

    // Reset Session Button
    if (this.dom.resetSessionBtn) {
      this.dom.resetSessionBtn.addEventListener('click', () => {
        const snapshot = this.engine.reset(Date.now());
        this.alerts.reset();
        this._renderSnapshot(snapshot);
        this.showSnackbar('Session statistics reset');
      });
    }

    // Permission Banner Retry & Dismiss
    if (this.dom.permissionRetryBtn) {
      this.dom.permissionRetryBtn.addEventListener('click', () => {
        this.startLiveTracking();
      });
    }
    if (this.dom.permissionDismissBtn) {
      this.dom.permissionDismissBtn.addEventListener('click', () => {
        if (this.dom.permissionBanner) {
          this.dom.permissionBanner.hidden = true;
        }
      });
    }

    // Threshold Enable Toggle, Slider & -5 / +5 Steppers
    if (this.dom.thresholdEnableToggle) {
      this.dom.thresholdEnableToggle.addEventListener('change', (e) => {
        this.thresholdEnabled = Boolean(e.target.checked);
        safeSetStorage(STORAGE_KEYS.thresholdEnabled, String(this.thresholdEnabled));
        this._syncUnitAndThresholdControls();
        this._renderSnapshot(this.engine.getSnapshot(Date.now()));
      });
    }

    if (this.dom.thresholdSlider) {
      this.dom.thresholdSlider.addEventListener('input', (e) => {
        this.setThresholdInCurrentUnit(Number(e.target.value));
      });
    }

    if (this.dom.thresholdMinusBtn) {
      this.dom.thresholdMinusBtn.addEventListener('click', () => {
        const current = Math.round(mpsToUnit(this.thresholdMps, this.unit));
        const minVal = this.unit === 'mph' ? 5 : 10;
        this.setThresholdInCurrentUnit(Math.max(minVal, current - 5));
      });
    }

    if (this.dom.thresholdPlusBtn) {
      this.dom.thresholdPlusBtn.addEventListener('click', () => {
        const current = Math.round(mpsToUnit(this.thresholdMps, this.unit));
        const maxVal = this.unit === 'mph' ? 140 : 220;
        this.setThresholdInCurrentUnit(Math.min(maxVal, current + 5));
      });
    }

    // Developer Simulator Controls
    if (this.dom.demoControlBar) {
      this.dom.demoControlBar.addEventListener('click', (e) => {
        const scenarioBtn = e.target.closest('[data-scenario]');
        if (scenarioBtn) {
          const scenario = scenarioBtn.getAttribute('data-scenario');
          this.startSimulationScenario(scenario);
        }
      });
    }

    if (this.dom.demoStopBtn) {
      this.dom.demoStopBtn.addEventListener('click', () => {
        this.simulator.stop();
        if (this.dom.demoManualControls) {
          this.dom.demoManualControls.hidden = true;
        }
        this.wakeLock.release();
        this.alerts.reset();
        const snapshot = this.engine.pause(Date.now());
        this._syncStartStopButton();
        this._renderSnapshot(snapshot);
      });
    }

    const syncManualSliders = () => {
      const speedKmh = Number(this.dom.simSpeedSlider?.value ?? 65);
      const accuracyMeters = Number(this.dom.simAccSlider?.value ?? 4);
      const rateHz = Number(this.dom.simRateSlider?.value ?? 1.0);

      if (this.dom.simSpeedVal) this.dom.simSpeedVal.textContent = `${speedKmh} km/h`;
      if (this.dom.simAccVal) this.dom.simAccVal.textContent = `\u00B1 ${accuracyMeters} m`;
      if (this.dom.simRateVal) this.dom.simRateVal.textContent = `${rateHz.toFixed(1)} Hz`;

      this.simulator.setManualParams({ speedKmh, accuracyMeters, rateHz });
    };

    if (this.dom.simSpeedSlider) {
      this.dom.simSpeedSlider.addEventListener('input', syncManualSliders);
    }
    if (this.dom.simAccSlider) {
      this.dom.simAccSlider.addEventListener('input', syncManualSliders);
    }
    if (this.dom.simRateSlider) {
      this.dom.simRateSlider.addEventListener('input', syncManualSliders);
    }

    // GNSS & Satellite Info Modal Bottom Sheet
    const openSheet = () => {
      if (this.dom.gnssSheetBackdrop) {
        this.dom.gnssSheetBackdrop.hidden = false;
      }
    };
    const closeSheet = () => {
      if (this.dom.gnssSheetBackdrop) {
        this.dom.gnssSheetBackdrop.hidden = true;
      }
    };

    if (this.dom.gnssInfoBtn) {
      this.dom.gnssInfoBtn.addEventListener('click', openSheet);
    }
    if (this.dom.gnssSheetCloseBtn) {
      this.dom.gnssSheetCloseBtn.addEventListener('click', closeSheet);
    }
    if (this.dom.gnssSheetBackdrop) {
      this.dom.gnssSheetBackdrop.addEventListener('click', (e) => {
        if (e.target === this.dom.gnssSheetBackdrop) {
          closeSheet();
        }
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dom.gnssSheetBackdrop && !this.dom.gnssSheetBackdrop.hidden) {
        closeSheet();
      }
    });

    window.addEventListener('resize', () => {
      this._renderSnapshot(this.engine.getSnapshot(Date.now()));
    });
  }

  _initCompassListener() {
    if (typeof window === 'undefined') return;
    const handleOrientation = (event) => {
      let heading = null;
      if (typeof event.webkitCompassHeading === 'number') {
        heading = event.webkitCompassHeading;
      } else if (event.absolute === true && typeof event.alpha === 'number') {
        heading = (360 - event.alpha) % 360;
      }
      if (heading !== null && Number.isFinite(heading)) {
        this.engine.updateCompassHeading(heading);
      }
    };

    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', handleOrientation, { passive: true });
    } else if ('ondeviceorientation' in window) {
      window.addEventListener('deviceorientation', handleOrientation, { passive: true });
    }
  }

  _syncStartStopButton() {
    if (!this.dom.startStopBtn) return;
    const isActive = this.isTrackingLive || this.simulator.isRunning();
    this.dom.startStopBtn.setAttribute('data-tracking', String(isActive));
    if (this.dom.startStopIcon) {
      this.dom.startStopIcon.innerHTML = isActive ? '&#10074;&#10074;' : '&#9654;';
    }
    if (this.dom.startStopLabel) {
      this.dom.startStopLabel.textContent = isActive ? 'Pause Tracking' : 'Start Tracking';
    }
  }

  _syncAudioMuteUi() {
    if (!this.dom.audioMuteBtn) return;
    const muted = this.alerts.audioMuted;
    this.dom.audioMuteBtn.setAttribute('aria-pressed', String(muted));
    if (this.dom.audioMuteIcon) {
      this.dom.audioMuteIcon.innerHTML = muted ? '&#128263;' : '&#128266;';
    }
    if (this.dom.audioMuteLabel) {
      this.dom.audioMuteLabel.textContent = muted ? 'Muted' : 'Chime On';
    }
  }

  _updateGpsStatusBadge(status, text) {
    if (this.dom.gpsStatusBadge) {
      this.dom.gpsStatusBadge.setAttribute('data-status', status);
    }
    if (this.dom.gpsStatusText) {
      this.dom.gpsStatusText.textContent = text;
    }
  }

  _renderWakeLockStatus(status) {
    if (this.dom.wakeLockChip) {
      this.dom.wakeLockChip.setAttribute('data-active', String(Boolean(status?.active)));
    }
    if (this.dom.wakeLockText) {
      this.dom.wakeLockText.textContent = status?.active
        ? 'Wake: Active'
        : status?.supported === false
          ? 'Wake: N/A'
          : 'Wake: Idle';
    }
  }

  showSnackbar(message, durationMs = 3200) {
    if (!this.dom.appSnackbar) return;
    this.dom.appSnackbar.textContent = message;
    this.dom.appSnackbar.hidden = false;
    if (this.snackbarTimerId !== null) {
      clearTimeout(this.snackbarTimerId);
    }
    this.snackbarTimerId = setTimeout(() => {
      if (this.dom.appSnackbar) {
        this.dom.appSnackbar.hidden = true;
      }
      this.snackbarTimerId = null;
    }, durationMs);
  }

  _registerServiceWorker() {
    if (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      window.isSecureContext
    ) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {
          // Ignore service worker registration errors in restricted preview frames
        });
      });
    }
  }
}

if (typeof document !== 'undefined') {
  const boot = () => {
    const app = new VelocityTelemetryApp();
    app.init();
    window.__velocityApp = app;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
