import type { ReactNode } from 'react';
// react-dom (installed with react-native-web) ships no type declarations here.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { createPortal as untypedCreatePortal } from 'react-dom';
import { StyleSheet, View, type ViewStyle } from 'react-native';

/**
 * Web: an in-tree (touch-through) sheet lays out and stacks inside its parent. Lift it to a window-sized layer on
 * <body> so it covers the screen's chrome wherever its host is mounted, and lets touches through around the tray.
 */
export function WindowLayer({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return <>{children}</>;
  return portal(
    <View pointerEvents="box-none" style={LAYER}>
      {children}
    </View>,
    document.body,
  );
}

const portal = untypedCreatePortal as (node: ReactNode, container: Element) => ReactNode;

const LAYER = StyleSheet.flatten([StyleSheet.absoluteFill, { position: 'fixed', zIndex: 1000 } as unknown as ViewStyle]);
