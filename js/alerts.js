/**
 * @fileoverview Multi-Modal Speed Threshold Alert Controller.
 * Implements 0.42 m/s (1.5 km/h) hysteresis band, 10s reminder cadence,
 * Web Audio API two-tone synthesizer (880 Hz -> 1174.66 Hz), and Android Vibration API.
 */

export class ThresholdAlertController {
  /**
   * @param {Object} [options]
   * @param {number} [options.hysteresisMps=0.42] - Hysteresis band in m/s (~1.5 km/h)
   * @param {number} [options.repeatIntervalMs=10000] - Repeat interval in ms while over limit
   */
  constructor({ hysteresisMps = 0.42, repeatIntervalMs = 10000 } = {}) {
    this.hysteresisMps = hysteresisMps;
    this.repeatIntervalMs = repeatIntervalMs;
    this.isOverLimit = false;
    this.lastAlertTimestamp = 0;
    this.audioCtx = null;
    this.audioMuted = false;
    this.hapticsEnabled = true;
  }

  /**
   * Unlocks Web Audio API context on user gesture (e.g. tapping 'Start Tracking').
   */
  unlockHardwareOnUserGesture() {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !this.audioCtx) {
      try {
        this.audioCtx = new AudioCtx();
      } catch (_) {
        // Ignore if audio context creation is blocked
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  /**
   * Explicitly sets audio mute state.
   * @param {boolean} muted
   * @returns {boolean}
   */
  setMuted(muted) {
    this.audioMuted = Boolean(muted);
    return this.audioMuted;
  }

  /**
   * Toggles audio mute state.
   * @returns {boolean} New muted state
   */
  toggleMute() {
    this.audioMuted = !this.audioMuted;
    return this.audioMuted;
  }

  /**
   * Resets over-limit state and alert timer.
   */
  reset() {
    this.isOverLimit = false;
    this.lastAlertTimestamp = 0;
  }

  /**
   * Synthesizes a clean two-tone warning chime (880 Hz -> 1174.66 Hz) via Web Audio API.
   * Safe no-op in headless/Node environments without AudioContext.
   * @param {'urgent'|'remind'} [mode='urgent']
   */
  playWarningChime(mode = 'urgent') {
    if (this.audioMuted || typeof window === 'undefined') return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      const ctx = this.audioCtx;
      const now = ctx.currentTime;

      if (mode === 'urgent') {
        // Two-tone ascending M3 telemetry alert: A5 (880 Hz) -> D6 (1174.66 Hz)
        this._scheduleTone(ctx, 880.0, now, 0.14, 0.22);
        this._scheduleTone(ctx, 1174.66, now + 0.16, 0.2, 0.26);
      } else {
        // Reminder pulse: B5 (987.77 Hz)
        this._scheduleTone(ctx, 987.77, now, 0.14, 0.16);
      }
    } catch (_) {
      // Ignore audio playback errors if browser autoplay policy blocks sound
    }
  }

  /**
   * Schedules a single enveloped oscillator tone.
   * @param {AudioContext} ctx
   * @param {number} freqHz
   * @param {number} startTime
   * @param {number} durationSec
   * @param {number} peakGain
   * @private
   */
  _scheduleTone(ctx, freqHz, startTime, durationSec, peakGain) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freqHz, startTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + durationSec + 0.02);
  }

  /**
   * Evaluates current velocity against threshold with hysteresis and repeat reminders.
   * @param {number} speedMps
   * @param {number} thresholdMps
   * @param {boolean} enabled
   * @param {number} [nowMs=Date.now()]
   * @returns {{ isOverLimit: boolean, justTriggered: boolean, shouldRemind: boolean }}
   */
  evaluate(speedMps, thresholdMps, enabled, nowMs = Date.now()) {
    if (!enabled || !Number.isFinite(thresholdMps) || thresholdMps <= 0) {
      this.isOverLimit = false;
      return { isOverLimit: false, justTriggered: false, shouldRemind: false };
    }

    let justTriggered = false;
    let shouldRemind = false;

    if (!this.isOverLimit && speedMps > thresholdMps) {
      this.isOverLimit = true;
      justTriggered = true;
      this.lastAlertTimestamp = nowMs;
    } else if (
      this.isOverLimit &&
      speedMps <= Math.max(0, thresholdMps - this.hysteresisMps)
    ) {
      this.isOverLimit = false;
    } else if (
      this.isOverLimit &&
      nowMs - this.lastAlertTimestamp >= this.repeatIntervalMs
    ) {
      shouldRemind = true;
      this.lastAlertTimestamp = nowMs;
    }

    if (justTriggered || shouldRemind) {
      if (!this.audioMuted) {
        this.playWarningChime(justTriggered ? 'urgent' : 'remind');
      }
      if (
        this.hapticsEnabled &&
        typeof navigator !== 'undefined' &&
        typeof navigator.vibrate === 'function'
      ) {
        try {
          navigator.vibrate(justTriggered ? [180, 90, 220] : [140]);
        } catch (_) {
          // Ignore vibration errors on unsupported desktop platforms
        }
      }
    }

    return { isOverLimit: this.isOverLimit, justTriggered, shouldRemind };
  }
}
