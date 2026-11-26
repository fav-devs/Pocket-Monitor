import { useLocalSearchParams } from 'expo-router';
import SettingsScreen from './SettingsScreen';

/** `/settings/<section>`: Operator Setup opened on one section (e.g. `/settings/assists`). */
export default function SettingsSectionScreen() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  return <SettingsScreen initialSection={typeof section === 'string' ? section : undefined} />;
}
