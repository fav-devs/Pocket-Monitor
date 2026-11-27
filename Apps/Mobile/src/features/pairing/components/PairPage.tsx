import { AlertCircleIcon, ArrowLeft01Icon, Camera01Icon, HelpCircleIcon, MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionSheet } from '@/components/action-sheet';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Squircle } from '@/components/squircle';
import { useEscapeKey } from '@/components/desktop';
import { useScreenSize, useWideLayout } from '@/constants/layout';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { ProgressLabel } from './StatusBits';

export interface PairStep {
  title: string;
}

export interface PairMenuItem {
  id: string;
  title: string;
  icon: IconSvgElement;
  onPress: () => void;
}

export interface PairPageProps {
  heading?: string;
  steps: readonly PairStep[];
  currentStep: number;
  title: string;
  body?: string | null;
  /** The camera this page is about; hidden when nothing is chosen yet. */
  target?: string | null;
  hint?: string | null;
  progress?: string | null;
  error?: string | null;
  /** Empty and failure pages lead with an icon well. */
  hero?: { icon: IconSvgElement; tone?: 'default' | 'destructive' } | null;
  primaryAction?: { title: string; enabled: boolean; onPress: () => void } | null;
  backAction?: { title: string; onPress: () => void } | null;
  /** Top-left back (always offered so the page never traps the operator). */
  onExit: () => void;
  exitLabel?: string;
  menuItems: PairMenuItem[];
  onReportProblem: () => void;
  children?: ReactNode;
}

/** The widest a flow column gets on a tablet. */
const FLOW_MAX_WIDTH = 560;

/**
 * One step of the pair / connect flow (`PairCameraPage`): a big title and at most one line, the step's
 * content, and a large primary button pinned at the bottom with a ghost secondary under it.
 * Phones in landscape put the title and buttons on the left and the content on the right.
 */
