import { ArrowDown01Icon, ArrowUp01Icon, Share08Icon } from '@hugeicons/core-free-icons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useCameraSession } from '@/camera';
import { Button } from '@/components/button';
import { FieldSection } from '@/components/field-section';
import { Icon } from '@/components/icon';
import { Sheet } from '@/components/sheet';
import { TextField } from '@/components/text-field';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { appBrand } from '@/features/startup/brand';
import { usePreferences } from '@/state/preferences';
import { useSavedCameras } from '@/state/savedCameras';
import { settingsFeedback } from './components/feedback';
import { buildDiagnosticsReport, diagnosticsFileName } from './diagnostics';
import { shareOutcomeMessage, shareTextReport } from './shareText';

/**
 * Report a problem (`ProblemReportSheet`): a description, an optional reply email and optional
 * technical details, composed on this phone and handed to the share sheet. No network upload.
 */
export function ProblemReportSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
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
    <View style={styles.footer}>
      {note ? <Text style={styles.footerNote}>{note}</Text> : null}
      <Button
        testID="report.share"
        size="lg"
        title="Share report"
        icon={Share08Icon}
        loading={busy}
        disabled={!valid}
        onPress={send}
      />
    </View>
  );

  return (
    <Sheet visible={visible} title="Report a problem" onClose={onClose} tall footer={footer}>
      <View style={styles.body}>
        <View style={styles.field}>
          <Text style={styles.label}>What happened?</Text>
          <TextField
            testID="report.message"
            value={message}
            onChangeText={setMessage}
            multiline
            placeholder="What were you doing, and what went wrong?"
            accessibilityLabel="What happened?"
            style={styles.message}
          />
          <Text style={styles.hint}>Don’t include passwords.</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Reply email (optional)</Text>
          <TextField
            value={email}
            onChangeText={setEmail}
            placeholder="Email address"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Reply email (optional)"
          />
        </View>
        <FieldSection
          title="Include technical details"
          toggle={{
            value: includeDetails,
            onChange: (v) => {
              settingsFeedback();
              setIncludeDetails(v);
            },
          }}
        >
          <Text style={styles.hint}>
            App and device versions, connection events and errors. No footage, screenshots, GPS location, Wi-Fi names or passwords.
          </Text>
          {includeDetails ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Review technical details"
              accessibilityState={{ expanded: review }}
              onPress={() => setReview((r) => !r)}
              style={({ pressed }) => [styles.review, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.reviewLabel}>Review technical details</Text>
              <Icon icon={review ? ArrowUp01Icon : ArrowDown01Icon} size={18} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
          {includeDetails && review ? (
            <View style={styles.details}>
              <Text selectable style={styles.detailsText}>
                {details}
              </Text>
            </View>
          ) : null}
        </FieldSection>
        <Text style={styles.hint}>
          {`Nothing is uploaded. Attach the report to an issue at ${appBrand.supportUrl}.`}
        </Text>
      </View>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    body: { gap: spacing.md, paddingBottom: spacing.md },
    field: { gap: spacing.sm },
    label: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' as const, color: colors.mutedForeground },
    message: { minHeight: 120, paddingTop: 14, paddingBottom: 14, textAlignVertical: 'top' as const },
    hint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground },
    review: { flexDirection: 'row' as const, alignItems: 'center' as const, minHeight: 44, gap: spacing.sm },
    reviewLabel: { flex: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.primary },
    details: { padding: 12, borderRadius: radius.sm, backgroundColor: colors.surface },
    detailsText: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.foreground },
    footer: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
    footerNote: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground, textAlign: 'center' as const },
  };
}
