import { PictureInPictureExitIcon, PictureInPictureOnIcon } from '@hugeicons/core-free-icons';
import { RailButton } from '@/features/live/chrome/primitives';
import { haptics } from '@/features/live/haptics';
import { useBackgroundRuntime } from './backgroundStore';
import { backgroundIos, quietly } from './nativeBackground';

/** Live chrome: open / close Picture in Picture. Renders nothing without iOS PiP. */
export function PictureInPictureButton() {
  const supported = useBackgroundRuntime((s) => s.capabilities?.pictureInPicture ?? false);
  const pip = useBackgroundRuntime((s) => s.pip);
  const ios = backgroundIos;
  if (!ios || !supported) return null;
  return (
    <RailButton
      testID="monitor.system.pip"
      icon={pip.active ? PictureInPictureExitIcon : PictureInPictureOnIcon}
      label={pip.active ? 'Close Picture in Picture' : 'Picture in Picture'}
      caption="PiP"
      active={pip.active}
      disabled={!pip.active && !pip.possible}
      onPress={() => {
        haptics.light();
        quietly(pip.active ? ios.pipStop() : ios.pipStart());
      }}
    />
  );
}
