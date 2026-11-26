import { View } from 'react-native';
import { MText, colors, withAlpha } from '@/theme';
import { PulseDot } from './StatusBits';

export type CheckState = 'complete' | 'active' | 'waiting' | 'failed';

export interface PairingCheck {
  title: string;
  subtitle: string;
  state: CheckState;
  stateLabel: string;
}

const okGreen = '#3FD3A3';

/** A passive pairing status row (`CameraPairingCheckRow`). */
export function PairingCheckRow({ check }: { check: PairingCheck }) {
  const { state } = check;
  const failed = state === 'failed';
  const tone = failed ? colors.linkWatch : colors.accent;
  const labelColor = state === 'complete' ? okGreen : state === 'active' ? colors.accent : failed ? colors.linkWatch : colors.faint;
  return (
    <View
      accessible
      accessibilityLabel={`${check.title}, ${check.subtitle}, ${check.stateLabel}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        padding: 13,
        borderRadius: 11,
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor:
            state === 'complete' ? colors.accent : withAlpha(tone, state === 'active' || failed ? 0.16 : 0.04),
        }}
      >
        {state === 'complete' ? (
          <MText size={10} weight="bold" color={colors.background}>
            ✓
          </MText>
        ) : state === 'active' ? (
          <PulseDot size={5} />
        ) : failed ? (
          <MText size={10} weight="bold" color={colors.linkWatch}>
            !
          </MText>
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <MText size={13} weight="semibold">
          {check.title}
        </MText>
        <MText size={9.5} color={colors.muted} numberOfLines={2}>
          {check.subtitle}
        </MText>
      </View>
      <MText size={8.5} weight="bold" tracking={1.1} color={labelColor}>
        {check.stateLabel}
      </MText>
    </View>
  );
}
