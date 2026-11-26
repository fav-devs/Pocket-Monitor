import { Directory, Paths } from 'expo-file-system';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useSavedCameras } from '@/state/savedCameras';
import { usePreferences } from '@/state/preferences';
import { colors } from '@/theme';
import { deleteWifiPassword } from '@/features/pairing/credentials';
import { ConfirmDialog } from '@/features/pairing/components/Dialogs';
import { CardColumns } from '../components/CardColumns';
import { ActionRow, CardCaption, SettingsCard, SettingsRow, SwitchRow, ValueRow, ActionPill } from '../components/SettingsControls';
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
export function StorageSection({ width }: { width: number }) {
  const cacheOriginals = useSettingsLocal((s) => s.cacheFullResolution);
  const setLocal = useSettingsLocal((s) => s.set);
  const resetLocal = useSettingsLocal((s) => s.reset);
  const saved = useSavedCameras((s) => s.cameras);
  const removeCamera = useSavedCameras((s) => s.remove);
  const [demo, setDemo] = usePref('demoMode');
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

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
      setSummary(`Cleared ${formatBytes(Math.max(0, before - after))}.`);
    } else if (which === 'reset') {
      usePreferences.getState().reset();
      resetLocal();
      setSummary('Operator settings reset to defaults.');
    } else if (which === 'forget') {
      saved.forEach((c) => {
        removeCamera(c.id);
        if (c.path.ssid) deleteWifiPassword(c.id, c.path.ssid);
      });
      setSummary('Saved cameras removed from this phone.');
    }
  };

  return (
    <>
      <CardColumns width={width}>
        <SettingsCard key="cache" title="Cache">
          <SwitchRow
            divider={false}
            title="Full Resolution Caching"
            help={SettingsCopy.cacheFullResolution}
            value={cacheOriginals}
            onChange={(v) => setLocal('cacheFullResolution', v)}
          />
          <ValueRow title="Local Media Cache" help={SettingsCopy.cacheScope} value={size === null ? (Platform.OS === 'web' ? 'Not on web' : '—') : formatBytes(size)} />
          <SettingsRow title="Clear Cache" help={SettingsCopy.clearCache}>
            <ActionPill
              title={clearing ? 'Clearing…' : 'Clear'}
              tint={colors.recording}
              disabled={clearing || Platform.OS === 'web' || !size}
              onPress={() => setConfirm('clear')}
              accessibilityLabel="Clear cache"
            />
          </SettingsRow>
          {summary ? <CardCaption>{summary}</CardCaption> : null}
        </SettingsCard>
        <SettingsCard key="system" title="System">
          <SwitchRow divider={false} title="Demo camera" help={SettingsCopy.demoMode} value={demo || Platform.OS === 'web'} onChange={setDemo} disabled={Platform.OS === 'web'} />
          <ActionRow title="Reset operator settings" help={SettingsCopy.resetSettings} action="Reset" onPress={() => setConfirm('reset')} />
          <ActionRow
            title="Forget all cameras"
            help={SettingsCopy.forgetCameras}
            action="Forget"
            tint={colors.recording}
            disabled={saved.length === 0}
            onPress={() => setConfirm('forget')}
          />
        </SettingsCard>
      </CardColumns>
      <ConfirmDialog
        visible={confirm !== null}
        title={confirm === 'clear' ? 'Clear cache?' : confirm === 'reset' ? 'Reset operator settings?' : 'Forget all cameras?'}
        message={
          confirm === 'clear'
            ? SettingsCopy.clearCache
            : confirm === 'reset'
              ? SettingsCopy.resetSettings
              : `This removes ${saved.length} saved ${saved.length === 1 ? 'camera' : 'cameras'} and their Wi-Fi passwords from this phone. You can pair them again later.`
        }
        confirmTitle={confirm === 'clear' ? 'Clear' : confirm === 'reset' ? 'Reset' : 'Forget'}
        destructive={confirm !== 'reset'}
        onCancel={() => setConfirm(null)}
        onConfirm={run}
      />
    </>
  );
}
