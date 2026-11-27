import {
  Agreement01Icon,
  CodeIcon,
  File01Icon,
  GithubIcon,
  InformationCircleIcon,
  LicenseIcon,
  Moon02Icon,
  Shield01Icon,
  Sun03Icon,
} from '@hugeicons/core-free-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { appBrand } from '@/features/startup/brand';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { Group, LinkRow, ValueRow } from '../components/ui';
import { SettingsCopy } from '../copy';
import { appVersion } from '../diagnostics';
import type { LegalPage } from '../legal';

const ICON = 64;

/** About & Legal (`MonitorAppInformationSettings` + `MonitorProjectLegalSettings`). */
export function AboutSection({ onLegal }: { onLegal: (page: LegalPage) => void }) {
  const { scheme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [confirmSource, setConfirmSource] = useState(false);
  return (
    <>
      <View style={styles.brand}>
        <Image source={require('../../../../assets/icon.png')} style={styles.icon} accessibilityIgnoresInvertColors />
        <View style={styles.brandText}>
          <Text style={styles.name}>{appBrand.name}</Text>
        </View>
      </View>
      <Group label="App information">
        <ValueRow
          icon={scheme === 'dark' ? Moon02Icon : Sun03Icon}
          title="Theme"
          value={scheme === 'dark' ? 'Dark' : 'Light'}
        />
        <ValueRow icon={CodeIcon} title="Protocol" value="DUML / BLE + Wi-Fi" />
        <ValueRow icon={InformationCircleIcon} title="App Version" value={appVersion()} />
        <ValueRow icon={LicenseIcon} title="License" value="Apache-2.0" last />
      </Group>
      <Group label="Project & legal">
        <LinkRow icon={GithubIcon} title="Source Code" onPress={() => setConfirmSource(true)} />
        <LinkRow icon={Shield01Icon} title="Privacy" onPress={() => onLegal('privacy')} />
        <LinkRow icon={Agreement01Icon} title="Terms" onPress={() => onLegal('terms')} />
        <LinkRow icon={LicenseIcon} title="Licenses" onPress={() => onLegal('licenses')} />
        <LinkRow icon={File01Icon} title="NOTICE" onPress={() => onLegal('notice')} last />
      </Group>
      <Group label="Independence">
        <Text style={styles.independence}>
          {`${appBrand.name} is an unofficial, open-source field monitor. It is not affiliated with or endorsed by SZ DJI Technology Co., Ltd. "DJI", "Osmo", "Osmo Pocket", and "Mimo" are trademarks of SZ DJI Technology Co., Ltd., used for identification only. No DJI SDK or proprietary DJI documentation is included in, distributed with, or required by this app.`}
        </Text>
      </Group>
      <ConfirmSheet
        request={
          confirmSource
            ? { title: 'Open Source Code?', message: SettingsCopy.browserConfirmation, confirmTitle: 'Open' }
            : null
        }
        onCancel={() => setConfirmSource(false)}
        onConfirm={() => {
          setConfirmSource(false);
          Linking.openURL(appBrand.sourceUrl).catch(() => {});
        }}
      />
    </>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    brand: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md, paddingVertical: 2 },
    icon: { width: ICON, height: ICON, borderRadius: 16, backgroundColor: colors.surface },
    brandText: { flex: 1, minWidth: 0, gap: 4 },
    name: { fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.4, color: colors.foreground },
    independence: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.mutedForeground, padding: spacing.md },
  };
}
