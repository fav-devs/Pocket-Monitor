import { ChevronDown, ChevronUp, Share2 } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useCameraSession } from '@/camera';
import { CameraPageButton } from '@/features/pairing/components/CameraPageButton';
import { appBrand } from '@/features/startup/brand';
import { usePreferences } from '@/state/preferences';
import { useSavedCameras } from '@/state/savedCameras';
import { MText, colors, fonts } from '@/theme';
import { PressableScale } from '@/ui';
import { SettingsSwitch } from './components/SettingsControls';
import { buildDiagnosticsReport, diagnosticsFileName } from './diagnostics';
import { OverlayScreen } from './OverlayScreen';
import { shareOutcomeMessage, shareTextReport } from './shareText';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <MText size={8.5} weight="bold" tracking={1.5} color={colors.faint} uppercase>
        {title}
      </MText>
      <View style={{ padding: 13, gap: 8, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
        {children}
      </View>
    </View>
  );
}

const inputStyle = {
  color: colors.text,
  fontFamily: fonts.regular,
  fontSize: 14,
  borderRadius: 10,
  backgroundColor: colors.background,
  borderWidth: 1,
  borderColor: colors.border,
  paddingHorizontal: 12,
  paddingVertical: 10,
} as const;

/**
 * Report a problem (`ProblemReportSheet`): a description, an optional reply email and optional
 * technical details, composed on this phone and handed to the share sheet. No network upload.
 */
export function ProblemReportSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const session = useCameraSession();
  const saved = useSavedCameras((s) => s.cameras);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [includeDetails, setIncludeDetails] = useState(true);
  const [review, setReview] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setNote(null);
    setReview(false);
  }, [visible]);

  const details = useMemo(
    () => (visible ? buildDiagnosticsReport({ session, saved, preferences: usePreferences.getState() }) : ''),
    // Rebuilt each time the sheet opens or details are reviewed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, review, session, saved],
  );

  const send = async () => {
    setBusy(true);
    const parts = [
      `${appBrand.name} problem report`,
      '',
      'What happened?',
      message.trim(),
      '',
      email.trim() ? `Reply email: ${email.trim()}` : 'Reply email: (none)',
    ];
    if (includeDetails) parts.push('', '--- Technical details ---', details);
    const outcome = await shareTextReport(diagnosticsFileName('report'), 'Report a problem', parts.join('\n'));
    setBusy(false);
    if (outcome === 'shared') {
      setMessage('');
      setEmail('');
      onClose();
      return;
    }
    setNote(shareOutcomeMessage(outcome));
  };

  const valid = message.trim().length >= 4;
  const footer = (
    <View style={{ gap: 8 }}>
      {note ? (
        <MText size={11.5} color={colors.secondary} align="center">
          {note}
        </MText>
      ) : null}
      <CameraPageButton
        title={busy ? 'Preparing…' : 'Share report'}
        icon={Share2}
        primary
        block
        disabled={!valid || busy}
        onPress={send}
        testID="report.share"
      />
    </View>
  );

  return (
    <OverlayScreen visible={visible} eyebrow={appBrand.name} title="Report a problem" onClose={onClose} footer={footer}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 16, paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
        <Section title="What happened?">
          <TextInput
            testID="report.message"
            value={message}
            onChangeText={setMessage}
            multiline
            placeholder="What were you doing, and what went wrong?"
            placeholderTextColor={colors.faint}
            accessibilityLabel="What happened?"
            style={[inputStyle, { minHeight: 120, textAlignVertical: 'top' }]}
          />
          <MText size={10.5} color={colors.muted}>
            Describe what you were doing and what went wrong. Please don’t include passwords or other sensitive information.
          </MText>
        </Section>
        <Section title="Reply email (optional)">
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email address"
            placeholderTextColor={colors.faint}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Reply email (optional)"
            style={[inputStyle, { minHeight: 44 }]}
          />
          <MText size={10.5} color={colors.muted}>
            Include an address if you'd like a reply.
          </MText>
        </Section>
        <Section title="Technical details">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <MText size={12.5} weight="semibold" style={{ flex: 1 }}>
              Include technical details
            </MText>
            <SettingsSwitch value={includeDetails} onChange={setIncludeDetails} label="Include technical details" />
          </View>
          <MText size={10.5} color={colors.muted}>
            App and device versions, connection events and errors. No footage, screenshots, GPS location, Wi-Fi names or passwords.
          </MText>
          {includeDetails ? (
            <PressableScale
              noScale
              accessibilityLabel="Review technical details"
              accessibilityState={{ expanded: review }}
              onPress={() => setReview((r) => !r)}
              style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 8 }}
            >
              <MText size={12.5} weight="semibold" color={colors.accent} style={{ flex: 1 }}>
                Review technical details
              </MText>
              {review ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
            </PressableScale>
          ) : null}
          {includeDetails && review ? (
            <View style={{ padding: 10, borderRadius: 10, backgroundColor: colors.canvas }}>
              <MText size={10.5} color={colors.secondary} selectable style={{ fontFamily: fonts.regular, lineHeight: 15 }}>
                {details}
              </MText>
            </View>
          ) : null}
        </Section>
        <MText size={10.5} color={colors.muted} style={{ lineHeight: 15 }}>
          {`This build does not upload reports. Share report opens the share sheet so you can attach it to an issue at ${appBrand.supportUrl}.`}
        </MText>
      </ScrollView>
    </OverlayScreen>
  );
}
