import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View } from 'react-native';
import { MText, colors, fonts } from '@/theme';
import { CameraPageButton } from './CameraPageButton';

function DialogFrame({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal transparent visible={visible} onRequestClose={onClose} animationType="fade">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={onClose}
          style={{ flex: 1, backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <Pressable
            onPress={() => {}}
            accessibilityRole="alert"
            style={{
              width: '100%',
              maxWidth: 360,
              borderRadius: 16,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.borderStrong,
              padding: 18,
              gap: 12,
            }}
          >
            {children}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A two-button confirmation (SwiftUI `.alert` with a destructive role). Works on web too. */
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
  return (
    <DialogFrame visible={visible} onClose={onCancel}>
      <MText size={16} weight="semibold">
        {title}
      </MText>
      <MText size={12.5} color={colors.muted} style={{ lineHeight: 18 }}>
        {message}
      </MText>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 9, marginTop: 4 }}>
        <CameraPageButton title="Cancel" onPress={onCancel} />
        <CameraPageButton title={confirmTitle} destructive={destructive} primary={!destructive} onPress={onConfirm} />
      </View>
    </DialogFrame>
  );
}

/** A one-field prompt (`Rename camera`). */
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
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);
  const trimmed = value.trim();
  return (
    <DialogFrame visible={visible} onClose={onCancel}>
      <MText size={16} weight="semibold">
        {title}
      </MText>
      <MText size={12.5} color={colors.muted}>
        {message}
      </MText>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoFocus
        maxLength={40}
        returnKeyType="done"
        onSubmitEditing={() => trimmed && onSubmit(trimmed)}
        accessibilityLabel={placeholder ?? title}
        style={{
          minHeight: 44,
          borderRadius: 10,
          paddingHorizontal: 12,
          backgroundColor: colors.background,
          borderWidth: 1,
          borderColor: colors.border,
          color: colors.text,
          fontFamily: fonts.medium,
          fontSize: 14,
        }}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 9 }}>
        <CameraPageButton title="Cancel" onPress={onCancel} />
        <CameraPageButton title={confirmTitle} primary disabled={!trimmed} onPress={() => onSubmit(trimmed)} />
      </View>
    </DialogFrame>
  );
}
