import { ChevronLeft, Ellipsis } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { CameraPageButton } from './CameraPageButton';
import { ProgressLabel } from './StatusBits';

export interface PairStep {
  title: string;
  subtitle: string;
}

export interface PairPageProps {
  heading?: string;
  steps: readonly PairStep[];
  currentStep: number;
  title: string;
  body: string;
  target: string;
  hint: string;
  progress?: string | null;
  error?: string | null;
  primaryAction?: { title: string; enabled: boolean; onPress: () => void } | null;
  backAction?: { title: string; onPress: () => void } | null;
  /** Rail back chevron (always offered so the page never traps the operator). */
  onExit: () => void;
  exitLabel?: string;
  menuItems: ActionMenuItem[];
  onReportProblem: () => void;
  children?: ReactNode;
}

/**
 * Rail-and-pane pairing presentation (`PairCameraPage`). The page owns layout only; the screen
 * supplies what the session reports and the actions that drive it.
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
  primaryAction,
  backAction,
  onExit,
  exitLabel = 'Your cameras',
  menuItems,
  onReportProblem,
  children,
}: PairPageProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const portrait = height > width;
  const tablet = Math.min(width, height) >= 600;
  const step = Math.min(Math.max(0, currentStep), steps.length - 1);

  const stepRow = (s: PairStep, index: number) => {
    const active = index === step;
    const complete = index < step;
    return (
      <View
        key={s.title}
        accessible
        accessibilityLabel={`Step ${index + 1}: ${s.title}, ${complete ? 'complete' : active ? 'current' : 'waiting'}`}
        style={{
          flex: portrait ? 1 : undefined,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: portrait ? 'center' : 'flex-start',
          gap: 9,
          paddingHorizontal: 9,
          minHeight: portrait ? 34 : 42,
          borderRadius: 9,
          backgroundColor: active ? withAlpha(colors.accent, 0.14) : 'transparent',
        }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: complete ? colors.accent : active ? withAlpha(colors.accent, 0.24) : 'rgba(255,255,255,0.06)',
          }}
        >
          <MText size={9.5} weight="bold" color={complete ? colors.background : active ? colors.accent : colors.faint}>
            {complete ? '✓' : String(index + 1)}
          </MText>
        </View>
        {!portrait ? (
          <View style={{ flex: 1, gap: 1 }}>
            <MText size={12} weight="semibold" numberOfLines={1} color={active ? colors.text : complete ? colors.secondary : colors.faint}>
              {s.title}
            </MText>
            <MText size={8.5} tracking={0.6} numberOfLines={1} color={colors.faint}>
              {s.subtitle}
            </MText>
          </View>
        ) : null}
      </View>
    );
  };

  const rail = (
    <View
      style={{
        width: portrait ? undefined : tablet ? 268 : 210,
        alignSelf: portrait ? 'stretch' : 'stretch',
        padding: 11,
        gap: 10,
        borderRadius: 12,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <PressableScale
          accessibilityLabel={exitLabel}
          onPress={onExit}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -6, marginVertical: -6 }}
        >
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: withAlpha(colors.secondary, 0.12),
            }}
          >
            <ChevronLeft size={15} color={colors.text} strokeWidth={2.2} />
          </View>
        </PressableScale>
        <View style={{ flex: 1, gap: 1 }}>
          <MText size={8} weight="bold" tracking={1.4} color={colors.accent}>
            {`STEP ${step + 1} OF ${steps.length}`}
          </MText>
          <MText size={13} weight="semibold" numberOfLines={1}>
            {heading}
          </MText>
        </View>
        <ActionMenu items={menuItems} accessibilityLabel="Pairing help and diagnostics">
          <View style={{ width: 32, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ellipsis size={16} color={colors.secondary} />
          </View>
        </ActionMenu>
      </View>
      {portrait ? (
        <View style={{ flexDirection: 'row', gap: 3 }}>{steps.map(stepRow)}</View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 3 }} showsVerticalScrollIndicator={false}>
          {steps.map(stepRow)}
        </ScrollView>
      )}
      <View
        style={{
          paddingHorizontal: 10,
          paddingVertical: 9,
          gap: 5,
          borderRadius: 10,
          backgroundColor: 'rgba(255,255,255,0.04)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.06)',
        }}
      >
        <MText size={8} weight="bold" tracking={1.3} color={colors.faint}>
          TARGET
        </MText>
        <MText size={10} weight="semibold" color={colors.secondary} numberOfLines={1}>
          {target}
        </MText>
      </View>
      {!portrait || tablet ? (
        <PressableScale
          accessibilityLabel="Report a problem"
          testID="pair.reportProblem"
          onPress={onReportProblem}
          style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <MText size={12} weight="semibold" color={colors.accent}>
            Report a problem
          </MText>
        </PressableScale>
      ) : null}
    </View>
  );

  const footer = (
    <View style={{ gap: 9 }}>
      {portrait ? (
        <MText size={9.5} color={colors.faint} align="center">
          {hint}
        </MText>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        {!portrait ? (
          <MText size={9.5} color={colors.faint} numberOfLines={2} style={{ flex: 1 }}>
            {hint}
          </MText>
        ) : null}
        {portrait && !tablet ? (
          <PressableScale
            accessibilityLabel="Report a problem"
            onPress={onReportProblem}
            style={{ minHeight: 44, justifyContent: 'center', paddingRight: 4, flex: 1 }}
          >
            <MText size={12} weight="semibold" color={colors.accent}>
              Report a problem
            </MText>
          </PressableScale>
        ) : null}
        {backAction ? <CameraPageButton title={backAction.title} onPress={backAction.onPress} /> : null}
        {primaryAction ? (
          <CameraPageButton
            title={primaryAction.title}
            primary
            disabled={!primaryAction.enabled}
            onPress={primaryAction.onPress}
            testID="pair.primary"
          />
        ) : null}
      </View>
    </View>
  );

  const pane = (
    <View
      style={{
        flex: 1,
        paddingHorizontal: tablet ? 20 : 15,
        paddingTop: tablet ? 18 : 14,
        paddingBottom: tablet ? 14 : 12,
        gap: 12,
        borderRadius: 12,
        backgroundColor: '#161718',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.04)',
      }}
    >
      <View style={{ gap: 7 }}>
        <MText size={tablet ? 25 : 19} weight="semibold" tracking={-0.2} accessibilityRole="header">
          {title}
        </MText>
        <MText size={12.5} color={colors.muted} style={{ lineHeight: 18 }}>
          {body}
        </MText>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8, paddingBottom: 4 }} showsVerticalScrollIndicator={false}>
        {error ? (
          <View style={{ padding: 12, borderRadius: 11, backgroundColor: withAlpha(colors.recording, 0.12) }}>
            <MText size={12} color={colors.secondary} style={{ lineHeight: 17 }}>
              {error}
            </MText>
          </View>
        ) : null}
        {children}
        {progress ? (
          <View style={{ paddingTop: 3 }}>
            <ProgressLabel title={progress} />
          </View>
        ) : null}
      </ScrollView>
      {footer}
    </View>
  );

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        paddingTop: insets.top + 12,
        paddingBottom: insets.bottom + 12,
        paddingLeft: insets.left + 14,
        paddingRight: insets.right + 14,
        flexDirection: portrait ? 'column' : 'row',
        alignItems: portrait ? 'stretch' : 'stretch',
        gap: 10,
      }}
    >
      {rail}
      {pane}
    </View>
  );
}
