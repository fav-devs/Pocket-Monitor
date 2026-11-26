import { ViewIcon, ViewOffSlashIcon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';
import { Icon } from '@/components/icon';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

/** A labelled text field (`secureField` / `InputStyle`), with a show/hide toggle for passwords. */
export function FormField({
  label,
  value,
  onChangeText,
  secure,
  hint,
  placeholder,
  testID,
  ...rest
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secure?: boolean;
  hint?: string;
  placeholder?: string;
  testID?: string;
} & Omit<TextInputProps, 'value' | 'onChangeText' | 'secureTextEntry'>) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [reveal, setReveal] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.block}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.field, focused && styles.fieldFocused]}>
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secure && !reveal}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.input, Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)]}
          {...rest}
        />
        {secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
            onPress={() => setReveal((r) => !r)}
            style={({ pressed }) => [styles.reveal, pressed && styles.pressed]}
          >
            <Icon icon={reveal ? ViewOffSlashIcon : ViewIcon} size={20} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    block: { gap: spacing.sm },
    label: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground, paddingHorizontal: 4 },
    field: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      minHeight: 50,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      paddingLeft: spacing.md,
    },
    fieldFocused: { borderColor: colors.primary },
    input: {
      flex: 1,
      minHeight: 48,
      color: colors.foreground,
      fontFamily: fonts.regular,
      fontSize: 16,
      paddingRight: spacing.md,
    },
    reveal: { width: 48, height: 48, alignItems: 'center' as const, justifyContent: 'center' as const },
    pressed: { opacity: 0.6 },
    hint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, paddingHorizontal: 4 },
  };
}
