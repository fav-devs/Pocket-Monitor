import { useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react-native';
import { MText, colors, radius, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { ASSIST_TITLES, hasConfiguration, useAssists, type AssistContext, type AssistTool } from '@/state/assists';
import { AssistIcon } from './AssistIcon';
import { AssistInspectorHost } from './AssistInspector';

const CELL = 52;
const GAP = 6;
const PAD = 4;
const ARROW = 27;

export interface AssistBarProps {
  orientation: 'landscape' | 'portrait';
  /** Which switches the strip toggles. Default live. */
  context?: AssistContext;
  /** Interface lock: chips ignore taps. */
  locked?: boolean;
}

/** One tool cell (`MonitorAssistChip`): glyph over its chip label, accent when on. */
export function AssistChip({ tool, on, onPress, onLongPress, size = CELL }: { tool: AssistTool; on: boolean; onPress: () => void; onLongPress?: () => void; size?: number }) {
  const fg = on ? colors.accent : colors.muted;
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      accessibilityLabel={ASSIST_TITLES[tool]}
      accessibilityState={{ selected: on }}
      accessibilityHint={hasConfiguration(tool) ? 'Hold for options' : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        backgroundColor: on ? withAlpha(colors.accent, 0.16) : 'transparent',
        borderWidth: 1,
        borderColor: on ? colors.accent : 'transparent',
      }}
    >
      <AssistIcon tool={tool} size={21} color={fg} />
      <MText size={8} weight="medium" tracking={0.9} color={fg} numberOfLines={1}>
        {tool}
      </MText>
    </PressableScale>
  );
}

/**
 * View Assist palette (`MonitorAssistPalette`): collapsed shows the two most recently used tools
 * (one in portrait) beside an arrow; expanded is the whole catalog, two rows in landscape and a
 * column in portrait. Tap toggles, hold opens the tool's options.
 */
export default function AssistBar({ orientation, context = 'live', locked }: AssistBarProps) {
  const [expanded, setExpanded] = useState(false);
  const order = useAssists((s) => s.chipOrder);
  const on = useAssists((s) => (context === 'live' ? s.on : s.playbackOn));
  const toggle = useAssists((s) => s.toggle);
  const moveChip = useAssists((s) => s.moveChip);
  const openInspector = useAssists((s) => s.openInspector);
  const { width: winW, height: winH } = useWindowDimensions();
  const portrait = orientation === 'portrait';

  const press = (t: AssistTool) => {
    if (locked) return;
    if (expanded && !on[t]) moveChip(t, 0);
    toggle(t, context);
  };
  const hold = (t: AssistTool) => {
    if (locked || !hasConfiguration(t)) return;
    openInspector(t, context);
  };
  const chip = (t: AssistTool) => <AssistChip key={t} tool={t} on={on[t]} onPress={() => press(t)} onLongPress={() => hold(t)} />;

  const Arrow = portrait ? (expanded ? ChevronDown : ChevronUp) : expanded ? ChevronLeft : ChevronRight;
  const arrow = (
    <PressableScale
      onPress={() => setExpanded((e) => !e)}
      accessibilityLabel={expanded ? 'Collapse view assists' : 'Show all view assists'}
      style={portrait ? { height: 31, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' } : { width: ARROW, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}
    >
      <Arrow size={16} color={colors.muted} strokeWidth={2} />
    </PressableScale>
  );

  const favorites = order.slice(0, portrait ? 1 : 2);
  const columns = Math.ceil(order.length / 2);
  const plate = {
    backgroundColor: colors.glassStrong,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: PAD,
  };

  let body;
  if (portrait) {
    const maxH = winH * 0.62;
    body = (
      <View style={[plate, { width: CELL + 8, alignItems: 'center' }]}>
        {arrow}
        {expanded ? (
          <ScrollView style={{ maxHeight: maxH - 35 }} contentContainerStyle={{ gap: GAP }} showsVerticalScrollIndicator={false}>
            {order.map(chip)}
          </ScrollView>
        ) : (
          favorites.map(chip)
        )}
      </View>
    );
  } else {
    const maxW = winW - 160;
    body = (
      <View style={[plate, { flexDirection: 'row', gap: GAP, alignItems: 'center' }]}>
        {expanded ? (
          <ScrollView horizontal style={{ maxWidth: Math.max(CELL, maxW - ARROW) }} showsHorizontalScrollIndicator={false}>
            <View style={{ gap: GAP }}>
              {[0, 1].map((row) => (
                <View key={row} style={{ flexDirection: 'row', gap: GAP }}>
                  {order.slice(row * columns, (row + 1) * columns).map(chip)}
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <View style={{ gap: GAP }}>{favorites.map(chip)}</View>
        )}
        {arrow}
      </View>
    );
  }
  return (
    <View pointerEvents="box-none" accessibilityLabel="View assists">
      {body}
      <AssistInspectorHost />
    </View>
  );
}
