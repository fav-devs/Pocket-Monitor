import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useCamera, useCameraSession } from '@/camera';
import type { ColorMode } from '@/camera/types';
import { fonts, useTheme } from '@/constants/theme';
import LivePicture from '@/features/picture/LivePicture';
import { ASSIST_TOOLS, useAssists, type AssistTool } from '@/state/assists';
import type { DemoScene } from '@modules/pocket-native/src/types';
import AssistBar from '../AssistBar';
import AssistOverlays from '../AssistOverlays';

const SCENES: DemoScene[] = ['studio', 'bars', 'skin', 'night'];
const COLORS: ColorMode[] = ['normal', 'hlg', 'dlog-m', 'dlog', 'dlog2'];

/** An option over video (ai-cut camera speed/lens style): chosen white with dark text. */
function Pill({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      hitSlop={{ top: 8, bottom: 8 }}
      style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.optionText, on && styles.optionTextOn]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Dev-only preview: the demo picture with every assist, without the live screen.
 * Query: `?scene=studio&color=dlog2&tools=WAVE,HISTO&fit=fill&inspect=FALSE`.
 */
export default function AssistsPreviewScreen() {
  const params = useLocalSearchParams<{ scene?: string; color?: string; tools?: string; fit?: string; inspect?: string; dev?: string }>();
  const session = useCameraSession();
  const colorMode = useCamera((s) => s.format.colorMode);
  const phase = useCamera((s) => s.connection.phase);
  const [scene, setScene] = useState<DemoScene>((SCENES as string[]).includes(params.scene ?? '') ? (params.scene as DemoScene) : 'studio');
  const [fit, setFit] = useState<'fit' | 'fill'>(params.fit === 'fill' ? 'fill' : 'fit');
  const [rect, setRect] = useState<LayoutRectangle>({ x: 0, y: 0, width: 0, height: 0 });
  const [bar, setBar] = useState<LayoutRectangle | null>(null);
  const { width, height } = useWindowDimensions();
  const portrait = height > width;
  const { colors } = useTheme();

  useEffect(() => {
    if (phase === 'idle' || phase === 'disconnected') {
      void session.connect({ id: 'demo-pocket-4-pro', name: 'Pocket 4 Pro', model: 'osmo-pocket-4-pro', rssi: -50, pairable: true, saved: false });
    }
  }, [session, phase]);

  useEffect(() => {
    const store = useAssists.getState();
    if (params.tools) {
      const wanted = params.tools.split(',').map((t) => t.trim().toUpperCase()) as AssistTool[];
      for (const t of ASSIST_TOOLS) store.setOn(t, wanted.includes(t) || (t === 'LUT' && !params.tools.includes('-LUT')));
    }
    if (params.inspect && (ASSIST_TOOLS as string[]).includes(params.inspect.toUpperCase())) store.openInspector(params.inspect.toUpperCase() as AssistTool);
    if (params.color && (COLORS as string[]).includes(params.color)) void session.control.setFormat({ colorMode: params.color as ColorMode });
  }, [params.tools, params.inspect, params.color, session]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.preview }}>
      <LivePicture source={{ kind: 'demo', scene }} resizeMode={fit} onPictureRect={setRect} />
      <AssistOverlays pictureRect={rect} context="live" obstacles={bar ? [bar] : []} />
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 12, bottom: 12 }} onLayout={(e) => setBar(e.nativeEvent.layout)}>
        <AssistBar orientation={portrait ? 'portrait' : 'landscape'} />
      </View>
      {params.dev !== '0' ? (
        <View pointerEvents="box-none" style={styles.devRow}>
          <View style={styles.track}>
            {SCENES.map((s) => (
              <Pill key={s} label={s} on={s === scene} onPress={() => setScene(s)} />
            ))}
          </View>
          <View style={styles.track}>
            {COLORS.map((c) => (
              <Pill key={c} label={c} on={c === colorMode} onPress={() => void session.control.setFormat({ colorMode: c })} />
            ))}
          </View>
          <View style={styles.track}>
            <Pill label={fit} on={false} onPress={() => setFit((f) => (f === 'fit' ? 'fill' : 'fit'))} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  devRow: { position: 'absolute', top: 8, left: 8, right: 8, flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  track: { flexDirection: 'row', padding: 3, borderRadius: 10, borderCurve: 'continuous', backgroundColor: 'rgba(0,0,0,0.45)' },
  option: { minHeight: 26, minWidth: 40, paddingHorizontal: 8, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  optionOn: { backgroundColor: '#ffffff' },
  optionText: { fontFamily: fonts.semibold, fontSize: 11, color: '#ffffff' },
  optionTextOn: { color: '#111111' },
});
