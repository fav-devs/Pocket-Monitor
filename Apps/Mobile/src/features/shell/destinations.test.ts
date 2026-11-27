import { describe, expect, it } from 'vitest';
import { activeDestination, isDialogRoute, isFullBleed, shellDestinations } from './destinations';

describe('the wide layout sidebar', () => {
  it('lists the places in order, with Server only where it exists', () => {
    expect(shellDestinations({ server: true }).map((d) => d.id)).toEqual(['cameras', 'monitor', 'media', 'multiview', 'watcher', 'server']);
    expect(shellDestinations({ server: false }).map((d) => d.id)).not.toContain('server');
  });

  it('selects the place a route belongs to', () => {
    expect(activeDestination('/')).toBe('cameras');
    expect(activeDestination('/pair')).toBe('cameras');
    expect(activeDestination('/connect?x=1')).toBe('cameras');
    expect(activeDestination('/media')).toBe('media');
    expect(activeDestination('/media/settings')).toBe('media');
    expect(activeDestination('/settings')).toBe('settings');
    expect(activeDestination('/settings/display/')).toBe('settings');
    expect(activeDestination('/watcher')).toBe('watcher');
    expect(activeDestination('/server')).toBe('server');
    expect(activeDestination('/dev/assist-settings')).toBeNull();
  });

  it('hides the sidebar for the picture-first routes only', () => {
    expect(isFullBleed('/live')).toBe(true);
    expect(isFullBleed('/multiview')).toBe(true);
    expect(isFullBleed('/media/abc123')).toBe(true);
    expect(isFullBleed('/media/settings')).toBe(false);
    expect(isFullBleed('/media')).toBe(false);
    expect(isFullBleed('/settings/display')).toBe(false);
    expect(isFullBleed('/')).toBe(false);
  });

  it('opens pairing and connecting as a dialog', () => {
    expect(isDialogRoute('/pair')).toBe(true);
    expect(isDialogRoute('/connect')).toBe(true);
    expect(isDialogRoute('/')).toBe(false);
  });
});
