import { router } from 'expo-router';
import { SettingsPage } from '@/components/settings-ui';
import MediaSettingsPanel from './MediaSettingsPanel';

/** Standalone Settings → Media page (`/media/settings`), reachable from the library. */
export default function MediaSettingsScreen() {
  return (
    <SettingsPage
      title="Media"
      toolbarTitle="Settings"
      crumbs={[{ label: 'Media', onPress: () => (router.canGoBack() ? router.back() : router.replace('/media')) }]}
    >
      <MediaSettingsPanel />
    </SettingsPage>
  );
}
