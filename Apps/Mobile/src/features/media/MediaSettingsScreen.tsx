import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MText, colors, radius } from '@/theme';
import { PressableScale } from '@/ui';
import MediaSettingsPanel from './MediaSettingsPanel';

/** Standalone Settings → Media page (`/media/settings`), reachable from the gallery. */
export default function MediaSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas, paddingTop: insets.top + 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Math.max(insets.left, 12) }}>
        <PressableScale
          accessibilityLabel="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/media'))}
          style={{ width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center' }}
        >
          <ChevronLeft size={22} color={colors.text} />
        </PressableScale>
        <View>
          <MText size={8.5} weight="bold" tracking={1.4} color={colors.accent}>
            SETTINGS
          </MText>
          <MText size={17} weight="semibold">
            Media
          </MText>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: Math.max(insets.left, insets.right, 12), paddingBottom: insets.bottom + 24, maxWidth: 720, width: '100%', alignSelf: 'center' }}>
        <MediaSettingsPanel />
      </ScrollView>
    </View>
  );
}
