import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Camera and network Wi-Fi passwords. Secure storage on phones; web keeps them in memory only
 * (there is no secure store in a browser and the demo camera needs none).
 */
const memory = new Map<string, string>();
const keyFor = (cameraId: string, ssid: string) => `pm.wifi.${cameraId}.${ssid}`.replace(/[^A-Za-z0-9._-]/g, '_');

export async function saveWifiPassword(cameraId: string, ssid: string, password: string): Promise<void> {
  const key = keyFor(cameraId, ssid);
  if (Platform.OS === 'web') {
    memory.set(key, password);
    return;
  }
  try {
    await SecureStore.setItemAsync(key, password);
  } catch {
    memory.set(key, password);
  }
}

export async function readWifiPassword(cameraId: string, ssid: string): Promise<string | undefined> {
  const key = keyFor(cameraId, ssid);
  if (Platform.OS === 'web') return memory.get(key);
  try {
    return (await SecureStore.getItemAsync(key)) ?? memory.get(key);
  } catch {
    return memory.get(key);
  }
}

export async function deleteWifiPassword(cameraId: string, ssid: string): Promise<void> {
  const key = keyFor(cameraId, ssid);
  memory.delete(key);
  if (Platform.OS === 'web') return;
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // nothing stored
  }
}
