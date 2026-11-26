import { Camera, Smartphone, type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { SignalBars } from './StatusBits';

export interface Instruction {
  title: string;
  icon: 'camera' | 'phone';
  lines: readonly string[];
}

/** "ON THE CAMERA" / "ON IPHONE" bullet card (`instructionCard`). */
export function InstructionCard({ instruction }: { instruction: Instruction }) {
  const Icon: LucideIcon = instruction.icon === 'camera' ? Camera : Smartphone;
  return (
    <View
      style={{
        gap: 9,
        padding: 13,
        borderRadius: 11,
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: withAlpha(colors.accent, 0.12),
          }}
        >
          <Icon size={14} color={colors.accent} strokeWidth={2} />
        </View>
        <MText size={9} weight="bold" tracking={1.4} color={colors.secondary} uppercase>
          {instruction.title}
        </MText>
      </View>
      {instruction.lines.map((line) => (
        <View key={line} style={{ flexDirection: 'row', gap: 8 }}>
          <MText size={12.5} color={colors.faint}>
            •
          </MText>
          <MText size={12.5} color={colors.secondary} style={{ flex: 1, lineHeight: 18 }}>
            {line}
          </MText>
        </View>
      ))}
    </View>
  );
}

export interface DeviceRowItem {
  id: string;
  name: string;
  subtitle: string;
  selected: boolean;
  bars?: number;
  disabled?: boolean;
  badge?: string;
}

/** One camera in the scan list (`CameraPairingDeviceRow`). */
export function DeviceRow({ device, onPress }: { device: DeviceRowItem; onPress: () => void }) {
  return (
    <PressableScale
      noScale
      testID={`pair.device.${device.id}`}
      accessibilityLabel={`Select ${device.name}`}
      accessibilityState={{ selected: device.selected, disabled: device.disabled }}
      disabled={device.disabled}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingHorizontal: 13,
        paddingVertical: 12,
        minHeight: 52,
        borderRadius: 11,
        backgroundColor: device.selected ? withAlpha(colors.accent, 0.08) : 'rgba(255,255,255,0.03)',
        borderWidth: device.selected ? 1.5 : 1,
        borderColor: device.selected ? withAlpha(colors.accent, 0.5) : 'rgba(255,255,255,0.06)',
      }}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: device.selected ? withAlpha(colors.accent, 0.16) : 'rgba(255,255,255,0.05)',
        }}
      >
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: device.selected ? colors.accent : colors.faint }} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <MText size={13.5} weight="semibold" numberOfLines={1}>
          {device.name}
        </MText>
        <MText size={9.5} color={colors.muted} numberOfLines={1}>
          {device.subtitle}
        </MText>
      </View>
      {device.badge ? (
        <View style={{ paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.06)' }}>
          <MText size={8} weight="bold" tracking={1.1} color={colors.muted}>
            {device.badge}
          </MText>
        </View>
      ) : null}
      {device.bars !== undefined ? <SignalBars count={device.bars} /> : null}
    </PressableScale>
  );
}

/** A plain note card (`emptyTitle`). */
export function NoteCard({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={{ padding: 13, gap: 4, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.03)' }}>
      <MText size={13} weight="semibold">
        {title}
      </MText>
      {detail ? (
        <MText size={11.5} color={colors.muted} style={{ lineHeight: 16 }}>
          {detail}
        </MText>
      ) : null}
    </View>
  );
}

/** Caps title / value tiles in a grid (`presentation.summary`). */
export function SummaryGrid({ items, columns = 2 }: { items: { title: string; value: string }[]; columns?: number }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((d) => (
        <View
          key={d.title}
          style={{
            flexBasis: `${100 / columns - 3}%`,
            flexGrow: 1,
            padding: 12,
            gap: 3,
            borderRadius: 11,
            backgroundColor: 'rgba(255,255,255,0.03)',
          }}
        >
          <MText size={8} weight="bold" tracking={1.3} color={colors.faint} uppercase>
            {d.title}
          </MText>
          <MText size={11} weight="semibold" color={colors.secondary} numberOfLines={2}>
            {d.value}
          </MText>
        </View>
      ))}
    </View>
  );
}
