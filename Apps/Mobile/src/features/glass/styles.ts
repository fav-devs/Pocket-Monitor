/**
 * The web glass (`data-pocket-glass="<kind>"`): CSS `backdrop-filter` blur and saturation, a
 * one-pixel specular top edge, a hairline rim, a soft shadow, hover brightening and a pressed
 * state, tuned after macOS 26's glass buttons. One look in WKWebView and WebView2 (no SVG
 * refraction, which WKWebView's `backdrop-filter` lacks). `!important` so it wins over the
 * component's own background classes; the component keeps its label, icon and layout.
 *
 * `data-pocket-glass-native` (set by `sync.ts` once the desktop drew a native glass view
 * there) makes the background transparent so the native glass under the web view shows,
 * keeping a light hover and press wash.
 */

import { Platform } from 'react-native';

export type GlassKind = 'button' | 'prominent' | 'item' | 'card' | 'surface';

const isWeb = Platform.OS === 'web';
let installed = false;

const css = `
:root {
  --pg-fill: rgba(255,255,255,0.62);
  --pg-fill-hover: rgba(255,255,255,0.86);
  --pg-fill-press: rgba(228,228,232,0.78);
  --pg-rim: rgba(0,0,0,0.085);
  --pg-spec: rgba(255,255,255,0.95);
  --pg-shade: rgba(0,0,0,0.03);
  --pg-shadow: 0 0.5px 1px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.07);
  --pg-prom: rgba(28,28,28,0.88);
  --pg-prom-hover: rgba(28,28,28,0.78);
  --pg-prom-press: rgba(28,28,28,0.95);
  --pg-prom-spec: rgba(255,255,255,0.26);
  --pg-prom-rim: rgba(0,0,0,0.25);
  --pg-item: rgba(255,255,255,0.7);
  --pg-card: rgba(255,255,255,0.5);
  --pg-surface: rgba(252,252,253,0.84);
  --pg-solid: #f5f5f5;
  --pg-native-hover: rgba(0,0,0,0.045);
  --pg-native-press: rgba(0,0,0,0.09);
  --pg-material-wash: rgba(236,236,240,0.58);
  --pg-material-hover: rgba(0,0,0,0.05);
}
html[data-pocket-scheme="dark"] {
  --pg-fill: rgba(255,255,255,0.085);
  --pg-fill-hover: rgba(255,255,255,0.15);
  --pg-fill-press: rgba(255,255,255,0.05);
  --pg-rim: rgba(255,255,255,0.11);
  --pg-spec: rgba(255,255,255,0.2);
  --pg-shade: rgba(0,0,0,0.22);
  --pg-shadow: 0 0.5px 1px rgba(0,0,0,0.4), 0 3px 12px rgba(0,0,0,0.32);
  --pg-prom: rgba(244,244,244,0.92);
  --pg-prom-hover: rgba(244,244,244,0.82);
  --pg-prom-press: rgba(244,244,244,0.98);
  --pg-prom-spec: rgba(255,255,255,0.9);
  --pg-prom-rim: rgba(255,255,255,0.3);
  --pg-item: rgba(255,255,255,0.12);
  --pg-card: rgba(255,255,255,0.055);
  --pg-surface: rgba(30,30,32,0.8);
  --pg-solid: #1a1a1a;
  --pg-native-hover: rgba(255,255,255,0.07);
  --pg-native-press: rgba(255,255,255,0.12);
  --pg-material-wash: rgba(34,34,36,0.6);
  --pg-material-hover: rgba(255,255,255,0.07);
}
[data-pocket-glass] {
  background-color: var(--pg-fill) !important;
  background-image: linear-gradient(to bottom, rgba(255,255,255,0.14), rgba(255,255,255,0) 55%) !important;
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  backdrop-filter: blur(16px) saturate(180%);
  box-shadow: inset 0 1px 0 0 var(--pg-spec), inset 0 0 0 0.5px var(--pg-rim), inset 0 -1px 0 0 var(--pg-shade), var(--pg-shadow);
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
[data-pocket-glass]:hover { background-color: var(--pg-fill-hover) !important; }
[data-pocket-glass]:active { background-color: var(--pg-fill-press) !important; }
[data-pocket-glass="prominent"] {
  background-color: var(--pg-prom) !important;
  background-image: linear-gradient(to bottom, rgba(255,255,255,0.12), rgba(255,255,255,0) 60%) !important;
  box-shadow: inset 0 1px 0 0 var(--pg-prom-spec), inset 0 0 0 0.5px var(--pg-prom-rim), var(--pg-shadow);
}
[data-pocket-glass="prominent"]:hover { background-color: var(--pg-prom-hover) !important; }
[data-pocket-glass="prominent"]:active { background-color: var(--pg-prom-press) !important; }
[data-pocket-glass="item"] {
  background-color: var(--pg-item) !important;
  box-shadow: inset 0 1px 0 0 var(--pg-spec), inset 0 0 0 0.5px var(--pg-rim), 0 0.5px 1px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.05);
}
[data-pocket-glass="item"]:hover, [data-pocket-glass="item"]:active { background-color: var(--pg-item) !important; }
[data-pocket-glass="card"] {
  background-color: var(--pg-card) !important;
  box-shadow: inset 0 1px 0 0 var(--pg-spec), inset 0 0 0 0.5px var(--pg-rim);
}
[data-pocket-glass="card"]:not([role="button"]):hover, [data-pocket-glass="card"]:not([role="button"]):active { background-color: var(--pg-card) !important; }
[data-pocket-glass="surface"] {
  background-color: var(--pg-surface) !important;
  -webkit-backdrop-filter: blur(32px) saturate(180%);
  backdrop-filter: blur(32px) saturate(180%);
  box-shadow: inset 0 1px 0 0 var(--pg-spec), inset 0 0 0 0.5px var(--pg-rim), 0 24px 64px rgba(0,0,0,0.28);
}
[data-pocket-glass="surface"]:hover, [data-pocket-glass="surface"]:active { background-color: var(--pg-surface) !important; }
[data-pocket-glass][aria-disabled="true"]:hover, [data-pocket-glass][aria-disabled="true"]:active { background-color: var(--pg-fill) !important; }
[data-pocket-glass="prominent"][aria-disabled="true"]:hover { background-color: var(--pg-prom) !important; }
[data-pocket-glass][data-pocket-glass-native] {
  background-color: transparent !important;
  background-image: none !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  box-shadow: none !important;
}
[data-pocket-glass][data-pocket-glass-native]:hover { background-color: var(--pg-native-hover) !important; }
[data-pocket-glass][data-pocket-glass-native]:active { background-color: var(--pg-native-press) !important; }
[data-pocket-glass="item"][data-pocket-glass-native]:hover, [data-pocket-glass="card"][data-pocket-glass-native]:not([role="button"]):hover { background-color: transparent !important; }
[data-pocket-material-hover]:hover { background-color: var(--pg-material-hover) !important; }
@media (prefers-reduced-transparency: reduce) {
  [data-pocket-glass] { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background-image: none !important; }
  [data-pocket-glass]:not([data-pocket-glass="prominent"]) { background-color: var(--pg-solid) !important; }
}
`;

