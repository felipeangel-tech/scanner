# Scan2PDF — PWA Document Scanner

A no-build, installable Progressive Web App. Scan documents with the iPhone
camera, enhance them, combine into a multi-page PDF, and share via the native
iOS share sheet (Mail, Messages, Files, AirDrop, etc.).

## Features
- 📷 Live camera capture (rear camera, high-res) + import from photo library
- 🎚️ Per-page enhancement filters: **Auto / Gray / B&W / Color**
- 🗂️ Multi-page review grid — reorder by deleting, **rotate**, or **delete** pages
- 📄 One-tap **Export PDF** (A4, auto-fit, compressed)
- 📤 **Share** via the iOS share sheet (Web Share API, with download fallback)
- 📲 Installable to the Home Screen, works **offline** (service worker)

## Why it needs HTTPS
Browsers only grant camera access on `https://` or `http://localhost`. To use it
on your iPhone you must serve the folder over HTTPS. Easiest options:

### Option A — Free hosting (recommended)
Drag the `scanner-pwa` folder onto **https://app.netlify.com/drop** (or use
Vercel / GitHub Pages / Cloudflare Pages). You get an HTTPS URL instantly.

### Option B — Local network with a tunnel
```
cd scanner-pwa
python -m http.server 5180
npx localtunnel --port 5180     # or: ngrok http 5180
```
Open the generated HTTPS URL on the iPhone.

## Install on iPhone
1. Open the HTTPS URL in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Launch it from the Home Screen — it runs full-screen like a native app.
4. On first scan, allow camera access when prompted.

## Files
- `index.html`, `styles.css`, `app.js` — the app
- `manifest.json`, `service-worker.js`, `icons/` — PWA install + offline
- `vendor/jspdf.umd.min.js` — bundled PDF engine (no CDN, works offline)
