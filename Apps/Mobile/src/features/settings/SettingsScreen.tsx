import { ServerStack01Icon, Unlink01Icon, Wifi01Icon, WifiDisconnected01Icon } from '@hugeicons/core-free-icons';
import { Redirect, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import { Icon } from '@/components/icon';
import { SettingsDestructiveButton, SettingsGroup, SettingsRow } from '@/components/settings-ui';
import { Squircle } from '@/components/squircle';
import { useWideLayout } from '@/constants/layout';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { connectionPhaseLabel } from '@/features/pairing/presentation';
import { SettingsScreenPage, ValueText } from './components/ui';
import { tint } from './components/feedback';
import { appVersion } from './diagnostics';
import { gesturesAvailable } from '@/camera/desktop/gestures';
import { sectionInfo, settingsGroups, settingsLanding, visibleSectionIds, type SettingsSectionId } from './sections';

const STATUS_WELL = 44;

/**
 * Operator Setup (`MonitorSettingsPage`): the session's link with Disconnect, then every section as a row that
 * opens its own page at `/settings/<id>`.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const session = useCameraSession();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const phase = useCamera((s) => s.connection.phase);
  const cameraName = useCamera((s) => s.identity?.name);
  const live = phase === 'live';
  // Wide layout: the section list is the split view's column, so Settings opens on a section.
  const wide = useWideLayout();
  if (wide) return <Redirect href={`/settings/${settingsLanding(gesturesAvailable())}`} />;

  const disconnect = () => {
    session.disconnect().catch(() => {});
    router.replace('/');
  };
  const open = (id: SettingsSectionId) => router.push(`/settings/${id}`);

  return (
    <SettingsScreenPage title="Settings" fallback={live ? '/live' : '/'}>
      <SettingsGroup>
        <View style={styles.status}>
          <Squircle
            width={STATUS_WELL}
            height={STATUS_WELL}
            radius={14}
            color={live ? tint(colors.success, 0.16) : colors.surfaceStrong}
          >
            <Icon icon={live ? Wifi01Icon : WifiDisconnected01Icon} size={22} color={live ? colors.success : colors.mutedForeground} />
          </Squircle>
          <View style={styles.statusText} accessible accessibilityRole="summary">
            <Text numberOfLines={1} style={styles.statusTitle}>
              {live ? 'Active link' : 'No camera connected'}
            </Text>
            <Text numberOfLines={1} style={styles.statusMeta}>
              {live && cameraName ? `${cameraName} · ${connectionPhaseLabel(phase)}` : connectionPhaseLabel(phase)}
            </Text>
          </View>
        </View>
        {live ? (
          <View testID="monitor.system.disconnect" style={styles.disconnect}>
            <SettingsDestructiveButton title="Disconnect" icon={Unlink01Icon} onPress={disconnect} />
          </View>
        ) : null}
      </SettingsGroup>
      {desktopCameraEnabled ? null : (
        <SettingsGroup>
          <SettingsRow icon={ServerStack01Icon} title="Server" onPress={() => router.push('/server')} chevron last />
        </SettingsGroup>
      )}
      {settingsGroups.map((group) => {
        const ids = visibleSectionIds(group.ids, gesturesAvailable());
        return (
          <SettingsGroup key={group.label} label={group.label}>
            {ids.map((id, i) => {
              const info = sectionInfo(id);
              if (!info) return null;
              return (
                <View key={id} testID={`monitor.settings.tab.${info.title}`}>
                  <SettingsRow
                    icon={info.icon}
                    title={info.title}
                    accessory={id === 'about' ? <ValueText value={appVersion()} /> : undefined}
                    onPress={() => open(id)}
                    chevron
                    last={i === ids.length - 1}
                  />
                </View>
              );
            })}
          </SettingsGroup>
        );
      })}
    </SettingsScreenPage>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    status: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 12,
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
    },
    disconnect: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    statusText: { flex: 1, minWidth: 0, gap: 2 },
    statusTitle: { fontFamily: fonts.semibold, fontSize: 16, letterSpacing: -0.2, color: colors.foreground },
    statusMeta: { fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground },
  };
}
