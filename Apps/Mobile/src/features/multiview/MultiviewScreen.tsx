import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/icon';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

export default function MultiviewScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}
      >
        <Icon icon={ArrowLeft01Icon} size={24} color={colors.foreground} />
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.title}>Multiview</Text>
        <Text style={styles.line}>Up to four cameras on one screen. Coming soon.</Text>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md },
    back: { alignSelf: 'flex-start' as const, paddingVertical: 4, marginLeft: -4 },
    body: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, gap: spacing.sm },
    title: { fontFamily: fonts.semibold, fontSize: 20, color: colors.foreground },
    line: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, textAlign: 'center' as const },
  };
}