export function PairPage({
  heading = 'Pair a camera',
  steps,
  currentStep,
  title,
  body,
  target,
  hint,
  progress,
  error,
  hero,
  primaryAction,
  backAction,
  onExit,
  exitLabel = 'Cameras',
  menuItems,
  onReportProblem,
  children,
}: PairPageProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { large, landscape } = useScreenSize();
  const [menuOpen, setMenuOpen] = useState(false);
  // Wide layout: the flow is a dialog over the page it was opened from; Esc closes it.
  const dialog = useWideLayout();
  useEscapeKey(onExit, dialog);
  const step = Math.min(Math.max(0, currentStep), steps.length - 1);
  // An empty page (nothing to connect) is a centred empty state; a failure keeps its checklist.
  const empty = !!hero && !children;
  const split = landscape && !large && !empty;

  const topBar = (
    <View style={styles.topBar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={exitLabel}
        onPress={onExit}
        hitSlop={8}
        style={({ pressed }) => [styles.iconButton, styles.iconButtonStart, pressed && styles.pressed]}
      >
        <Icon icon={ArrowLeft01Icon} size={24} color={colors.foreground} />
      </Pressable>
      <Text numberOfLines={1} style={styles.heading}>
        {heading}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Pairing help and diagnostics"
        onPress={() => setMenuOpen(true)}
        hitSlop={8}
        style={({ pressed }) => [styles.iconButton, styles.iconButtonEnd, pressed && styles.pressed]}
      >
        <Icon icon={MoreHorizontalIcon} size={22} color={colors.foreground} />
      </Pressable>
    </View>
  );

  const stepper = (
    <View
      accessible
      accessibilityLabel={`Step ${step + 1} of ${steps.length}: ${steps[step]?.title ?? ''}`}
      style={styles.stepper}
    >
      <View style={styles.stepBars}>
        {steps.map((s, i) => (
          <View key={s.title} style={[styles.stepBar, i <= step && styles.stepBarOn]} />
        ))}
      </View>
    </View>
  );

  const intro = (
    <View style={[styles.intro, empty && styles.introEmpty]}>
      {hero ? (
        <Squircle
          width={56}
          height={56}
          radius={18}
          color={hero.tone === 'destructive' ? colors.destructiveSoft : colors.surface}
          style={[styles.hero, empty && styles.heroEmpty]}
        >
          <Icon
            icon={hero.icon}
            size={26}
            color={hero.tone === 'destructive' ? colors.destructive : colors.foreground}
            strokeWidth={1.7}
          />
        </Squircle>
      ) : null}
      <Text accessibilityRole="header" style={[styles.title, split && styles.titleCompact, empty && styles.titleEmpty]}>
        {title}
      </Text>
      {body ? <Text style={[styles.body, empty && styles.bodyEmpty]}>{body}</Text> : null}
      {target ? (
        <View style={styles.target}>
          <Icon icon={Camera01Icon} size={15} color={colors.mutedForeground} />
          <Text numberOfLines={1} style={styles.targetText}>
            {target}
          </Text>
        </View>
      ) : null}
    </View>
  );

  const content = (
    <>
      {error ? (
        <View accessibilityRole="alert" style={styles.error}>
          <Icon icon={AlertCircleIcon} size={20} color={colors.destructive} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      {children}
      {progress ? <ProgressLabel title={progress} /> : null}
    </>
  );

  const dialogFooter = (
    <View style={styles.dialogFooter}>
      {hint ? (
        <Text numberOfLines={2} style={[styles.hint, styles.hintStart, styles.dialogHint]}>
          {hint}
        </Text>
      ) : (
        <View style={styles.flex} />
      )}
      {backAction ? <Button title={backAction.title} variant="ghost" onPress={backAction.onPress} /> : null}
      {primaryAction ? (
        <Button
          testID="pair.primary"
          title={primaryAction.title}
          disabled={!primaryAction.enabled}
          onPress={primaryAction.onPress}
          style={styles.dialogPrimary}
        />
      ) : null}
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      {hint ? (
        <Text numberOfLines={2} style={[styles.hint, split && styles.hintStart]}>
          {hint}
        </Text>
      ) : null}
      {primaryAction ? (
        <Button
          testID="pair.primary"
          title={primaryAction.title}
          size="lg"
          disabled={!primaryAction.enabled}
          onPress={primaryAction.onPress}
        />
      ) : null}
      {backAction ? <Button title={backAction.title} variant="ghost" onPress={backAction.onPress} /> : null}
    </View>
  );

  const menu = (
    <ActionSheet
      visible={menuOpen}
      title={heading}
      onClose={() => setMenuOpen(false)}
      actions={[
        ...menuItems.map((item) => ({ label: item.title, icon: item.icon, onPress: item.onPress })),
        { label: 'Report a problem', icon: HelpCircleIcon, onPress: onReportProblem },
      ]}
    />
  );

  const pad = {
    paddingTop: insets.top + spacing.xs,
    paddingBottom: Math.max(insets.bottom, spacing.md),
    paddingLeft: Math.max(insets.left, spacing.md),
    paddingRight: Math.max(insets.right, spacing.md),
  };

  if (dialog) {
    return (
      <View style={styles.backdrop}>
        <View accessibilityRole="none" style={styles.dialog}>
          <View style={styles.dialogTop}>{topBar}</View>
          <ScrollView
            style={styles.dialogScroll}
            contentContainerStyle={[styles.content, styles.dialogContent, empty && styles.dialogEmpty]}
            keyboardShouldPersistTaps="handled"
          >
            {hero ? null : stepper}
            {intro}
            {content}
          </ScrollView>
          {primaryAction || backAction || hint ? dialogFooter : null}
        </View>
        {menu}
      </View>
    );
  }

  if (split) {
    return (
      <View style={[styles.root, styles.splitRoot, pad]}>
        <View style={styles.splitLead}>
          {topBar}
          <ScrollView style={styles.flex} contentContainerStyle={styles.splitIntro} showsVerticalScrollIndicator={false}>
            {hero ? null : stepper}
            {intro}
          </ScrollView>
          {footer}
        </View>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.content, styles.splitContent]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {content}
        </ScrollView>
        {menu}
      </View>
    );
  }

  return (
    <View style={[styles.root, pad]}>
      <View style={[styles.column, (large || (empty && landscape)) && styles.columnLarge]}>
        {topBar}
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.content, empty && styles.contentEmpty]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {hero ? null : stepper}
          {intro}
          {content}
        </ScrollView>
        {footer}
      </View>
      {menu}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: colors.background },
    backdrop: {
      flex: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      padding: spacing.xl,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    dialog: {
      width: '100%' as const,
      maxWidth: FLOW_MAX_WIDTH,
      maxHeight: '100%' as const,
      minHeight: 420,
      borderRadius: radius.xl,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      overflow: 'hidden' as const,
      shadowColor: '#000',
      shadowOpacity: 0.28,
      shadowRadius: 40,
      shadowOffset: { width: 0, height: 18 },
      elevation: 12,
    },
    dialogTop: { paddingHorizontal: 18, paddingTop: 6 },
    dialogScroll: { flexGrow: 0, flexShrink: 1 },
    dialogContent: { paddingHorizontal: 28, paddingBottom: spacing.lg },
    dialogEmpty: { minHeight: 300, justifyContent: 'center' as const },
    dialogFooter: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: spacing.sm,
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      marginTop: 'auto' as const,
    },
    dialogHint: { flex: 1, paddingBottom: 0 },
    dialogPrimary: { minWidth: 120 },
    flex: { flex: 1 },
    column: { flex: 1, width: '100%' as const, alignSelf: 'center' as const },
    columnLarge: { maxWidth: FLOW_MAX_WIDTH },
    splitRoot: { flexDirection: 'row' as const, gap: spacing.xl },
    splitLead: { width: '42%' as const, maxWidth: 380 },
    splitIntro: { gap: spacing.lg, paddingBottom: spacing.md },
    splitContent: { paddingTop: spacing.sm },
    topBar: { flexDirection: 'row' as const, alignItems: 'center' as const, minHeight: 48, gap: spacing.sm },
    iconButton: { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    iconButtonStart: { marginLeft: -10 },
    iconButtonEnd: { marginRight: -10 },
    heading: {
      flex: 1,
      textAlign: 'center' as const,
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: colors.foreground,
    },
    content: { gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg },
    stepper: { paddingTop: spacing.sm, paddingBottom: spacing.sm },
    stepBars: { flexDirection: 'row' as const, gap: 6 },
    stepBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.surfaceStrong },
    stepBarOn: { backgroundColor: colors.ink },
    intro: { gap: spacing.sm, paddingBottom: spacing.sm },
    hero: { marginBottom: spacing.sm },
    heroEmpty: { marginBottom: spacing.xs },
    introEmpty: { alignItems: 'center' as const },
    contentEmpty: { flexGrow: 1, justifyContent: 'center' as const, paddingBottom: spacing.xl * 2 },
    titleEmpty: { fontFamily: fonts.semibold, fontSize: 20, lineHeight: 26, letterSpacing: 0, textAlign: 'center' as const },
    bodyEmpty: { fontSize: 14, lineHeight: 20, textAlign: 'center' as const, maxWidth: 320 },
    title: { fontFamily: fonts.bold, fontSize: 30, lineHeight: 36, letterSpacing: -0.8, color: colors.foreground },
    titleCompact: { fontSize: 26, lineHeight: 31, letterSpacing: -0.6 },
    body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.mutedForeground },
    target: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      alignSelf: 'flex-start' as const,
      gap: 6,
      maxWidth: '100%' as const,
      marginTop: spacing.xs,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
    },
    targetText: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.foreground },
    error: {
      flexDirection: 'row' as const,
      gap: 12,
      padding: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: colors.destructiveSoft,
    },
    errorText: { flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.foreground },
    footer: { gap: spacing.xs, paddingTop: spacing.sm },
    hint: {
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 16,
      color: colors.mutedForeground,
      textAlign: 'center' as const,
      paddingBottom: spacing.xs,
    },
    hintStart: { textAlign: 'left' as const },
    pressed: { opacity: 0.6 },
  };
}
