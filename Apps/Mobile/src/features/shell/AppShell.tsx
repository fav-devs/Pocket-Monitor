import { usePathname } from 'expo-router';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { invoke, isTauri } from '@/camera/desktop/tauri';
import { installDesktopStyles, macOverlayTitleBar, setMacTitleBar } from '@/components/desktop';
import { ContentFrameContext, SIDEBAR_WIDTH, isWideWindow } from '@/constants/layout';
import { type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import {
  GlassContext,
  bootGlass,
  glassSync,
  installGlassStyles,
  materialStripWidth,
  resolveGlass,
  setGlassScheme,
  useGlassEnv,
} from '@/features/glass';
import { LaunchSplashOverlay } from '@/features/startup/LaunchSplash';
import { usePreferences } from '@/state/preferences';
import { activeDestination, isDialogRoute, isFullBleed } from './destinations';
import { Sidebar } from './Sidebar';

/**
 * The app's frame. In the wide layout (desktop windows, landscape tablets) a persistent sidebar
 * sits left of every page except the full-bleed picture pages (monitor, Multiview, playback); a
 * pairing dialog dims it. Narrower windows get the phone layout untouched: the tree keeps the same
 * shape either way, so resizing across the breakpoint never remounts the navigator.
 *
 * In the desktop app the shell is also where the glass is decided (`features/glass`): the window
 * material behind the sidebar goes on while the sidebar shows and off on the full-bleed pages,
 * so the monitor stays pure black; the controls inside read the choice from `GlassContext`.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const { colors, scheme } = useTheme();
  const { width, height } = useWindowDimensions();
  const pathname = usePathname();
  const wide = isWideWindow(width);
  const sidebar = wide && !isFullBleed(pathname);
  const dialog = wide && isDialogRoute(pathname);

  const caps = useGlassEnv((s) => s.caps);
  const reducedTransparency = useGlassEnv((s) => s.reducedTransparency);
  const pictureOnScreen = useGlassEnv((s) => s.pictureHoles > 0);
  const mode = usePreferences((s) => s.desktopGlass);
  const glass = useMemo(
    () => resolveGlass({ caps, mode, shell: sidebar, reducedTransparency, pictureOnScreen }),
    [caps, mode, sidebar, reducedTransparency, pictureOnScreen],
  );
  const strip = materialStripWidth(activeDestination(pathname) === 'settings');

  useEffect(() => {
    if (wide) installDesktopStyles();
    if (wide) bootGlass();
  }, [wide]);

  useEffect(() => {
    if (!caps) return;
    installGlassStyles();
    setGlassScheme(scheme);
  }, [caps, scheme]);

  // macOS: content runs under the transparent title bar while the shell shows; the monitor keeps
  // the ordinary title bar its chrome was laid out for.
  useEffect(() => {
    if (macOverlayTitleBar) setMacTitleBar(sidebar ? 'overlay' : 'visible');
  }, [sidebar]);

  // The native material: on behind the sidebar strip while the shell shows, off on full-bleed
  // pages (and with Glass off), so nothing native sits over the picture there.
  useEffect(() => {
    if (!caps || caps.preview || !isTauri()) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    invoke('glass_material', { request: { on: glass.material, leading: strip, dark: scheme === 'dark', dpr } }).catch(() => {});
  }, [caps, glass.material, strip, scheme]);

  // Native glass controls follow the shell; a route or theme change re-measures them.
  useEffect(() => {
    glassSync()?.configure({
      enabled: glass.controls === 'native',
      materialWidth: glass.material ? strip : 0,
      underlay: colors.background,
    });
  }, [glass.controls, glass.material, strip, colors.background]);
  useEffect(() => {
    if (glass.controls === 'native') glassSync()?.schedule();
  }, [pathname, scheme, glass.controls]);

  const frame = useMemo(() => (sidebar ? { width: Math.max(0, width - SIDEBAR_WIDTH), height } : null), [sidebar, width, height]);

  return (
    <GlassContext.Provider value={glass}>
      <View style={[styles.root, glass.material && styles.clear]}>
        {sidebar ? <Sidebar pathname={pathname} material={glass.material} preview={!!caps?.preview} /> : null}
        <View style={[styles.content, glass.material && styles.opaque]}>
          <ContentFrameContext.Provider value={frame}>{children}</ContentFrameContext.Provider>
        </View>
        {sidebar && dialog ? (
          // The pairing dialog dims the content area itself; this dims the sidebar to match.
          <Pressable accessible={false} style={[styles.sidebarScrim, { width: SIDEBAR_WIDTH }]} />
        ) : null}
        {wide && pathname === '/' ? <LaunchSplashOverlay /> : null}
      </View>
    </GlassContext.Provider>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, flexDirection: 'row' as const, backgroundColor: colors.background },
    // The window material shows through the sidebar; the page itself stays opaque.
    clear: { backgroundColor: 'transparent' },
    content: { flex: 1, minWidth: 0 },
    opaque: { backgroundColor: colors.background },
    sidebarScrim: { position: 'absolute' as const, left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  };
}
