import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { MText, colors } from '@/theme';
import { PressableScale } from '@/ui';
import { CardColumns } from '../components/CardColumns';
import { ActionRow, CardCaption, SettingsCard, ValueRow } from '../components/SettingsControls';
import { SettingsCopy } from '../copy';
import { clearConnectionEvents } from '../diagnostics';
import { useShareDiagnostics } from '../useShareDiagnostics';

/** Support: report a problem, share diagnostics, local report options (`MonitorSupportSettings`). */
export function SupportSection({
  width,
  onReport,
  onPrivacy,
}: {
  width: number;
  onReport: () => void;
  onPrivacy: () => void;
}) {
  const diagnostics = useShareDiagnostics();
  const [expanded, setExpanded] = useState(false);
  const [cleared, setCleared] = useState(false);
  return (
    <CardColumns width={width}>
      <SettingsCard key="help" title="Help & Feedback">
        <ActionRow divider={false} title="Report a problem" help={SettingsCopy.report} action="Open" onPress={onReport} testID="support.report.open" />
        <ActionRow title="Diagnostics" help={SettingsCopy.shareDiagnostics} action="Share" onPress={() => void diagnostics.share()} testID="support.diagnostics" />
        <ValueRow title="Automatic error reports" help={SettingsCopy.automaticReportsUnavailable} value="Off" />
        <ActionRow title="Reporting Privacy" help="What reports contain and where they go." action="Read" onPress={onPrivacy} />
        {diagnostics.note ? <CardCaption>{diagnostics.note}</CardCaption> : null}
      </SettingsCard>
      <SettingsCard key="options">
        <PressableScale
          noScale
          accessibilityLabel="Diagnostic options"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((e) => !e)}
          style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 10 }}
        >
          <View style={{ flex: 1, gap: 4 }}>
            <MText size={13} weight="semibold">
              Diagnostic options
            </MText>
            <MText size={11.5} color={colors.muted}>
              Save or remove reports on this phone
            </MText>
          </View>
          {expanded ? <ChevronUp size={20} color={colors.muted} /> : <ChevronDown size={20} color={colors.muted} />}
        </PressableScale>
        {expanded ? (
          <>
            <ActionRow title="Save diagnostic report" help="Keep a copy or share it with support." action="Save" onPress={() => void diagnostics.share()} />
            <ActionRow
              title="Delete connection events"
              help={SettingsCopy.deleteReports}
              action={cleared ? 'Deleted' : 'Delete'}
              disabled={cleared}
              onPress={() => {
                clearConnectionEvents();
                setCleared(true);
              }}
            />
          </>
        ) : null}
      </SettingsCard>
    </CardColumns>
  );
}
