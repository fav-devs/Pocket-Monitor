import type { ReactNode } from 'react';
import { View } from 'react-native';
import { MText, colors } from '@/theme';

export const SCOPE_PANEL_FILL = 'rgba(6,9,8,0.72)';

/** `MonitorScopePanelPlate`: dark glass, 10pt corners, title left and mode chip right. */
export function ScopePlate({ title, chip, width, height, children }: { title: string; chip?: string; width: number; height: number; children?: ReactNode }) {
  return (
    <View
      pointerEvents="none"
      style={{
        width,
        height,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: SCOPE_PANEL_FILL,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      {children}
      <View style={{ position: 'absolute', left: 7, right: 7, top: 5, flexDirection: 'row', justifyContent: 'space-between' }}>
        <MText size={7} weight="bold" tracking={0.8} color="rgba(255,255,255,0.6)" uppercase numberOfLines={1}>
          {title}
        </MText>
        {chip ? (
          <MText size={7} weight="bold" tracking={0.8} color={colors.accent} numberOfLines={1}>
            {chip}
          </MText>
        ) : null}
      </View>
    </View>
  );
}
