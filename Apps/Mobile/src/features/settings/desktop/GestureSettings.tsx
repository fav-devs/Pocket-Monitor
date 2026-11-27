/**
 * Settings → Gestures (`docs/desktop-expo-port.md` §1.T): gestures on or off, where they are
 * read from, both hands' pinch-and-drag control, the stick hand, face tracking by itself, and the
 * gesture guide with what each gesture does. The old viewfinder's home screen guide and
 * Moves-sheet rows. In the desktop app they are kept in `desktop-app-v1.txt` and applied live by
 * Rust; on a phone with `PocketHands` (`src/features/gestures`) they are kept in the app's
 * preferences and the source is the camera picture or the phone's front camera.
 */
import {
  Clapping01Icon,
  Drag01Icon,
  FaceIdIcon,
  FourFinger02Icon,
  HandGripIcon,
  HandPointingRight01Icon,
  Joystick02Icon,
  SwipeDown01Icon,
  SwipeLeft01Icon,
  SwipeRight01Icon,
  SwipeUp01Icon,
  ThreeFinger01Icon,
  Tick02Icon,
  VictoryFinger01Icon,
  Video01Icon,
  WavingHand01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  GESTURES,
  GESTURE_ACTIONS,
  DEFAULT_GESTURE_MAP,
  actionLabel,
  gestureMapOf,
  gestureSources,
  holdSeconds,
  loadGestureSettings,
  saveGestureSettings,
  sourceLabel,
  useDesktopGestures,
  withGestureAction,
  type GestureActionKey,
  type GestureKey,
} from '@/camera/desktop/gestures';
import { Icon } from '@/components/icon';
import { ResetAction } from '@/components/reset-action';
import { SettingsRow } from '@/components/settings-ui';
import { Sheet } from '@/components/sheet';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { usePhoneGestures } from '@/features/gestures/phoneGestures';
import { settingsFeedback } from '../components/feedback';
import { FieldRow, Group, Segments, SwitchRow, ValueText } from '../components/ui';

/** Each gesture's picture in the guide. */
export const GESTURE_ICONS: Record<GestureKey, IconSvgElement> = {
  swipe_left: SwipeLeft01Icon,
  swipe_right: SwipeRight01Icon,
  swipe_up: SwipeUp01Icon,
  swipe_down: SwipeDown01Icon,
  palm: FourFinger02Icon,
  fist: HandGripIcon,
  point: HandPointingRight01Icon,
  two: VictoryFinger01Icon,
  horns: ThreeFinger01Icon,
  face_track: FaceIdIcon,
};

const HANDS = [
  { value: 'right', label: 'Right' },
  { value: 'left', label: 'Left' },
] as const;

const secondsText = (s: number) => `Hold ${Number.isInteger(s) ? s : s.toFixed(1)} s`;

