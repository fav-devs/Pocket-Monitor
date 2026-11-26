/**
 * Saved camera records, Wi-Fi credential resolution (memory → keychain → saved SSID), found-camera
 * identity rules and the pairing wizard step.
 * Source of truth: fork `Sources/OpenPocketViewCore/SavedCamera.swift`. Credentials themselves
 * live in secure storage (src/state, not owned here); these are the pure rules.
 */
import type { CameraModelId, SavedCamera as UISavedCamera } from '../../camera/types';
import type { CameraConnectionPhase } from '../connection/phase';
import { resolveFamily } from '../status/cameraModel';

export interface SavedCameraRecord {
  id: string;
  advertisedName: string;
  modelName: string;
  modelId: number | null;
  lastSSID: string | null;
  /** epoch ms */
  lastConnectedAt: number;
  customName: string | null;
}

export const savedCameraDisplayName = (c: SavedCameraRecord) =>
  c.customName && c.customName.trim() ? c.customName : c.advertisedName || c.modelName;

export const FoundCameraIdentity = {
  isGenericName(name: string): boolean {
    const n = name.trim().toLowerCase();
    return n === '' || n === 'dji camera' || n === 'dji osmo camera';
  },
  shouldReplace(existingName: string, existingModelId: number | null, incomingName: string, incomingModelId: number | null): boolean {
    const g = FoundCameraIdentity.isGenericName;
    if (g(incomingName)) return g(existingName) && existingModelId == null && incomingModelId != null;
    if (g(existingName)) return true;
    if (existingName.trim() !== incomingName.trim()) return true;
    return existingModelId == null && incomingModelId != null;
  },
  enriched(name: string, modelId: number | null, savedName: string | null, savedModelId: number | null): { name: string; modelId: number | null } {
    let n = name;
    if (FoundCameraIdentity.isGenericName(n) && savedName && !FoundCameraIdentity.isGenericName(savedName)) n = savedName;
    return { name: n, modelId: modelId ?? savedModelId };
  },
  listTitle: (advertisedName: string, modelName: string) => (FoundCameraIdentity.isGenericName(advertisedName) ? modelName : advertisedName),
  listSubtitle(advertisedName: string, modelName: string): string {
    const f = resolveFamily(null, modelName);
    const kind = f === 'pocket' ? 'Pocket' : f === 'nano' ? 'Nano' : modelName;
    if (FoundCameraIdentity.isGenericName(advertisedName) || advertisedName === modelName) return `${kind} · nearby`;
    return `${kind} · ${modelName} · nearby`;
  },
};

export interface WifiMemory {
  cameraId: string;
  ssid: string;
  password: string;
}

export interface WifiResolution {
  ssid: string | null;
  password: string | null;
  source: 'memory' | 'keychain' | 'none';
  /** True when both SSID and password are known — skip BLE GetSSID/GetPassword. */
  skipBle: boolean;
}

export const CameraWifiResolution = {
  liveAdvertisedSSID(name: string | null | undefined): string | null {
    if (name == null) return null;
    const t = name.trim();
    return t && !FoundCameraIdentity.isGenericName(t) ? t : null;
  },
  resolve(o: {
    cameraId: string;
    savedSSID: string | null;
    memory: WifiMemory | null;
    keychainSSID: string | null;
    keychainPassword: string | null;
    advertisedName?: string | null;
  }): WifiResolution {
    const memoryMatches = o.memory?.cameraId === o.cameraId;
    const memSsid = memoryMatches ? (o.memory?.ssid ?? null) : null;
    const memPass = memoryMatches ? (o.memory?.password ?? null) : null;
    const cachedSsid = [memSsid, o.keychainSSID, o.savedSSID].map((s) => s?.trim() ?? null).find((s) => !!s) ?? null;
    const password = [memPass, o.keychainPassword].find((p) => !!p) ?? null;
    const live = CameraWifiResolution.liveAdvertisedSSID(o.advertisedName);
    const ssid = live && cachedSsid && live !== cachedSsid ? live : cachedSsid;
    const memoryHit = memoryMatches && !!memSsid && !!memPass;
    const keychainHit = !!o.keychainSSID && !!o.keychainPassword;
    const source = memoryHit ? 'memory' : keychainHit ? 'keychain' : 'none';
    return { ssid, password, source, skipBle: !!password && !!ssid && (memoryHit || keychainHit) };
  },
  isSSIDOwnedByAnotherCamera(ssid: string, cameraId: string, saved: SavedCameraRecord[]): boolean {
    const needle = ssid.trim().toLowerCase();
    if (!needle) return false;
    return saved.some((o) => o.id !== cameraId && ((o.lastSSID ?? '').trim().toLowerCase() === needle || o.advertisedName.trim().toLowerCase() === needle));
  },
};

export const SavedCameras = {
  canonicalized(records: SavedCameraRecord[]): SavedCameraRecord[] {
    const seen = new Set<string>();
    const unique = records.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    return unique.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  },
  upserting(camera: SavedCameraRecord, records: SavedCameraRecord[]): SavedCameraRecord[] {
    const merged = { ...camera };
    const existing = records.find((r) => r.id === camera.id);
    if (existing) {
      if (merged.customName == null) merged.customName = existing.customName;
      if (merged.lastSSID == null) merged.lastSSID = existing.lastSSID;
      if (!merged.advertisedName) merged.advertisedName = existing.advertisedName;
      if (merged.modelId == null) merged.modelId = existing.modelId;
    }
    return SavedCameras.canonicalized([merged, ...records.filter((r) => r.id !== camera.id)]);
  },
  removing: (id: string, records: SavedCameraRecord[]) => SavedCameras.canonicalized(records.filter((r) => r.id !== id)),
  renaming(id: string, name: string | null, records: SavedCameraRecord[]): SavedCameraRecord[] {
    const t = name?.trim();
    const custom = t ? t : null;
    return SavedCameras.canonicalized(records.map((r) => (r.id === id ? { ...r, customName: custom } : r)));
  },
  launchDestination: (records: SavedCameraRecord[]): 'addCamera' | 'savedCameras' =>
    SavedCameras.canonicalized(records).length === 0 ? 'addCamera' : 'savedCameras',
};

/** BLE GATT: only accept the peripheral the operator selected. */
export const acceptsGATT = (peripheral: string, selected: string | null) => selected != null && peripheral === selected;

export function pocketWizardStep(p: CameraConnectionPhase): number {
  switch (p.kind) {
    case 'idle':
    case 'scanning':
    case 'failed':
      return 1;
    case 'connectingGatt':
    case 'pairing':
    case 'awaitingApproval':
      return 2;
    case 'readingWifiCreds':
    case 'joiningWifi':
      return 3;
    default:
      return 4;
  }
}
export const POCKET_WIZARD_STEP_COUNT = 4;

/** Map a record onto the UI contract's `SavedCamera` (SoftAP path by default). */
export function toUISavedCamera(r: SavedCameraRecord, model: CameraModelId): UISavedCamera {
  return {
    id: r.id,
    name: savedCameraDisplayName(r),
    model,
    path: { kind: 'softap', ssid: r.lastSSID ?? r.advertisedName },
    lastConnectedAt: r.lastConnectedAt,
  };
}