/** Installs the glass stylesheet once (web only). */
export function installGlassStyles() {
  if (!isWeb || installed || typeof document === 'undefined') return;
  installed = true;
  const style = document.createElement('style');
  style.setAttribute('data-pocket', 'glass');
  style.textContent = css;
  document.head.appendChild(style);
}

/** The glass variables follow the app's scheme, not only the system's. */
export function setGlassScheme(scheme: 'light' | 'dark') {
  if (!isWeb || typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-pocket-scheme', scheme);
}

let backdrop = false;

/**
 * `?glassPreview=1`: a colourful stand-in for the desktop behind the window, and a CSS stand-in
 * for the native sidebar material, so the glass can be judged in a browser.
 */
export function installPreviewBackdrop() {
  if (!isWeb || backdrop || typeof document === 'undefined') return;
  backdrop = true;
  const style = document.createElement('style');
  style.setAttribute('data-pocket', 'glass-preview');
  style.textContent = `
html::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background-color: #3b4ee8;
  background-image:
    radial-gradient(circle at 8% 18%, #ff5f6d 0, rgba(255,95,109,0) 34%),
    radial-gradient(circle at 22% 62%, #ffc371 0, rgba(255,195,113,0) 30%),
    radial-gradient(circle at 4% 92%, #21d4fd 0, rgba(33,212,253,0) 36%),
    radial-gradient(circle at 34% 30%, #b721ff 0, rgba(183,33,255,0) 32%),
    linear-gradient(135deg, #0f9b8e 0%, #3b4ee8 55%, #d6155f 100%);
}
[data-pocket-material-preview] {
  background-color: var(--pg-material-wash) !important;
  -webkit-backdrop-filter: blur(48px) saturate(190%);
  backdrop-filter: blur(48px) saturate(190%);
}
#pm-glass-preview { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
#pm-glass-preview > div { position: absolute; box-sizing: border-box; border: 1.5px dashed #ff2fb3; }
`;
  document.head.appendChild(style);
}
