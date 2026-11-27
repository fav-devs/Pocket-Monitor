import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { ArrowReloadHorizontalIcon, Delete02Icon } from '@hugeicons/core-free-icons';
import { FieldSection } from '@/components/field-section';
import { SettingsDestructiveButton, SettingsGroup, SettingsRow } from '@/components/settings-ui';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { ASSIST_TITLES, useAssists, type AssistTool } from '@/state/assists';
import { ASSIST_GROUPS } from './AssistBar';
import { ASSIST_ICONS } from './AssistIcon';
import { AssistOptionsSheet } from './AssistInspector';
import { AppSwitch, SwitchRow } from './menuKit';

function ToolRow({ tool, last, onOpen }: { tool: AssistTool; last: boolean; onOpen: () => void }) {
  const { colors } = useTheme();
  const on = useAssists((s) => s.on[tool]);
  const playbackOn = useAssists((s) => s.playbackOn[tool]);
  const setOn = useAssists((s) => s.setOn);
  return (
    <SettingsRow
      icon={ASSIST_ICONS[tool]}
      iconBg={on ? colors.ink : undefined}
      iconColor={on ? colors.inkForeground : undefined}
      title={ASSIST_TITLES[tool]}
      subtitle={playbackOn ? 'On in playback' : undefined}
      onPress={onOpen}
      chevron
      last={last}
      accessory={
        <AppSwitch label={`${ASSIST_TITLES[tool]} in live view`} value={on} onChange={(v) => setOn(tool, v)} />
      }
    />
  );
}

/** Live view and playback switches above a tool's options in Settings. */
function ShowIn({ tool }: { tool: AssistTool }) {
  const on = useAssists((s) => s.on[tool]);
  const playbackOn = useAssists((s) => s.playbackOn[tool]);
  const setOn = useAssists((s) => s.setOn);
  return (
    <FieldSection title="Show in">
      <View>
        <SwitchRow title="Live view" value={on} onChange={(v) => setOn(tool, v)} />
        <SwitchRow title="Playback" value={playbackOn} onChange={(v) => setOn(tool, v, 'playback')} />
      </View>
    </FieldSection>
  );
}

/** Settings → View Assists: every tool's switch and options, panel layout reset, defaults. */
export default function AssistSettingsPanel() {
  const styles = useThemedStyles(createStyles);
  const resetPanels = useAssists((s) => s.resetPanels);
  const reset = useAssists((s) => s.reset);
  const [open, setOpen] = useState<AssistTool | null>(null);
  const last = useRef<AssistTool | null>(null);
  if (open) last.current = open;
  const shown = open ?? last.current;
  return (
    <View style={styles.root}>
      {ASSIST_GROUPS.map((g) => (
        <SettingsGroup key={g.title} label={g.title}>
          {g.tools.map((t, i) => (
            <ToolRow key={t} tool={t} last={i === g.tools.length - 1} onOpen={() => setOpen(t)} />
          ))}
        </SettingsGroup>
      ))}
      <SettingsGroup label="Layout">
        <SettingsRow icon={ArrowReloadHorizontalIcon} title="Reset scope positions and sizes" onPress={resetPanels} last />
      </SettingsGroup>
      <View style={styles.footer}>
        <SettingsDestructiveButton title="Reset all view assists" icon={Delete02Icon} onPress={reset} />
        <Text style={styles.note}>Scopes read the camera signal, never the LUT.</Text>
      </View>
      {shown ? <AssistOptionsSheet tool={shown} visible={open != null} onClose={() => setOpen(null)} lead={<ShowIn tool={shown} />} /> : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { gap: spacing.lg },
    footer: { gap: spacing.xs },
    note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, paddingHorizontal: 4 },
  };
}
