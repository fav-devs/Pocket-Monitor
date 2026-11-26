import { Fragment, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowUp01Icon } from '@hugeicons/core-free-icons';
import { Icon } from '@/components/icon';
import { Squircle } from '@/components/squircle';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { ASSIST_TITLES, hasConfiguration, useAssists, type AssistContext, type AssistTool } from '@/state/assists';
import { ASSIST_CAPTIONS, AssistIcon } from './AssistIcon';
import { AssistInspectorHost } from './AssistInspector';

const WELL = 44;
const WELL_RADIUS = 15;
const TOOL_WIDTH = 56;
const ARROW = 28;
const PAD = 6;

/** The strip's sections when it is open (Settings → View Assists uses the same groups). */
export const ASSIST_GROUPS: { title: string; tools: AssistTool[] }[] = [
  { title: 'Picture', tools: ['LUT', 'PEAK', 'FALSE', 'ZEBRA', 'DE-SQ', 'MIRROR'] },
  { title: 'Scopes & meters', tools: ['WAVE', 'PARADE', 'HISTO', 'VECTOR', 'LIGHTS', 'ND', 'EV', 'AUDIO'] },
  { title: 'Framing', tools: ['GUIDES', 'GRID', 'CROSS', 'LEVEL'] },
];

export interface AssistBarProps {
  orientation: 'landscape' | 'portrait';
  /** Which switches the strip toggles. Default live. */
  context?: AssistContext;
  /** Interface lock: chips ignore taps. */
  locked?: boolean;
}

/**
 * One tool (ai-cut's editor `Tool` over video): a 44pt squircle well, translucent white when off and white with a dark
 * glyph when on, an 11pt caption under it and a primary dot between them while the tool is on.
 */
export function AssistChip({ tool, on, onPress, onLongPress }: { tool: AssistTool; on: boolean; onPress: () => void; onLongPress?: () => void; size?: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      accessibilityRole="button"
      accessibilityLabel={ASSIST_TITLES[tool]}
      accessibilityState={{ selected: on }}
      accessibilityHint={hasConfiguration(tool) ? 'Hold for options' : undefined}
      style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
    >
      <Squircle width={WELL} height={WELL} radius={WELL_RADIUS} color={on ? ON_WELL : OFF_WELL}>
        <AssistIcon tool={tool} size={22} color={on ? ON_GLYPH : '#ffffff'} strokeWidth={on ? 2 : 1.7} />
      </Squircle>
      <View style={styles.caption}>
        {on ? <View style={styles.dot} /> : null}
        <Text numberOfLines={1} style={[styles.label, on && styles.labelOn]}>
          {ASSIST_CAPTIONS[tool]}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * View Assist palette (`MonitorAssistPalette`) as an editor-toolbar strip over the picture. Closed it shows the two
 * most recently used tools (one in portrait) beside an arrow; open it is every tool in its sections, a scrolling row
 * in landscape and a column in portrait. Tap toggles, hold opens the tool's options.
 */
export default function AssistBar({ orientation, context = 'live', locked }: AssistBarProps) {
  const [expanded, setExpanded] = useState(false);
  const order = useAssists((s) => s.chipOrder);
  const on = useAssists((s) => (context === 'live' ? s.on : s.playbackOn));
  const toggle = useAssists((s) => s.toggle);
  const moveChip = useAssists((s) => s.moveChip);
  const openInspector = useAssists((s) => s.openInspector);
  const { width: winW, height: winH } = useWindowDimensions();
  const styles = useThemedStyles(createStyles);
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
  const groups = ASSIST_GROUPS.map((g, i) => (
    <Fragment key={g.title}>
      {i > 0 ? <View style={portrait ? styles.dividerH : styles.dividerV} /> : null}
      {g.tools.map(chip)}
    </Fragment>
  ));

  const arrowIcon = portrait ? (expanded ? ArrowDown01Icon : ArrowUp01Icon) : expanded ? ArrowLeft01Icon : ArrowRight01Icon;
  const arrow = (
    <Pressable
      onPress={() => setExpanded((e) => !e)}
      accessibilityRole="button"
      accessibilityLabel={expanded ? 'Collapse view assists' : 'Show all view assists'}
      hitSlop={portrait ? { left: 8, right: 8 } : { top: 8, bottom: 8 }}
      style={({ pressed }) => [portrait ? styles.arrowPortrait : styles.arrowLandscape, pressed && styles.pressed]}
    >
      <Icon icon={arrowIcon} size={18} color="#ffffff" strokeWidth={2} />
    </Pressable>
  );
  const favorites = order.slice(0, portrait ? 1 : 2);

  let body;
  if (portrait) {
    body = (
      <View style={[styles.plate, styles.column]}>
        {arrow}
        {expanded ? (
          <ScrollView style={{ maxHeight: winH * 0.62 - ARROW }} contentContainerStyle={styles.columnContent} showsVerticalScrollIndicator={false}>
            {groups}
          </ScrollView>
        ) : (
          favorites.map(chip)
        )}
      </View>
    );
  } else {
    body = (
      <View style={[styles.plate, styles.row]}>
        {expanded ? (
          <ScrollView horizontal style={{ maxWidth: Math.max(TOOL_WIDTH, winW - 160 - ARROW) }} contentContainerStyle={styles.rowContent} showsHorizontalScrollIndicator={false}>
            {groups}
          </ScrollView>
        ) : (
          <View style={styles.rowContent}>{favorites.map(chip)}</View>
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

const OFF_WELL = 'rgba(255,255,255,0.18)';
const ON_WELL = '#ffffff';
const ON_GLYPH = '#111111';
const shadow = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 };

// On-video chrome: always dark, whatever the system theme.
function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  plate: { backgroundColor: 'rgba(0,0,0,0.32)', borderRadius: 22, borderCurve: 'continuous', padding: PAD },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowContent: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  column: { alignItems: 'center', width: TOOL_WIDTH + PAD * 2 },
  columnContent: { alignItems: 'center', gap: 10, paddingBottom: 2 },
  tool: { alignItems: 'center', gap: 6, width: TOOL_WIDTH, paddingTop: 2 },
  caption: { alignItems: 'center' },
  dot: { position: 'absolute', top: -5, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
  label: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 13, textAlign: 'center', color: 'rgba(255,255,255,0.78)', ...shadow },
  labelOn: { color: '#ffffff' },
  pressed: { opacity: 0.65 },
  arrowLandscape: { width: ARROW, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  arrowPortrait: { height: ARROW, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  dividerV: { width: 1, height: 36, marginHorizontal: 8, backgroundColor: 'rgba(255,255,255,0.18)', alignSelf: 'center', marginBottom: 18 },
  dividerH: { height: 1, width: 36, backgroundColor: 'rgba(255,255,255,0.18)' },
  });
}
