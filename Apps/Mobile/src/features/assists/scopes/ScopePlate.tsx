import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fonts } from '@/constants/theme';

/** The dark translucent plate scopes and meters sit on over the picture (no border). */
export const SCOPE_PANEL_FILL = 'rgba(0,0,0,0.5)';
export const SCOPE_PLATE_RADIUS = 12;

/** `MonitorScopePanelPlate`: borderless dark plate, 12pt corners, title left and mode pill right. */
export function ScopePlate({ title, chip, width, height, inset = 0, children }: { title: string; chip?: string; width: number; height: number; /** Extra side room for edge lamps (histogram). */ inset?: number; children?: ReactNode }) {
  return (
    <View pointerEvents="none" style={[plateStyles.plate, { width, height }]}>
      {children}
      <View style={[plateStyles.header, inset ? { left: 9 + inset, right: 7 + inset } : null]}>
        <Text numberOfLines={1} style={plateStyles.title}>
          {title}
        </Text>
        {chip ? (
          <View style={plateStyles.chip}>
            <Text numberOfLines={1} style={plateStyles.chipText}>
              {chip}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Shared on-video text and plate styles (always dark, whatever the system theme). */
export const plateStyles = StyleSheet.create({
  plate: { borderRadius: SCOPE_PLATE_RADIUS, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: SCOPE_PANEL_FILL },
  header: { position: 'absolute', left: 9, right: 7, top: 5, height: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  title: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 11, color: 'rgba(255,255,255,0.88)' },
  chip: { borderRadius: 999, paddingHorizontal: 6, height: 15, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  chipText: { fontFamily: fonts.semibold, fontSize: 9, letterSpacing: 0.3, color: '#ffffff' },
});
