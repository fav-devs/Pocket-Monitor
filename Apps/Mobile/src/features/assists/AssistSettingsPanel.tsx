import { useState } from 'react';
import { View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { MText, colors, minTouch, radius, spacing } from '@/theme';
import { PressableScale, SectionHeader } from '@/ui';
import { ASSIST_TITLES, hasConfiguration, useAssists, type AssistTool } from '@/state/assists';
import { AssistIcon } from './AssistIcon';
import { AssistMenu } from './AssistMenus';
import { TextButton, Toggle } from './menuKit';

const GROUPS: { title: string; tools: AssistTool[] }[] = [
  { title: 'Picture', tools: ['LUT', 'PEAK', 'FALSE', 'ZEBRA', 'DE-SQ', 'MIRROR'] },
  { title: 'Scopes & meters', tools: ['WAVE', 'PARADE', 'HISTO', 'VECTOR', 'LIGHTS', 'ND', 'EV', 'AUDIO'] },
  { title: 'Framing', tools: ['GUIDES', 'GRID', 'CROSS', 'LEVEL'] },
];

function ToolRow({ tool }: { tool: AssistTool }) {
  const [open, setOpen] = useState(false);
  const on = useAssists((s) => s.on[tool]);
  const playbackOn = useAssists((s) => s.playbackOn[tool]);
  const setOn = useAssists((s) => s.setOn);
  const configurable = hasConfiguration(tool) || tool === 'LEVEL' || tool === 'EV';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: minTouch + 8 }}>
        <PressableScale
          noScale
          onPress={() => configurable && setOpen((o) => !o)}
          accessibilityLabel={`${ASSIST_TITLES[tool]} options`}
          accessibilityState={{ expanded: open }}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: minTouch }}
        >
          <AssistIcon tool={tool} size={20} color={on ? colors.accent : colors.secondary} />
          <View style={{ flex: 1 }}>
            <MText size={14} weight="medium">
              {ASSIST_TITLES[tool]}
            </MText>
            <MText size={10} color={colors.faint} tracking={0.8}>
              {tool}
              {playbackOn ? ' · on in playback' : ''}
            </MText>
          </View>
          {configurable ? <Chevron size={16} color={colors.muted} /> : null}
        </PressableScale>
        <Toggle value={on} onChange={(v) => setOn(tool, v)} label={`${ASSIST_TITLES[tool]} in live view`} />
      </View>
      {open ? (
        <View style={{ paddingBottom: spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: spacing.sm }}>
            <MText size={12} color={colors.secondary}>
              Show in playback
            </MText>
            <Toggle value={playbackOn} onChange={(v) => setOn(tool, v, 'playback')} label={`${ASSIST_TITLES[tool]} in playback`} />
          </View>
          <AssistMenu tool={tool} />
        </View>
      ) : null}
    </View>
  );
}

/** Settings → View Assists: every tool's switch and options, panel layout reset, defaults. */
export default function AssistSettingsPanel() {
  const resetPanels = useAssists((s) => s.resetPanels);
  const reset = useAssists((s) => s.reset);
  return (
    <View style={{ gap: spacing.xl }}>
      {GROUPS.map((g) => (
        <View key={g.title} style={{ gap: spacing.sm }}>
          <SectionHeader title={g.title} />
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, paddingHorizontal: spacing.lg, borderWidth: 1, borderColor: colors.border }}>
            {g.tools.map((t) => (
              <ToolRow key={t} tool={t} />
            ))}
          </View>
        </View>
      ))}
      <View style={{ gap: spacing.sm }}>
        <SectionHeader title="Layout" />
        <TextButton label="Reset scope positions and sizes" onPress={resetPanels} />
        <TextButton label="Reset all view assists" tone="danger" onPress={reset} />
        <MText size={11} color={colors.muted}>
          Scopes and meters measure the camera signal, never the monitoring LUT. Hold a scope on the picture to change its options; drag it to move and pull its corner to resize.
        </MText>
      </View>
    </View>
  );
}
