# GPS Speedometer

A responsive, offline-capable GPS Speedometer Progressive Web App (PWA) designed with Material Design 3 Expressive styling.

Built as a **100% standalone, zero-dependency web application** using pure HTML5, CSS3, and vanilla ES2022 JavaScript. No frameworks, bundlers, or build steps required. As a web app, it also works without any installation required.

## Features

- **Real-Time Speedometer** (`km/h` & `mph`): 240° auto-ranging SVG radial gauge and high-contrast digital readout
- **Hybrid Velocity Engine**: Prioritizes hardware GNSS Doppler velocity (`coords.speed`) and falls back to accuracy-gated Haversine distance calculation with exponential smoothing and multipath spike rejection
- **Signal Accuracy & Confidence**: Real-time confidence scoring (`0–100%`), horizontal uncertainty, fix cadence (`Hz`), fix age, and inferred GNSS lock state
- **Speed Limit Alerts**: Configurable threshold with visual and audio alerts as well as haptic feedback
- **Stats & Compass**: Tracks max speed, average speed, trip distance, elapsed time, altitude, and course heading
- **Mobile UX**: Screen Wake Lock integration, optional Dark theme
- **Debugging**: Built-in Developer Telemetry Simulator (`?demo=1` or tap the GPS status pill 5 times)

## Running locally

Serve the root directory over `localhost` or HTTPS (required by browsers for Geolocation and Wake Lock APIs):

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

## Running online

The app is also hosted at `https://strollingheifer.github.io/GPS-Speedometer`

## Running Tests

```bash
node --test tests/telemetry.test.js
```
