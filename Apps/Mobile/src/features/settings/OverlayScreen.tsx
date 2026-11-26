import { X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MText, colors } from '@/theme';
import { IconButton } from '@/ui';

function OverlayBody({
  eyebrow,
  title,
  onClose,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={{
          flex: 1,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 12,
          paddingLeft: insets.left + 16,
          paddingRight: insets.right + 16,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconButton icon={X} label="Close" onPress={onClose} />
          <View style={{ flex: 1, gap: 3 }}>
            <MText size={9.5} weight="bold" tracking={0.8} color={colors.accent} uppercase>
              {eyebrow}
            </MText>
            <MText size={22} weight="semibold" accessibilityRole="header" numberOfLines={1}>
              {title}
            </MText>
          </View>
        </View>
        <View style={{ flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' }}>{children}</View>
        {footer ? <View style={{ width: '100%', maxWidth: 760, alignSelf: 'center' }}>{footer}</View> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * A page over the whole window (`MonitorLegalDocumentScreen` / report sheet frame): wordmark
 * eyebrow, title, close button, scrolling body.
 */
export function OverlayScreen(props: {
  visible: boolean;
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Modal visible={props.visible} animationType="slide" onRequestClose={props.onClose} supportedOrientations={['portrait', 'landscape']}>
      <SafeAreaProvider>
        <OverlayBody {...props} />
      </SafeAreaProvider>
    </Modal>
  );
}
