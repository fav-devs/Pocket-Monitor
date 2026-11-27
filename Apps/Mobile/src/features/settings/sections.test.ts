import { describe, expect, it } from 'vitest';
import { sectionFromPath, sectionInfo, settingsGroups, settingsLanding, visibleSectionIds } from './sections';

describe('the settings sections', () => {
  it('lists Gestures under Control only where gestures run', () => {
    const control = settingsGroups.find((g) => g.label === 'Control')!;
    expect(visibleSectionIds(control.ids, true)).toContain('gestures');
    expect(visibleSectionIds(control.ids, false)).not.toContain('gestures');
    expect(visibleSectionIds(control.ids, false)).toEqual(['input', 'motion']);
    expect(sectionInfo('gestures')).toMatchObject({ title: 'Gestures', gesturesOnly: true });
  });

  it('opens the wide split view on the first section listed', () => {
    expect(settingsLanding(false)).toBe(settingsGroups[0].ids[0]);
    expect(settingsLanding(true)).toBe('connection');
  });

  it('reads the selected section from the route', () => {
    expect(sectionFromPath('/settings/display')).toBe('display');
    expect(sectionFromPath('/settings/assists?from=exposure')).toBe('assists');
    expect(sectionFromPath('/settings')).toBeNull();
    expect(sectionFromPath('/settings/nope')).toBeNull();
  });
});
