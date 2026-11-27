/**
 * The wide layout's sidebar: the app's top-level places and how a route maps onto them.
 * Pure (no React) so the routing rules are tested.
 */

export type ShellDestinationId = 'cameras' | 'monitor' | 'media' | 'multiview' | 'watcher' | 'server' | 'settings';

export interface ShellDestination {
  id: ShellDestinationId;
  title: string;
  href: '/' | '/live' | '/media' | '/multiview' | '/watcher' | '/server' | '/settings';
}

const all: ShellDestination[] = [
  { id: 'cameras', title: 'Cameras', href: '/' },
  { id: 'monitor', title: 'Monitor', href: '/live' },
  { id: 'media', title: 'Media', href: '/media' },
  { id: 'multiview', title: 'Multiview', href: '/multiview' },
  { id: 'watcher', title: 'Watch a feed', href: '/watcher' },
  { id: 'server', title: 'Server', href: '/server' },
];

export const settingsDestination: ShellDestination = { id: 'settings', title: 'Settings', href: '/settings' };

/** The sidebar's places, top to bottom (Settings sits apart, at the foot of the list). */
export function shellDestinations({ server }: { server: boolean }): ShellDestination[] {
  return all.filter((d) => d.id !== 'server' || server);
}

function clean(pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] || '/').replace(/\/+$/, '');
  return path || '/';
}

/** Which place a route belongs to (the sidebar's selected item), or null for one outside them. */
export function activeDestination(pathname: string): ShellDestinationId | null {
  const path = clean(pathname);
  if (path === '/' || path === '/pair' || path === '/connect') return 'cameras';
  if (path === '/live') return 'monitor';
  if (path === '/media' || path.startsWith('/media/')) return 'media';
  if (path === '/multiview') return 'multiview';
  if (path === '/watcher') return 'watcher';
  if (path === '/server') return 'server';
  if (path === '/settings' || path.startsWith('/settings/')) return 'settings';
  return null;
}

/**
 * Routes that fill the window with the picture and hide the sidebar: the monitor, Multiview,
 * playback and the assists preview. They keep their own way home.
 */
export function isFullBleed(pathname: string): boolean {
  const path = clean(pathname);
  if (path === '/live' || path === '/multiview' || path === '/dev/assists') return true;
  return path.startsWith('/media/') && path !== '/media/settings';
}

/** Flows that open as a dialog over the shell in the wide layout. */
export function isDialogRoute(pathname: string): boolean {
  const path = clean(pathname);
  return path === '/pair' || path === '/connect';
}
