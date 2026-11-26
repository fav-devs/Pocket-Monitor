import { useState } from 'react';
import { Linking, View } from 'react-native';
import { ConfirmDialog } from '@/features/pairing/components/Dialogs';
import { BrandMark, BrandWordmark } from '@/features/startup/LaunchSplash';
import { appBrand } from '@/features/startup/brand';
import { MText, colors } from '@/theme';
import { CardColumns, FullWidth } from '../components/CardColumns';
import { ActionRow, SettingsCard, ValueRow } from '../components/SettingsControls';
import { SettingsCopy } from '../copy';
import { appVersion } from '../diagnostics';
import type { LegalPage } from '../legal';

/** About & Legal (`MonitorAppInformationSettings` + `MonitorProjectLegalSettings`). */
export function AboutSection({ width, onLegal }: { width: number; onLegal: (page: LegalPage) => void }) {
  const [confirmSource, setConfirmSource] = useState(false);
  return (
    <>
      <CardColumns width={width}>
        <FullWidth key="brand">
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 16,
              padding: 16,
              borderRadius: 12,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <BrandMark size={56} />
            <View style={{ flex: 1 }}>
              <BrandWordmark fontSize={22} subtitle={`Field monitor for DJI Osmo cameras · ${appVersion()}`} />
            </View>
          </View>
        </FullWidth>
        <SettingsCard key="info" title="App Information">
          <ValueRow divider={false} title="Theme" help={SettingsCopy.themeHelp} value="Charcoal · Sky Blue" />
          <ValueRow title="Protocol Implementation" help={SettingsCopy.protocolHelp} value="DUML / BLE + Wi-Fi" />
          <ValueRow title="App Version" help={SettingsCopy.versionHelp} value={appVersion()} />
          <ValueRow title="License" value="Apache-2.0" />
        </SettingsCard>
        <SettingsCard key="legal" title="Project & Legal">
          <ActionRow divider={false} title="Source Code" help={SettingsCopy.sourceHelp} action="Open" onPress={() => setConfirmSource(true)} />
          <ActionRow title="Privacy" help="What this app stores on this phone." action="Open" onPress={() => onLegal('privacy')} />
          <ActionRow title="Terms" help={SettingsCopy.termsHelp} action="Open" onPress={() => onLegal('terms')} />
          <ActionRow title="Licenses" help="Apache 2.0, Sora (OFL) and Lucide (ISC)." action="Open" onPress={() => onLegal('licenses')} />
          <ActionRow title="NOTICE" help="Attribution shipped with the app." action="Open" onPress={() => onLegal('notice')} />
        </SettingsCard>
        <FullWidth key="independence">
          <View style={{ padding: 14, gap: 6, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}>
            <MText size={8.5} weight="bold" tracking={1.5} color={colors.faint}>
              INDEPENDENCE
            </MText>
            <MText size={11.5} color={colors.muted} style={{ lineHeight: 17 }}>
              {`${appBrand.name} is an unofficial, open-source field monitor. It is not affiliated with or endorsed by SZ DJI Technology Co., Ltd. "DJI", "Osmo", "Osmo Pocket", and "Mimo" are trademarks of SZ DJI Technology Co., Ltd., used for identification only. No DJI SDK or proprietary DJI documentation is included in, distributed with, or required by this app.`}
            </MText>
          </View>
        </FullWidth>
      </CardColumns>
      <ConfirmDialog
        visible={confirmSource}
        title="Open Source Code?"
        message={SettingsCopy.browserConfirmation('Source Code')}
        confirmTitle="Open"
        onCancel={() => setConfirmSource(false)}
        onConfirm={() => {
          setConfirmSource(false);
          Linking.openURL(appBrand.sourceUrl).catch(() => {});
        }}
      />
    </>
  );
}
