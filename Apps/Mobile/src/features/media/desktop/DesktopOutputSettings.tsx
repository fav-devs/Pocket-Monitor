/**
 * Desktop-only settings groups (§1.W, §1.U U8): the virtual camera (the old Output tab) and this
 * computer's media cache. Rendered by `MediaSettingsPanel` inside the desktop app only; on a
 * phone and in the browser demo it renders nothing.
 */
import {
  ComputerIcon,
  HardDriveIcon,
  Link01Icon,
  PuzzleIcon,
  Video01Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useCameraSession } from '@/camera';
import { isDesktopMedia } from '@/camera/desktop/media';
import { isTauri } from '@/camera/desktop/tauri';
import { OBS_RECIPE, vcam, type VcamMode, type VcamStatus } from '@/camera/desktop/vcam';
import { Icon } from '@/components/icon';
import { SegmentedControl } from '@/components/segmented-control';
import { SettingsGroup } from '@/components/settings-ui';
import { Squircle } from '@/components/squircle';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { byteLabel } from '../format';
import { Busy, TextAction } from '../MediaChips';

function Row({ icon, title, value, children, last }: { icon: IconSvgElement; title: string; value?: string; children?: ReactNode; last?: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={styles.head}>
        <Squircle width={36} height={36} radius={12} color={colors.surfaceStrong}>
          <Icon icon={icon} size={18} color={colors.foreground} />
        </Squircle>
        <View style={styles.text}>
          <Text style={styles.title}>{title}</Text>
          {value ? (
            <Text style={styles.value} numberOfLines={2}>
              {value}
            </Text>
          ) : null}
        </View>
      </View>
      {children}
    </View>
  );
}

const MODES: ReadonlyArray<{ value: VcamMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'device', label: 'Camera device' },
  { value: 'stream', label: 'Stream' },
];

const PICTURE: ReadonlyArray<{ value: 'shown' | 'clean'; label: string }> = [
  { value: 'shown', label: 'As shown' },
  { value: 'clean', label: 'Clean' },
];

function VirtualCameraGroup() {
  const styles = useThemedStyles(createStyles);
  const [status, setStatus] = useState<VcamStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    vcam
      .get()
      .then(setStatus)
      .catch((e) => setError(String(e)));
    const stops = [
      vcam.onStatus(setStatus),
      vcam.onComponent((component) => setStatus((s) => (s ? { ...s, component } : s))),
    ];
    return () => stops.forEach((s) => s());
  }, []);

  const change = (next: { mode?: VcamMode; clean?: boolean }) => {
    vcam
      .set(next)
      .then(setStatus)
      .catch((e) => setError(String(e)));
  };

  if (!status) {
    return (
      <SettingsGroup label="Virtual camera">
        <View style={styles.row}>{error ? <Text style={styles.value}>{error}</Text> : <Busy label="Checking…" />}</View>
      </SettingsGroup>
    );
  }
  const component = status.component;
  const busy = component.state === 'busy' || component.state === 'unknown';
  return (
    <View style={styles.groupWithNote}>
      <SettingsGroup label="Virtual camera">
        <Row icon={Video01Icon} title="Output">
          <SegmentedControl options={MODES} value={status.mode} onChange={(mode) => change({ mode })} accessibilityLabel="Virtual camera output" />
        </Row>
        <Row icon={ViewIcon} title="Picture">
          <SegmentedControl
            options={PICTURE}
            value={status.clean ? 'clean' : 'shown'}
            onChange={(v) => change({ clean: v === 'clean' })}
            accessibilityLabel="Virtual camera picture"
          />
        </Row>
        <Row icon={ComputerIcon} title="Camera output" value={status.output} />
        <Row icon={PuzzleIcon} title="Camera component" value={[component.label, component.platform].filter(Boolean).join(' · ')}>
          {component.detail ? <Text style={styles.value}>{component.detail}</Text> : null}
          {busy ? (
            <Busy label={component.label} />
          ) : component.canInstall || component.canRemove ? (
            <View style={styles.actions}>
              {component.canInstall ? <TextAction title="Install" onPress={() => void vcam.install()} /> : null}
              {component.canRemove ? <TextAction title="Remove" tone="destructive" onPress={() => void vcam.remove()} /> : null}
            </View>
          ) : null}
        </Row>
        <Row icon={Link01Icon} title="Stream" value={status.streamUrl} last>
          <View style={styles.actions}>
            <TextAction title="Open in the browser" disabled={status.mode !== 'stream'} onPress={() => void vcam.openUrl(status.streamUrl).catch(() => setError('Could not open the browser.'))} />
          </View>
        </Row>
      </SettingsGroup>
      <Text style={styles.note}>{`OBS: ${OBS_RECIPE}`}</Text>
      {error ? <Text style={styles.note}>{error}</Text> : null}
    </View>
  );
}

function CacheGroup() {
  const styles = useThemedStyles(createStyles);
  const session = useCameraSession();
  const service = session.media;
  const [bytes, setBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (!isDesktopMedia(service)) return;
    service
      .cacheSize()
      .then(setBytes)
      .catch(() => setBytes(null));
  }, [service]);
  if (!isDesktopMedia(service)) return null;
  const clear = () => {
    setClearing(true);
    service
      .clearCache()
      .then(() => setBytes(0))
      .catch(() => {})
      .finally(() => setClearing(false));
  };
  return (
    <SettingsGroup label="On this computer">
      <Row icon={HardDriveIcon} title="Camera media cache" value={bytes == null ? '—' : byteLabel(bytes)} last>
        <View style={styles.actions}>
          {clearing ? <Busy label="Clearing…" /> : <TextAction title="Clear" tone="destructive" disabled={!bytes} onPress={clear} label="Clear the camera media cache" />}
        </View>
      </Row>
    </SettingsGroup>
  );
}

/** Nothing outside the desktop app. */
export default function DesktopOutputSettings() {
  if (!isTauri()) return null;
  return (
    <>
      <VirtualCameraGroup />
      <CacheGroup />
    </>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    groupWithNote: { gap: spacing.sm },
    row: { paddingHorizontal: spacing.md, paddingVertical: 12, gap: 10 },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
    text: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    value: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    actions: { flexDirection: 'row' as const, gap: spacing.md, alignItems: 'center' as const },
    note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, paddingHorizontal: 4 },
  };
}
