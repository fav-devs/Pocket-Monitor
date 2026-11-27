import { backgroundIos } from './nativeBackground';

export { BackgroundMonitor } from './BackgroundMonitor';
export { BackgroundSettingsGroup } from './BackgroundSettingsGroup';
export { PictureInPictureButton } from './PictureInPictureButton';
export { useBackgroundPreferences } from './backgroundStore';

/** The iOS background module is linked (never on web or Android): gate `<BackgroundMonitor>` on it. */
export const hasBackgroundFeatures = backgroundIos != null;
