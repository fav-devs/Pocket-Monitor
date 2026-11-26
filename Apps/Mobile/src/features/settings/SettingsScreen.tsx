import { useRouter } from 'expo-router';
import { ChevronLeft, Link2Off } from 'lucide-react-native';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ScrollView, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCamera, useCameraSession } from '@/camera';
import AssistSettingsPanel from '@/features/assists/AssistSettingsPanel';
import MediaSettingsPanel from '@/features/media/MediaSettingsPanel';
import { CameraPageButton } from '@/features/pairing/components/CameraPageButton';
import { connectionPhaseLabel } from '@/features/pairing/presentation';
import { appBrand } from '@/features/startup/brand';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { settingsFeedback } from './components/SettingsControls';
import type { LegalPage } from './legal';
import { LegalDocumentSheet } from './LegalDocumentSheet';
import { ProblemReportSheet } from './ProblemReportSheet';
import { AboutSection } from './sections/AboutSection';
import { ConnectionSection } from './sections/ConnectionSection';
import { ExposureSection } from './sections/ExposureSection';
import { InputSection, MotionSection } from './sections/MotionSections';
import { DisplaySection, OperatorSection } from './sections/OperatorSections';
import { SharingSection } from './sections/SharingSection';
import { StorageSection } from './sections/StorageSection';
import { SupportSection } from './sections/SupportSection';
import { sectionInfo, settingsSections, type SettingsSectionId } from './sections';

/** Keeps each section's scroll offset while Settings is open (`settingsScrollOffsets`). */
const scrollOffsets: Partial<Record<SettingsSectionId, number>> = {};

function NavigationItem({
  title,
  subtitle,
  selected,
  vertical,
  onPress,
  onLayout,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  vertical: boolean;
  onPress: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  return (
    <PressableScale
      onLayout={onLayout}
      noScale
      hitSlop={0}
      testID={`monitor.settings.tab.${title}`}
      accessibilityRole="tab"
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 12,
        justifyContent: 'center',
        gap: 2,
        alignSelf: vertical ? 'stretch' : 'auto',
        borderLeftWidth: vertical ? 2 : 0,
        borderBottomWidth: vertical ? 0 : 2,
        borderColor: selected ? colors.accent : 'transparent',
        backgroundColor: selected && vertical ? withAlpha(colors.accent, 0.06) : 'transparent',
      }}
    >
      <MText size={12.5} weight="semibold" color={selected ? colors.accent : colors.muted} numberOfLines={1}>
        {title}
      </MText>
      <MText size={10} color={colors.faint} numberOfLines={1}>
        {subtitle}
      </MText>
    </PressableScale>
  );
}

/**
 * Operator Setup (`MonitorSettingsPage` over `MonitorPage`): a navigation card with the section
 * tabs and the session controls, and the selected section's cards beside or below it.
 */
