import { Crosshair, FlipHorizontal2, Lock, Minus, Move3d, Plus, RotateCcw, Ruler, X } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';
import { useCamera, useCameraSession, type GimbalSpeed } from '@/camera';
import { MText, colors, radius, withAlpha } from '@/theme';
import { usePreferences } from '@/state/preferences';
import { FieldLabel, ModeBar, ToggleRow } from '../capture/controls';
import { GIMBAL_MODE_LABEL, GIMBAL_SPEED_LABEL, angleLabel } from '../format';
import { haptics } from '../haptics';
import { ZOOM_RAMP_CHOICES, rampLabel, useLiveUi, useZoomPresets } from '../liveUiStore';
import { PanelSurface, readoutShadow } from '../chrome/primitives';

/** `LiveGimbalButton`: zoom-sized crosshair leading of the zoom chip; toggles the sheet. */
export function LiveGimbalButton({ size, disabled }: { size: number; disabled?: boolean }) {
  const panel = useLiveUi((s) => s.gimbalPanel);
  const set = useLiveUi((s) => s.set);
  const running = useCamera((s) => s.gimbal.program.status === 'running' || s.gimbal.program.status === 'preparing');
  return (
    <Pressable
      testID="monitor.gimbal.controls"
      accessibilityRole="button"
      accessibilityLabel="Gimbal controls"
      disabled={disabled}
      onPress={() => set({ gimbalPanel: panel === 'sheet' ? 'none' : 'sheet', captureSheet: null, zoomDialOpen: false })}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.72 : 1,
      })}
    >
      <Crosshair size={20} color={panel !== 'none' || running ? colors.accent : colors.text} strokeWidth={1.8} style={readoutShadow} />
    </Pressable>
  );
}

function ActionTile({ icon: Icon, title, onPress, active }: { icon: typeof Crosshair; title: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ selected: active }}
      onPress={() => {
        haptics.light();
        onPress();
      }}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 56,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        backgroundColor: active ? withAlpha(colors.accent, 0.16) : withAlpha('#FFFFFF', 0.06),
        borderWidth: 1,
        borderColor: active ? withAlpha(colors.accent, 0.5) : colors.border,
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <Icon size={18} color={active ? colors.accent : colors.secondary} />
      <MText size={10} weight="semibold" color={active ? colors.accent : colors.secondary} numberOfLines={1}>
        {title}
      </MText>
    </Pressable>
  );
}

const SPEEDS: GimbalSpeed[] = ['slow', 'normal', 'fast'];

/**
 * `LiveGimbalControls` sheet: mode, speed, recenter/level/flip, all-axes lock, Direction Lock,
 * zoom preset ramp, and the Motion Control entry. Follow / speed / ramp / A·B·C live here, not
 * leading of the stick (CONTEXT.md Gimbal cluster).
 */