/** The Gestures page body. */
export function GestureSettings() {
  const settings = useDesktopGestures((s) => s.settings);
  const running = useDesktopGestures((s) => s.running);
  const error = useDesktopGestures((s) => s.error);
  const [picking, setPicking] = useState<GestureKey | null>(null);
  // Phones: why the models are not running (camera access off, …) and whether the clap can hear.
  const phoneProblem = usePhoneGestures((s) => (s.state === 'failed' ? s.error : null));
  const microphoneOff = usePhoneGestures((s) => s.microphone === 'denied');
  const sources = useMemo(() => gestureSources().map((value) => ({ value, label: sourceLabel(value) })), []);

  useEffect(() => {
    loadGestureSettings().catch(() => {});
  }, []);

  const ready = !!settings;
  const map = gestureMapOf(settings);
  const source = settings?.gestureSource ?? 'cameraFeed';
  const webcamProblem = settings?.gestures && source === 'webcam' ? running?.problem : null;
  const problem = error ?? webcamProblem ?? (settings?.gestures ? phoneProblem : null);
  const handsNote =
    source === 'webcam'
      ? 'Hand control and face tracking read the camera picture.'
      : source === 'frontCamera'
        ? 'Face tracking reads the camera picture.'
        : undefined;
  const isDefault = GESTURES.every((g) => map[g.key] === DEFAULT_GESTURE_MAP[g.key]);
  const picked = picking ? GESTURES.find((g) => g.key === picking) : null;

  return (
    <>
      <Group note={problem ?? undefined}>
        <SwitchRow
          icon={WavingHand01Icon}
          title="Gestures"
          value={!!settings?.gestures}
          disabled={!ready}
          onChange={(gestures) => void saveGestureSettings({ gestures })}
          testID="desktop.gestures"
        />
        <FieldRow icon={Video01Icon} title="Source" disabled={!ready} last>
          <Segments
            label="Gesture source"
            options={sources}
            value={source}
            onChange={(gestureSource) => void saveGestureSettings({ gestureSource })}
          />
        </FieldRow>
      </Group>

      <Group label="Hands" note={handsNote}>
        <SwitchRow
          icon={Drag01Icon}
          title="Hand control"
          value={settings?.handControl ?? true}
          disabled={!ready}
          onChange={(handControl) => void saveGestureSettings({ handControl })}
          testID="desktop.handControl"
        />
        <FieldRow icon={Joystick02Icon} title="Stick hand" disabled={!ready}>
          <Segments
            label="Stick hand"
            options={HANDS}
            value={(settings?.stickIsRight ?? true) ? 'right' : 'left'}
            onChange={(hand) => void saveGestureSettings({ stickIsRight: hand === 'right' })}
          />
        </FieldRow>
        <SwitchRow
          icon={FaceIdIcon}
          title="Auto face track"
          value={!!settings?.autoFaceTrack}
          disabled={!ready}
          onChange={(autoFaceTrack) => void saveGestureSettings({ autoFaceTrack })}
          testID="desktop.autoFaceTrack"
          last
        />
      </Group>

      <Group
        label="Gesture guide"
        trailing={
          <ResetAction
            label="Reset"
            accessibilityLabel="Reset gestures to defaults"
            disabled={!ready || isDefault}
            onReset={() => void saveGestureSettings({ gestureMap: { ...DEFAULT_GESTURE_MAP } })}
          />
        }
      >
        {GESTURES.map((gesture) => {
          const hold = holdSeconds(gesture.key, map);
          return (
            <View key={gesture.key} testID={`desktop.gesture.${gesture.key}`}>
              <SettingsRow
                icon={GESTURE_ICONS[gesture.key]}
                title={gesture.label}
                subtitle={hold != null ? secondsText(hold) : undefined}
                accessory={<ValueText value={actionLabel(map[gesture.key])} />}
                chevron
                disabled={!ready}
                onPress={() => setPicking(gesture.key)}
              />
            </View>
          );
        })}
        <SettingsRow
          icon={Clapping01Icon}
          title="Double clap"
          accessory={<ValueText value={microphoneOff ? 'Microphone off' : 'Recentre'} />}
          last
        />
      </Group>

      <ActionPicker
        title={picked?.label ?? ''}
        visible={!!picked}
        value={picking ? map[picking] : null}
        onPick={(action) => {
          if (picking && settings) void saveGestureSettings(withGestureAction(settings, picking, action));
          setPicking(null);
        }}
        onClose={() => setPicking(null)}
      />
    </>
  );
}

/** What one gesture does: every action, the chosen one ticked. */
function ActionPicker({
  title,
  visible,
  value,
  onPick,
  onClose,
}: {
  title: string;
  visible: boolean;
  value: GestureActionKey | null;
  onPick: (action: GestureActionKey) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Sheet visible={visible} title={title} onClose={onClose} expandable={false}>
      <View accessibilityRole="radiogroup" accessibilityLabel={`${title} action`}>
        {GESTURE_ACTIONS.map((action) => {
          const on = action.key === value;
          return (
            <Pressable
              key={action.key}
              testID={`desktop.gestureAction.${action.key}`}
              accessibilityRole="radio"
              accessibilityLabel={action.label}
              accessibilityState={{ checked: on }}
              onPress={() => {
                settingsFeedback();
                onPick(action.key);
              }}
              style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.surface }]}
            >
              <Text style={[styles.optionLabel, on && styles.optionOn]}>{action.label}</Text>
              {on ? <Icon icon={Tick02Icon} size={18} color={colors.foreground} strokeWidth={2} /> : null}
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    option: {
      minHeight: 48,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      gap: spacing.md,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    optionLabel: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    optionOn: { fontFamily: fonts.semibold },
  };
}
