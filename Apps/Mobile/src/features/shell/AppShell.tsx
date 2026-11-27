import { usePathname } from 'expo-router';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { installDesktopStyles, macOverlayTitleBar, setMacTitleBar } from '@/components/desktop';
import { ContentFrameContext, SIDEBAR_WIDTH, isWideWindow } from '@/constants/layout';
import { type ThemeColors, useThemedStyles } from '@/constants/theme';
import { LaunchSplashOverlay } from '@/features/startup/LaunchSplash';
import { isDialogRoute, isFullBleed } from './destinations';
import { Sidebar } from './Sidebar';

/**
 * The app's frame. In the wide layout (desktop windows, landscape tablets) a persistent sidebar
 * sits left of every page except the full-bleed picture pages (monitor, Multiview, playback); a
 * pairing dialog dims it. Narrower windows get the phone layout untouched: the tree keeps the same
 * shape either way, so resizing across the breakpoint never remounts the navigator.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const { width, height } = useWindowDimensions();
  const pathname = usePathname();
  const wide = isWideWindow(width);
  const sidebar = wide && !isFullBleed(pathname);
  const dialog = wide && isDialogRoute(pathname);

  useEffect(() => {
    if (wide) installDesktopStyles();
  }, [wide]);

  // macOS: content runs under the transparent title bar while the shell shows; the monitor keeps
  // the ordinary title bar its chrome was laid out for.
  useEffect(() => {
    if (macOverlayTitleBar) setMacTitleBar(sidebar ? 'overlay' : 'visible');
  }, [sidebar]);

  const frame = useMemo(() => (sidebar ? { width: Math.max(0, width - SIDEBAR_WIDTH), height } : null), [sidebar, width, height]);

  return (
    <View style={styles.root}>
      {sidebar ? <Sidebar pathname={pathname} /> : null}
      <View style={styles.content}>
        <ContentFrameContext.Provider value={frame}>{children}</ContentFrameContext.Provider>
      </View>
      {sidebar && dialog ? (
        // The pairing dialog dims the content area itself; this dims the sidebar to match.
        <Pressable accessible={false} style={[styles.sidebarScrim, { width: SIDEBAR_WIDTH }]} />
      ) : null}
      {wide && pathname === '/' ? <LaunchSplashOverlay /> : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, flexDirection: 'row' as const, backgroundColor: colors.background },
    content: { flex: 1, minWidth: 0 },
    sidebarScrim: { position: 'absolute' as const, left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  };
}
