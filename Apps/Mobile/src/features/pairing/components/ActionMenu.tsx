import { useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { MText, colors } from '@/theme';
import { PressableScale } from '@/ui';

export interface ActionMenuItem {
  id: string;
  title: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

/**
 * A small anchored menu (SwiftUI `Menu`). The trigger renders through `children`; the menu opens
 * under it and closes on any choice or outside tap.
 */
export function ActionMenu({
  items,
  children,
  accessibilityLabel,
  disabled,
  onPrimary,
  width = 210,
}: {
  items: ActionMenuItem[];
  children: ReactNode;
  accessibilityLabel: string;
  disabled?: boolean;
  /** Tap runs this instead of opening; long press opens the menu (`Menu primaryAction`). */
  onPrimary?: () => void;
  width?: number;
}) {
  const anchor = useRef<View>(null);
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const window = useWindowDimensions();
  const open = () => {
    anchor.current?.measureInWindow((x, y, w, h) => setFrame({ x, y, w, h }));
  };
  const close = () => setFrame(null);
  const left = frame ? Math.max(8, Math.min(window.width - width - 8, frame.x + frame.w - width)) : 0;
  const top = frame ? Math.min(window.height - 12 - items.length * 46, frame.y + frame.h + 6) : 0;
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <PressableScale
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={onPrimary ? 'Touch and hold for more' : undefined}
          disabled={disabled}
          onPress={onPrimary ?? open}
          onLongPress={onPrimary ? open : undefined}
        >
          {children}
        </PressableScale>
      </View>
      <Modal transparent visible={!!frame} onRequestClose={close} animationType="fade">
        <Pressable accessibilityLabel="Close menu" style={{ flex: 1 }} onPress={close}>
          <View
            style={{
              position: 'absolute',
              left,
              top,
              width,
              borderRadius: 12,
              backgroundColor: colors.raised,
              borderWidth: 1,
              borderColor: colors.borderStrong,
              paddingVertical: 4,
              shadowColor: '#000',
              shadowOpacity: 0.45,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
              elevation: 12,
            }}
          >
            {items.map((item, i) => (
              <PressableScale
                key={item.id}
                noScale
                disabled={item.disabled}
                accessibilityLabel={item.title}
                onPress={() => {
                  close();
                  item.onPress();
                }}
                style={{
                  minHeight: 44,
                  justifyContent: 'center',
                  paddingHorizontal: 14,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: colors.border,
                }}
              >
                <MText size={13} weight="medium" color={item.destructive ? colors.recording : colors.text}>
                  {item.title}
                </MText>
              </PressableScale>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
