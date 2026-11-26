/**
 * Wi-Fi QR payloads (`WIFI:T:WPA;S:<ssid>;P:<pass>;;`) — build (share the camera network) and
 * parse (scan a camera / network QR).
 * Source of truth: OpenCine `OpenCineCameraVocabulary/CameraWiFiQRCode.swift` (build only; parse
 * is new here and follows the ZXing MECARD-style Wi-Fi grammar).
 */
const SPECIAL = '\\;,:"';

function escape(v: string): string {
  let out = '';
  for (const ch of v) {
    if (SPECIAL.includes(ch)) out += '\\';
    out += ch;
  }
  return out;
}

export const CameraWiFiQRCode = {
  payload(ssid: string, password: string): string | null {
    if (!ssid || !password) return null;
    return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;`;
  },
  /** Parse a `WIFI:` QR. Returns null for anything else or a missing SSID. */
  parse(text: string): { ssid: string; password: string | null; security: string | null; hidden: boolean } | null {
    if (!text.toUpperCase().startsWith('WIFI:')) return null;
    const body = text.slice(5);
    const fields: Record<string, string> = {};
    let key = '';
    let value = '';
    let inKey = true;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\\' && i + 1 < body.length) {
        if (inKey) key += body[++i];
        else value += body[++i];
        continue;
      }
      if (inKey) {
        if (ch === ':') inKey = false;
        else if (ch === ';') key = '';
        else key += ch;
      } else if (ch === ';') {
        if (key) fields[key.toUpperCase()] = value;
        key = '';
        value = '';
        inKey = true;
      } else value += ch;
    }
    if (!inKey && key) fields[key.toUpperCase()] = value;
    if (!fields.S) return null;
    return { ssid: fields.S, password: fields.P ?? null, security: fields.T ?? null, hidden: (fields.H ?? '').toLowerCase() === 'true' };
  },
};
