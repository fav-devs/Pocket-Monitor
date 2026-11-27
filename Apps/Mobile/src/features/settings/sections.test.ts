import { describe, expect, it } from 'vitest';
import { sectionInfo, settingsGroups, visibleSectionIds } from './sections';

describe('the settings sections', () => {
  it('lists Gestures under Control on the desktop only', () => {
    const control = settingsGroups.find((g) => g.label === 'Control')!;
    expect(visibleSectionIds(control.ids, true)).toContain('gestures');
    expect(visibleSectionIds(control.ids, false)).not.toContain('gestures');
    expect(visibleSectionIds(control.ids, false)).toEqual(['input', 'motion']);
    expect(sectionInfo('gestures')).toMatchObject({ title: 'Gestures', desktopOnly: true });
  });
});
