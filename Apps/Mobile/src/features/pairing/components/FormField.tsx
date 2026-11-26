import { Eye, EyeOff } from 'lucide-react-native';
import { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { MText, colors, fonts } from '@/theme';
import { PressableScale } from '@/ui';

/** Caps label over a dark input (`secureField` / `InputStyle`). */
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
  const [reveal, setReveal] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <MText size={8.5} weight="bold" tracking={1.5} color={colors.faint}>
        {label}
      </MText>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: 46,
          borderRadius: 12,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          paddingLeft: 14,
        }}
      >
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secure && !reveal}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          accessibilityLabel={label}
          style={{ flex: 1, minHeight: 44, color: colors.text, fontFamily: fonts.medium, fontSize: 14, outlineStyle: 'none' } as object}
          {...rest}
        />
        {secure ? (
          <PressableScale
            accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
            onPress={() => setReveal((r) => !r)}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            {reveal ? <EyeOff size={17} color={colors.muted} /> : <Eye size={17} color={colors.muted} />}
          </PressableScale>
        ) : null}
      </View>
      {hint ? (
        <MText size={10.5} color={colors.muted} style={{ lineHeight: 15 }}>
          {hint}
        </MText>
      ) : null}
    </View>
  );
}