export default function SettingsScreen({ initialSection }: { initialSection?: string }) {
  const router = useRouter();
  const session = useCameraSession();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const portrait = height > width;
  const tablet = Math.min(width, height) >= 600;
  const live = useCamera((s) => s.connection.phase === 'live');
  const phase = useCamera((s) => s.connection.phase);
  const cameraName = useCamera((s) => s.identity?.name);
  const [selection, setSelection] = useState<SettingsSectionId>(() => sectionInfo(initialSection)?.id ?? 'connection');
  const [contentWidth, setContentWidth] = useState(0);
  const [legal, setLegal] = useState<LegalPage | null>(null);
  const [reporting, setReporting] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const tabScroll = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    const next = sectionInfo(initialSection)?.id;
    if (next) setSelection(next);
  }, [initialSection]);

  const tabOffsets = useRef<Partial<Record<SettingsSectionId, number>>>({});
  const revealTab = (id: SettingsSectionId) => {
    const at = tabOffsets.current[id];
    if (at === undefined) return;
    const to = Math.max(0, at - 24);
    tabScroll.current?.scrollTo(portrait ? { x: to, animated: true } : { y: to, animated: true });
  };
  useEffect(() => {
    revealTab(selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, portrait]);

  useEffect(() => {
    const y = scrollOffsets[selection] ?? 0;
    requestAnimationFrame(() => scroll.current?.scrollTo({ y, animated: false }));
  }, [selection]);

  const info = sectionInfo(selection) ?? settingsSections[0];
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace(live ? '/live' : '/');
  };
  const disconnect = () => {
    session.disconnect().catch(() => {});
    router.replace('/');
  };
  const select = (id: SettingsSectionId) => {
    if (id !== selection) settingsFeedback();
    setSelection(id);
  };

  const backButton = (
    <PressableScale
      testID="monitor.page.back"
      accessibilityLabel={live ? 'Back to live' : 'Your cameras'}
      onPress={back}
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.raised,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
    </PressableScale>
  );

  const heading = (
    <View style={{ flex: 1, minHeight: 34, justifyContent: 'center', gap: 2 }}>
      <MText size={8.5} weight="bold" tracking={1.7} color={colors.accent} uppercase numberOfLines={1}>
        {appBrand.name}
      </MText>
      <MText size={tablet ? 24 : 19} weight="semibold" tracking={-0.2} numberOfLines={1} accessibilityRole="header">
        Operator Setup
      </MText>
    </View>
  );

  const sessionControls = (
    <View style={{ flexDirection: portrait ? 'row' : 'column', gap: 8, alignItems: portrait ? 'center' : 'stretch' }}>
      <View
        style={{
          flex: portrait ? 1 : undefined,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          padding: 9,
          borderRadius: 10,
          backgroundColor: 'rgba(255,255,255,0.04)',
        }}
      >
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: live ? colors.linkStable : colors.faint }} />
        <View style={{ flex: 1, gap: 2 }}>
          <MText size={11.5} weight="semibold" numberOfLines={1}>
            {live ? 'Active link' : 'No camera connected'}
          </MText>
          <MText size={9} color={colors.muted} numberOfLines={1}>
            {live && cameraName ? `${cameraName} · ${connectionPhaseLabel(phase)}` : connectionPhaseLabel(phase)}
          </MText>
        </View>
      </View>
      {live ? (
        <CameraPageButton
          title="Disconnect"
          icon={Link2Off}
          destructive
          onPress={disconnect}
          testID="monitor.system.disconnect"
          block={!portrait}
        />
      ) : null}
    </View>
  );

  const tabs = settingsSections.map((s) => (
    <NavigationItem
      key={s.id}
      title={s.title}
      subtitle={s.rail}
      selected={s.id === selection}
      vertical={!portrait}
      onPress={() => select(s.id)}
      onLayout={(e) => {
        const { x, y } = e.nativeEvent.layout;
        tabOffsets.current[s.id] = portrait ? x : y;
        if (s.id === selection) revealTab(s.id);
      }}
    />
  ));

  const navigation = (
    <View
      style={{
        width: portrait ? undefined : 188,
        padding: 10,
        gap: 9,
        borderRadius: 12,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        alignSelf: 'stretch',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        {portrait ? backButton : null}
        {heading}
      </View>
      {portrait ? (
        <ScrollView
          ref={tabScroll}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ height: 50, flexGrow: 0 }}
          contentContainerStyle={{ borderBottomWidth: 1, borderBottomColor: colors.border, alignItems: 'stretch' }}
          accessibilityRole="tablist"
        >
          {tabs}
        </ScrollView>
      ) : (
        <ScrollView
          ref={tabScroll}
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ borderLeftWidth: 1, borderLeftColor: colors.border }}
          accessibilityRole="tablist"
        >
          {tabs}
        </ScrollView>
      )}
      {sessionControls}
    </View>
  );

  let body: React.ReactNode;
  const w = Math.max(0, contentWidth);
  switch (selection) {
    case 'connection':
      body = <ConnectionSection width={w} />;
      break;
    case 'display':
      body = <DisplaySection width={w} />;
      break;
    case 'operator':
      body = <OperatorSection width={w} />;
      break;
    case 'input':
      body = <InputSection width={w} />;
      break;
    case 'motion':
      body = <MotionSection width={w} />;
      break;
    case 'exposure':
      body = <ExposureSection width={w} />;
      break;
    case 'assists':
      body = <AssistSettingsPanel />;
      break;
    case 'media':
      body = <MediaSettingsPanel />;
      break;
    case 'sharing':
      body = <SharingSection width={w} />;
      break;
    case 'storage':
      body = <StorageSection width={w} />;
      break;
    case 'support':
      body = <SupportSection width={w} onReport={() => setReporting(true)} onPrivacy={() => setLegal('privacy')} />;
      break;
    case 'about':
      body = <AboutSection width={w} onLegal={setLegal} />;
      break;
  }

  const detail = (
    <View style={{ flex: 1, gap: 10, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1, gap: 5 }}>
          <MText size={17} weight="semibold" accessibilityRole="header">
            {info.title}
          </MText>
          <MText size={10.5} color={colors.muted} numberOfLines={2}>
            {info.subtitle}
          </MText>
        </View>
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: withAlpha(colors.accent, 0.16),
          }}
        >
          <MText size={10} weight="bold" tracking={0.6} color={colors.accent} uppercase>
            {info.pill}
          </MText>
        </View>
      </View>
      <ScrollView
        ref={scroll}
        key={selection}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 16 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={64}
        onScroll={(e) => {
          scrollOffsets[selection] = e.nativeEvent.contentOffset.y;
        }}
        onLayout={(e) => setContentWidth(Math.round(e.nativeEvent.layout.width))}
      >
        {contentWidth > 0 ? body : null}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={{
          flex: 1,
          flexDirection: portrait ? 'column' : 'row',
          gap: 10,
          paddingTop: insets.top + 10,
          paddingBottom: insets.bottom + 10,
          paddingLeft: (portrait ? insets.left : Math.max(14, insets.left)) + 12,
          paddingRight: (portrait ? insets.right : Math.max(14, insets.right)) + 12,
        }}
      >
        {!portrait ? backButton : null}
        {navigation}
        {detail}
      </View>
      <LegalDocumentSheet page={legal} onClose={() => setLegal(null)} />
      <ProblemReportSheet visible={reporting} onClose={() => setReporting(false)} />
    </View>
  );
}
