/**
 * The home Wi-Fi the desktop keeps for next time (`docs/desktop-expo-port.md` D-1, main
 * 95f567d): when the operator puts the camera on their Wi-Fi, Rust (`pm-desktop` `connect.rs`
 * `station_join`) keeps the network's name and its password sealed to the Windows user
 * (`desktop-homewifi-v1.txt`). The next pair onto that network needs nothing typed.
 *
 * The web only ever learns the name and whether a password is kept (`home_wifi_get`). A join
 * with nothing typed sends no password at all, and Rust uses the kept one.
 *
 * Not persisted here: the file is the backend's. Inert outside Tauri.
 */
import { create } from 'zustand';
import { invoke, isTauri } from './tauri';

/** `home_wifi_get`. */
export interface HomeWifi {
  ssid: string;
  /** A password is kept and opens on this PC (sealed for this Windows user). */
  hasPassword: boolean;
}

export const homeWifiGet = () => invoke<HomeWifi | null>('home_wifi_get');
export const homeWifiForget = () => invoke('home_wifi_forget');

interface HomeWifiState {
  home: HomeWifi | null;
  /** Keep the network typed on the station page (the old checkbox, on by default). */
  remember: boolean;
  refresh: () => Promise<void>;
  forget: () => Promise<void>;
  setRemember: (remember: boolean) => void;
}

export const useDesktopHomeWifi = create<HomeWifiState>()((set) => ({
  home: null,
  remember: true,
  refresh: async () => {
    if (!isTauri()) return;
    try {
      set({ home: (await homeWifiGet()) ?? null });
    } catch {
      // Keep what was shown.
    }
  },
  forget: async () => {
    if (!isTauri()) return;
    await homeWifiForget();
    set({ home: null });
  },
  setRemember: (remember) => set({ remember }),
}));

/** The kept network as a row shows it: "Studio · Password saved", or the name alone. */
export function homeWifiLabel(home: HomeWifi): string {
  return home.hasPassword ? `${home.ssid} · Password saved` : home.ssid;
}

/** The kept network can be joined without typing its password. */
export function joinsByItself(home: HomeWifi | null, ssid: string): boolean {
  return !!home?.hasPassword && home.ssid === ssid.trim();
}

/** The station page's draft, prefilled from the kept network when it is still empty. */
export function prefillFromHome<T extends { ssid: string; password: string }>(draft: T, home: HomeWifi | null): T {
  if (!home || draft.ssid) return draft;
  return { ...draft, ssid: home.ssid };
}

/**
 * `station_join`'s arguments. Nothing typed for the kept network: no `password`, so Rust uses
 * the one it keeps. Anything typed goes as typed (an open network is an empty password).
 */
export function stationJoinArgs(input: {
  address: string;
  ssid: string;
  typed: string | undefined;
  home: HomeWifi | null;
  remember: boolean;
  model?: number;
}): Record<string, unknown> {
  const ssid = input.ssid.trim();
  const typed = input.typed ?? '';
  const useKept = typed.length === 0 && joinsByItself(input.home, ssid);
  return {
    address: input.address,
    ssid,
    ...(useKept ? {} : { password: typed }),
    remember: input.remember,
    ...(input.model != null ? { model: input.model } : {}),
  };
}
