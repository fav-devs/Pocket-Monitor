import { Camera, Ellipsis, MonitorPlay, Plus, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { CameraPageButton } from './CameraPageButton';
import { SignalBars } from './StatusBits';

export interface CameraCardChip {
  id: string;
  title: string;
  active: boolean;
  onPress: () => void;
}

export interface CameraCardItem {
  id: string;
  name: string;
  subtitle: string;
  badge?: string;
  status: string;
  actionTitle: string;
  primary?: boolean;
  available?: boolean;
  signalBars?: number;
  details?: { title: string; value: string }[];
  chips?: CameraCardChip[];
  onAddSetup?: () => void;
  failure?: { title: string; message: string };
  icon?: LucideIcon;
}

const cardBg = (primary?: boolean) => (primary ? '#1C1E1F' : '#171819');

/** One camera on Your cameras (`CameraCatalogCard`). */
export function CameraCard({
  item,
  onActivate,
  menuItems,
  disabled,
}: {
  item: CameraCardItem;
  onActivate: () => void;
  menuItems?: ActionMenuItem[];
  disabled?: boolean;
}) {
  const Icon = item.icon ?? Camera;
  return (
    <View
      testID={`cameras.card.${item.id}`}
      style={{
        minWidth: 0,
        gap: 11,
        paddingHorizontal: 14,
        paddingVertical: 13,
        borderRadius: 13,
        backgroundColor: cardBg(item.primary),
        borderWidth: 1,
        borderColor: item.primary ? withAlpha(colors.accent, 0.26) : 'rgba(255,255,255,0.06)',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: item.primary ? withAlpha(colors.accent, 0.14) : 'rgba(255,255,255,0.05)',
          }}
        >
          <Icon size={19} color={item.primary ? colors.accent : colors.muted} strokeWidth={1.8} />
        </View>
        <PressableScale
          noScale
          disabled={disabled}
          accessibilityLabel={`${item.actionTitle} ${item.name}`}
          onPress={onActivate}
          style={{ flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', gap: 3 }}
        >
          <MText size={14.5} weight="semibold" numberOfLines={1}>
            {item.name}
          </MText>
          <MText size={9.5} color={colors.muted} numberOfLines={1}>
            {item.subtitle}
          </MText>
        </PressableScale>
        {item.badge ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderRadius: 5,
              backgroundColor: item.primary ? withAlpha(colors.accent, 0.16) : 'rgba(255,255,255,0.06)',
            }}
          >
            <MText size={8} weight="bold" tracking={1.1} color={item.primary ? colors.accent : colors.muted} numberOfLines={1}>
              {item.badge}
            </MText>
          </View>
        ) : null}
        {item.signalBars !== undefined ? <SignalBars count={item.signalBars} /> : null}
      </View>

      {item.details?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 8 }}>
          {item.details.map((d) => (
            <View key={d.title} style={{ minWidth: 80, gap: 2 }}>
              <MText size={8} weight="bold" tracking={1.2} color={colors.faint} uppercase>
                {d.title}
              </MText>
              <MText size={10.5} weight="semibold" color={colors.secondary} numberOfLines={1}>
                {d.value}
              </MText>
            </View>
          ))}
        </View>
      ) : null}

      {item.chips?.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
          {item.chips.map((chip) => (
            <PressableScale
              key={chip.id}
              disabled={disabled}
              accessibilityLabel={`Connect ${item.name} over ${chip.title}`}
              onPress={chip.onPress}
              style={{ paddingVertical: 5 }}
            >
              <View
                style={{
                  minHeight: 34,
                  paddingHorizontal: 12,
                  justifyContent: 'center',
                  borderRadius: 9,
                  backgroundColor: chip.active ? withAlpha(colors.accent, 0.16) : 'rgba(255,255,255,0.05)',
                  borderWidth: 1,
                  borderColor: chip.active ? withAlpha(colors.accent, 0.45) : 'rgba(255,255,255,0.06)',
                }}
              >
                <MText size={11} weight="semibold" color={chip.active ? colors.text : colors.muted}>
                  {chip.title}
                </MText>
              </View>
            </PressableScale>
          ))}
          {item.onAddSetup ? (
            <PressableScale
              disabled={disabled}
              accessibilityLabel={`Add a setup for ${item.name}`}
              testID="cameras.addSetup"
              onPress={item.onAddSetup}
              style={{ paddingVertical: 5 }}
            >
              <View
                style={{
                  minHeight: 34,
                  paddingHorizontal: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  borderRadius: 9,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: withAlpha(colors.secondary, 0.22),
                }}
              >
                <Plus size={11} color={colors.muted} strokeWidth={2.4} />
                <MText size={11} weight="semibold" color={colors.muted}>
                  Add setup
                </MText>
              </View>
            </PressableScale>
          ) : null}
        </ScrollView>
      ) : null}

      {item.failure ? (
        <View
          style={{
            flexDirection: 'row',
            gap: 12,
            padding: 12,
            paddingHorizontal: 14,
            borderRadius: 11,
            backgroundColor: withAlpha(colors.linkWatch, 0.08),
            borderWidth: 1,
            borderColor: withAlpha(colors.linkWatch, 0.3),
          }}
        >
          <TriangleAlert size={20} color={colors.linkWatch} />
          <View style={{ flex: 1, gap: 5 }}>
            <MText size={13.5} weight="semibold">
              {item.failure.title}
            </MText>
            <MText size={11.5} color={colors.secondary}>
              {item.failure.message}
            </MText>
          </View>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <MText
          size={9.5}
          color={item.available === false ? colors.faint : colors.muted}
          numberOfLines={2}
          style={{ flex: 1, minWidth: 0 }}
        >
          {item.status}
        </MText>
        {menuItems?.length ? (
          <ActionMenu items={menuItems} accessibilityLabel={`Options for ${item.name}`} disabled={disabled}>
            <View style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Ellipsis size={16} color={colors.secondary} />
            </View>
          </ActionMenu>
        ) : null}
        <CameraPageButton
          title={item.actionTitle}
          primary={item.primary}
          icon={item.actionTitle === 'Open monitor' ? MonitorPlay : undefined}
          disabled={disabled}
          onPress={onActivate}
          accessibilityLabel={`${item.actionTitle} ${item.name}`}
          testID={`cameras.action.${item.id}`}
        />
      </View>
    </View>
  );
}
