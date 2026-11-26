import { Database01Icon, Delete02Icon, Download01Icon, RefreshIcon, TestTube01Icon } from '@hugeicons/core-free-icons';
import { Directory, Paths } from 'expo-file-system';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { deleteWifiPassword } from '@/features/pairing/credentials';
import { usePreferences } from '@/state/preferences';
import { useSavedCameras } from '@/state/savedCameras';
import { ConfirmSheet, type ConfirmRequest } from '../components/ConfirmSheet';
import { ActionRow, Group, SwitchRow, ValueRow } from '../components/ui';
import { usePref } from '../components/usePref';
import { SettingsCopy } from '../copy';
import { useSettingsLocal } from '../settingsStore';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function cacheSize(): number | null {
  if (Platform.OS === 'web') return null;
  try {
    return new Directory(Paths.cache).size ?? 0;
  } catch {
    return null;
  }
}

function clearCacheContents() {
  if (Platform.OS === 'web') return;
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      try {
        entry.delete();
      } catch {
        // in use; leave it
      }
    }
  } catch {
    // nothing to clear
  }
}

type Confirm = 'reset' | 'forget' | 'clear' | null;

/** Storage & System: local cache, demo mode and resets (`MonitorCacheSettings`, System tab). */
export function StorageSection() {
  const cacheOriginals = useSettingsLocal((s) => s.cacheFullResolution);
  const setLocal = useSettingsLocal((s) => s.set);
  const resetLocal = useSettingsLocal((s) => s.reset);
  const saved = useSavedCameras((s) => s.cameras);
  const removeCamera = useSavedCameras((s) => s.remove);
  const [demo, setDemo] = usePref('demoMode');
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [summary, setSummary] = useState<{ group: 'cache' | 'system'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const web = Platform.OS === 'web';

  const refresh = useCallback(() => setSize(cacheSize()), []);
  useEffect(refresh, [refresh]);

  const run = () => {
    const which = confirm;
    setConfirm(null);
    if (which === 'clear') {
      setClearing(true);
      const before = cacheSize() ?? 0;
      clearCacheContents();
      const after = cacheSize() ?? 0;
      setClearing(false);
      setSize(after);
      setSummary({ group: 'cache', text: `Cleared ${formatBytes(Math.max(0, before - after))}.` });
    } else if (which === 'reset') {
      usePreferences.getState().reset();
      resetLocal();
      setSummary({ group: 'system', text: 'Operator settings reset to defaults.' });
    } else if (which === 'forget') {
      saved.forEach((c) => {
        removeCamera(c.id);
        if (c.path.ssid) deleteWifiPassword(c.id, c.path.ssid);
      });
      setSummary({ group: 'system', text: 'Saved cameras removed from this phone.' });
    }
  };

  const request: ConfirmRequest | null =
    confirm === 'clear'
      ? { title: 'Clear cache?', message: SettingsCopy.clearCache, confirmTitle: 'Clear', destructive: true }
      : confirm === 'reset'
        ? { title: 'Reset operator settings?', message: SettingsCopy.resetSettings, confirmTitle: 'Reset' }
        : confirm === 'forget'
          ? { title: 'Forget all cameras?', message: SettingsCopy.forgetCameras(saved.length), confirmTitle: 'Forget', destructive: true }
          : null;

  return (
    <>
      <Group label="Cache" note={summary?.group === 'cache' ? summary.text : undefined}>
        <SwitchRow
          icon={Download01Icon}
          title="Full Resolution Caching"
          value={cacheOriginals}
          onChange={(v) => setLocal('cacheFullResolution', v)}
        />
        <ValueRow
          icon={Database01Icon}
          title="Local Media Cache"
          value={size === null ? (web ? 'Not on web' : '—') : formatBytes(size)}
        />
        <ActionRow
          icon={Delete02Icon}
          title="Clear Cache"
          action={clearing ? 'Clearing…' : 'Clear'}
          destructive
          disabled={clearing || web || !size}
          onPress={() => setConfirm('clear')}
          last
        />
      </Group>
      <Group label="System" note={summary?.group === 'system' ? summary.text : web ? SettingsCopy.webDemo : undefined}>
        <SwitchRow
          icon={TestTube01Icon}
          title="Demo camera"
          value={demo || web}
          onChange={setDemo}
          disabled={web}
        />
        <ActionRow
          icon={RefreshIcon}
          title="Reset operator settings"
          action="Reset"
          onPress={() => setConfirm('reset')}
        />
        <ActionRow
          icon={Delete02Icon}
          title="Forget all cameras"
          action="Forget"
          destructive
          disabled={saved.length === 0}
          onPress={() => setConfirm('forget')}
          last
        />
      </Group>
      <ConfirmSheet request={request} onCancel={() => setConfirm(null)} onConfirm={run} />
    </>
  );
}
