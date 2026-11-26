import type { WifiQr } from './presentation';

/** Web has no reliable QR scanning path here; the typed network form is the way in. */
export const wifiQrScanAvailable = false;

export function WifiQrScanner(_props: { visible: boolean; onClose: () => void; onScanned: (wifi: WifiQr) => void }) {
  return null;
}
