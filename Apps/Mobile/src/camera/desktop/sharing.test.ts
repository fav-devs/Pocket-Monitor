import { describe, expect, it } from 'vitest';
import { desktopShareNote, sharingRowsStatus } from './sharing';

describe('desktop preview sharing', () => {
  it('reads a running host as advertising, forwarding the camera’s own HEVC', () => {
    const rows = sharingRowsStatus({ active: true, status: 'On · View only', watchers: 2, stopped: false });
    expect(rows).toMatchObject({ available: true, active: true, state: 'advertising', watchers: 2, joinable: true, video: 'forward', error: null });
    expect(desktopShareNote(true, rows)).toBe('Sharing · 2 watchers · View only');
    expect(desktopShareNote(true, sharingRowsStatus({ active: true, status: 'On · View only', watchers: 1, stopped: false }))).toBe(
      'Sharing · 1 watcher · View only',
    );
    expect(desktopShareNote(true, sharingRowsStatus({ active: true, status: 'On · View only', watchers: 0, stopped: false }))).toBe(
      'Sharing · No watchers · View only',
    );
  });

  it('shows why it stopped or would not start, and nothing for a plain Off', () => {
    const stopped = sharingRowsStatus({ active: false, status: 'Sharing stopped for camera playback', watchers: 0, stopped: true });
    expect(stopped).toMatchObject({ active: false, state: 'failed', error: 'Sharing stopped for camera playback', watchers: 0 });
    expect(desktopShareNote(true, stopped)).toBe('Sharing stopped for camera playback');
    const refused = sharingRowsStatus({ active: false, status: 'Open a live HEVC camera feed to share it', watchers: 0, stopped: false });
    expect(desktopShareNote(true, refused)).toBe('Open a live HEVC camera feed to share it');
    const off = sharingRowsStatus({ active: false, status: 'Off', watchers: 3, stopped: false });
    expect(off).toMatchObject({ state: 'stopped', error: null, watchers: 0 });
    expect(desktopShareNote(true, off)).toBeUndefined();
    expect(desktopShareNote(false, off)).toBe('Connect a camera to share its feed.');
    expect(sharingRowsStatus(null)).toMatchObject({ active: false, state: 'stopped', error: null });
  });
});
