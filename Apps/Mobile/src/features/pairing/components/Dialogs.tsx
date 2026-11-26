import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Sheet } from '@/components/sheet';
import { TextField } from '@/components/text-field';
import { fonts, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';

/** A two-button confirmation as a compact sheet (a destructive choice reads red). Works on web too. */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmTitle,
  destructive,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmTitle: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Sheet visible={visible} title={title} onClose={onCancel} expandable={false}>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        <Button
          title={confirmTitle}
          size="lg"
          variant={destructive ? 'secondary' : 'primary'}
          destructive={destructive}
          onPress={onConfirm}
        />
        <Button title="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </Sheet>
  );
}

/** A one-field prompt (`Rename camera`), the ai-cut rename sheet. */
export function TextPromptDialog({
  visible,
  title,
  message,
  initialValue,
  placeholder,
  confirmTitle = 'Save',
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  initialValue: string;
  placeholder?: string;
  confirmTitle?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);
  const trimmed = value.trim();
  return (
    <Sheet visible={visible} title={title} onClose={onCancel} expandable={false}>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        autoFocus
        selectTextOnFocus
        maxLength={40}
        returnKeyType="done"
        onSubmitEditing={() => trimmed && onSubmit(trimmed)}
        accessibilityLabel={placeholder ?? title}
      />
      <Button title={confirmTitle} size="lg" disabled={!trimmed} onPress={() => onSubmit(trimmed)} />
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    message: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mutedForeground },
    actions: { gap: spacing.xs, paddingTop: spacing.xs },
  };
}
