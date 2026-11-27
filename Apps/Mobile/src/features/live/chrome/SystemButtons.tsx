import { ArrowExpand01Icon, ArrowShrink02Icon } from '@hugeicons/core-free-icons';
import { StripButton } from './StripControls';

/** `PortraitAspectToggle`: FIT ↔ FILL for the portrait picture. */
export function PortraitAspectToggle({ fill, onPress, disabled }: { fill: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <StripButton
      icon={fill ? ArrowShrink02Icon : ArrowExpand01Icon}
      label={fill ? 'Fit picture' : 'Fill picture'}
      below={fill ? 'FIT' : 'FILL'}
      size={22}
      onPress={onPress}
      disabled={disabled}
    />
  );
}
