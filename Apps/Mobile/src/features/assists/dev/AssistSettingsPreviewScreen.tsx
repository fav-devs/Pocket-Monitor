import { SettingsPage } from '@/components/settings-ui';
import AssistSettingsPanel from '../AssistSettingsPanel';

/** Dev-only: Settings → View Assists on its own page (`/dev/assist-settings`). */
export default function AssistSettingsPreviewScreen() {
  return (
    <SettingsPage title="View Assists">
      <AssistSettingsPanel />
    </SettingsPage>
  );
}
