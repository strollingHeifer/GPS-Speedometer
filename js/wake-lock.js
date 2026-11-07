/**
 * @fileoverview Screen Wake Lock API Manager with automatic visibilitychange re-acquisition.
 * Keeps the smartphone display awake while live telemetry or simulation is active.
 */

export class WakeLockManager {
  /**
   * @param {Object} [options]
   * @param {function({ active: boolean, supported: boolean, state: string, statusText: string }): void} [options.onStatusChange]
   */
  constructor({ onStatusChange } = {}) {
    this.onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : null;
    this.sentinel = null;
    this.shouldKeepAwake = false;
    this.state = this.isSupported() ? 'inactive' : 'unsupported';
    this._visibilityListenerAttached = false;
    this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
    this.setupVisibilityReacquire();
  }

  /**
   * Checks whether the browser supports the Screen Wake Lock API.
   * @returns {boolean}
   */
  isSupported() {
    return (
      typeof navigator !== 'undefined' &&
      'wakeLock' in navigator &&
      typeof navigator.wakeLock?.request === 'function'
    );
  }

  /**
   * Attaches a visibilitychange listener to re-acquire wake lock when returning to foreground.
   */
  setupVisibilityReacquire() {
    if (this._visibilityListenerAttached || typeof document === 'undefined') {
      return;
    }
    document.addEventListener('visibilitychange', this._handleVisibilityChange);
    this._visibilityListenerAttached = true;
  }

  /**
   * Handles document visibility transitions.
   * @private
   */
  async _handleVisibilityChange() {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      this.shouldKeepAwake &&
      (!this.sentinel || this.sentinel.released)
    ) {
      await this.request();
    }
  }

  /**
   * Requests an active Screen Wake Lock sentinel.
   * @returns {Promise<boolean>} True if wake lock was acquired
   */
  async request() {
    this.shouldKeepAwake = true;
    this.setupVisibilityReacquire();

    if (!this.isSupported()) {
      this._updateState('unsupported');
      return false;
    }

    if (this.sentinel && !this.sentinel.released) {
      this._updateState('active');
      return true;
    }

    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        if (this.sentinel?.released) {
          this._updateState('inactive');
        }
      });
      this._updateState('active');
      return true;
    } catch (_) {
      this._updateState('error');
      return false;
    }
  }

  /**
   * Releases any active Screen Wake Lock sentinel and disables auto-reacquire.
   * @returns {Promise<void>}
   */
  async release() {
    this.shouldKeepAwake = false;
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch (_) {
        // Ignore release errors if already released by OS
      }
      this.sentinel = null;
    }
    this._updateState(this.isSupported() ? 'inactive' : 'unsupported');
  }

  /**
   * Updates internal status and notifies subscriber.
   * @param {'active'|'inactive'|'unsupported'|'error'} nextState
   * @private
   */
  _updateState(nextState) {
    this.state = nextState;
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }

  /**
   * Returns current wake lock status descriptor.
   * @returns {{ active: boolean, supported: boolean, state: string, statusText: string }}
   */
  getStatus() {
    const supported = this.isSupported();
    const active = Boolean(this.sentinel && !this.sentinel.released && this.state === 'active');

    let statusText = 'Wake Lock Off';
    if (!supported) {
      statusText = 'Wake Lock N/A';
    } else if (active) {
      statusText = 'Screen Awake';
    } else if (this.state === 'error') {
      statusText = 'Wake Lock Blocked';
    }

    return {
      active,
      supported,
      state: this.state,
      statusText,
    };
  }
}