export function LiveGimbalSheet({
  width,
  maxHeight,
  notice,
}: {
  width: number;
  maxHeight: number;
  notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void;
}) {
  const { gimbal } = useCameraSession();
  const g = useCamera((s) => s.gimbal);
  const selfieFlip = useCamera((s) => s.capabilities.selfieFlip);
  const set = useLiveUi((s) => s.set);
  const directionLock = usePreferences((p) => p.directionLock);
  const setPref = usePreferences((p) => p.set);
  const { rampSeconds, setRamp } = useZoomPresets();
  const rampIndex = ZOOM_RAMP_CHOICES.indexOf(rampSeconds);
  const program = g.program;
  const setCount = [program.a, program.b, program.c].filter(Boolean).length;

  return (
    <PanelSurface radius={radius.lg} style={{ width, maxHeight }}>
      <ScrollView bounces={false} contentContainerStyle={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <MText size={13} weight="semibold" tracking={0.6} uppercase accessibilityRole="header">
              Gimbal
            </MText>
            <MText size={11} mono color={colors.muted}>
              Pan {angleLabel(g.yaw)} · Tilt {angleLabel(g.pitch)}
            </MText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => set({ gimbalPanel: 'none' })}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10 }}
          >
            <X size={18} color={colors.secondary} />
          </Pressable>
        </View>

        <FieldLabel>Mode</FieldLabel>
        <ModeBar
          tabs={g.modeOptions.map((m) => GIMBAL_MODE_LABEL[m])}
          uppercase={false}
          selected={Math.max(0, g.modeOptions.indexOf(g.mode))}
          onSelect={(i) => gimbal.setMode(g.modeOptions[i]).catch(() => notice('Gimbal mode not changed', 'error'))}
        />
        <FieldLabel>Speed</FieldLabel>
        <ModeBar
          tabs={SPEEDS.map((s) => GIMBAL_SPEED_LABEL[s])}
          uppercase={false}
          selected={SPEEDS.indexOf(g.speed)}
          onSelect={(i) => gimbal.setSpeed(SPEEDS[i]).catch(() => {})}
        />

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <ActionTile icon={RotateCcw} title={g.recentering ? 'Centring…' : 'Recenter'} onPress={() => gimbal.recenter().catch(() => {})} />
          <ActionTile icon={Ruler} title="Level" onPress={() => gimbal.level().catch(() => {})} />
          {selfieFlip ? (
            <ActionTile
              icon={FlipHorizontal2}
              title={g.face === 'selfie' ? 'Selfie' : 'Flip'}
              active={g.face === 'selfie'}
              onPress={() => gimbal.flip().catch(() => {})}
            />
          ) : null}
          <ActionTile
            icon={Lock}
            title="Lock axes"
            active={g.lockedAllAxes}
            onPress={() => {
              const next = !g.lockedAllAxes;
              gimbal.setLockedAllAxes(next);
              notice(next ? 'Gimbal locked on all axes' : 'Gimbal unlocked');
            }}
          />
        </View>

        <ToggleRow
          title="Direction Lock"
          detail="The stick moves one axis at a time"
          value={directionLock}
          onChange={(v) => setPref('directionLock', v)}
        />

        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
          <View style={{ flex: 1 }}>
            <MText size={13} weight="medium">
              Ramp
            </MText>
            <MText size={11} color={colors.muted}>
              Zoom preset travel time
            </MText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Shorter ramp"
            disabled={rampIndex <= 0}
            onPress={() => setRamp(ZOOM_RAMP_CHOICES[Math.max(0, rampIndex - 1)])}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: rampIndex <= 0 ? 0.35 : 1 }}
          >
            <Minus size={16} color={colors.secondary} />
          </Pressable>
          <MText size={13} weight="semibold" mono style={{ minWidth: 44, textAlign: 'center' }}>
            {rampLabel(rampSeconds)}
          </MText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Longer ramp"
            disabled={rampIndex >= ZOOM_RAMP_CHOICES.length - 1}
            onPress={() => setRamp(ZOOM_RAMP_CHOICES[Math.min(ZOOM_RAMP_CHOICES.length - 1, rampIndex + 1)])}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Plus size={16} color={colors.secondary} />
          </Pressable>
        </View>

        <Pressable
          testID="monitor.gimbal.motion"
          accessibilityRole="button"
          accessibilityLabel="Motion Control"
          onPress={() => set({ gimbalPanel: 'editor' })}
          style={({ pressed }) => ({
            minHeight: 48,
            borderRadius: radius.md,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 12,
            backgroundColor: withAlpha(colors.accent, 0.14),
            borderWidth: 1,
            borderColor: withAlpha(colors.accent, 0.4),
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <Move3d size={18} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <MText size={13} weight="semibold" color={colors.accent}>
              Motion Control
            </MText>
            <MText size={11} color={colors.muted}>
              {setCount === 0 ? 'Repeatable A → B → C pan and tilt' : `${setCount} point${setCount === 1 ? '' : 's'} set`}
            </MText>
          </View>
        </Pressable>
      </ScrollView>
    </PanelSurface>
  );
}

/** All-axes lock chip beside the stick: latched hold, toasts, never a camera SET. */
export function GimbalLockChip({ onUnlock }: { onUnlock: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Gimbal locked. Tap to unlock."
      onPress={onUnlock}
      hitSlop={8}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 9,
        height: 28,
        borderRadius: 14,
        backgroundColor: withAlpha(colors.accent, 0.85),
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <Lock size={12} color="#FFFFFF" />
      <MText size={11} weight="semibold">
        Locked
      </MText>
    </Pressable>
  );
}
