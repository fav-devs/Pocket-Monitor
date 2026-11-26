import { Cancel01Icon, QrCodeIcon } from '@hugeicons/core-free-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/icon';
import { fonts, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { NetworkSetupCopy } from './copy';
import { parseWifiQr, type WifiQr } from './presentation';

/** QR scanning is available on phones; web shows the typed form only. */
export const wifiQrScanAvailable = true;

/**
 * Full-screen Wi-Fi QR scanner (expo-camera) in the camera screen's chrome: black, the picture
 * edge to edge, a close button in the corner and a notice at the bottom. Calls `onScanned` once
 * with the first valid `WIFI:` payload; anything else is ignored.
 */
export function WifiQrScanner({
  visible,
  onClose,
  onScanned,
}: {
  visible: boolean;
  onClose: () => void;
  onScanned: (wifi: WifiQr) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const frame = Math.round(Math.min(width, height) * 0.62);
  const done = useRef(false);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
      onShow={() => {
        done.current = false;
      }}
    >
      <StatusBar style="light" />
      <View style={styles.root}>
        {permission?.granted ? (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (done.current) return;
                const wifi = parseWifiQr(data);
                if (!wifi) return;
                done.current = true;
                onScanned(wifi);
              }}
            />
            <View pointerEvents="none" style={styles.centre}>
              <View style={{ width: frame, height: frame }}>
                <View style={[styles.corner, styles.topLeft]} />
                <View style={[styles.corner, styles.topRight]} />
                <View style={[styles.corner, styles.bottomLeft]} />
                <View style={[styles.corner, styles.bottomRight]} />
              </View>
            </View>
            <View pointerEvents="none" style={[styles.bottom, { bottom: insets.bottom + spacing.xl }]}>
              <Text style={styles.notice}>Point at a Wi-Fi QR code</Text>
            </View>
          </>
        ) : (
          <View style={[styles.gate, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <View style={styles.gateIcon}>
              <Icon icon={QrCodeIcon} size={28} color="#ffffff" />
            </View>
            <Text style={styles.gateTitle}>Allow the camera to scan a Wi-Fi code</Text>
            <Text style={styles.gateText}>{NetworkSetupCopy.scanQrHint}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Allow camera"
              onPress={() => requestPermission()}
              style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
            >
              <Text style={styles.pillText}>Allow camera</Text>
            </Pressable>
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close scanner"
          hitSlop={10}
          onPress={onClose}
          style={({ pressed }) => [
            styles.close,
            { top: insets.top + spacing.sm, left: Math.max(insets.left, spacing.md) - 4 },
            pressed && styles.pressed,
          ]}
        >
          <Icon icon={Cancel01Icon} size={26} color="#ffffff" strokeWidth={2} />
        </Pressable>
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  const shadow = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 };
  const corner = { position: 'absolute' as const, width: 28, height: 28, borderColor: '#ffffff' };
  return {
    root: { flex: 1, backgroundColor: colors.preview },
    centre: { position: 'absolute' as const, top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center' as const, justifyContent: 'center' as const },
    corner,
    topLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
    topRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
    bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
    bottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
    bottom: { position: 'absolute' as const, left: spacing.xl, right: spacing.xl, alignItems: 'center' as const },
    notice: {
      overflow: 'hidden' as const,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: 'rgba(0,0,0,0.65)',
      fontFamily: fonts.medium,
      fontSize: 14,
      color: '#ffffff',
      textAlign: 'center' as const,
    },
    close: {
      position: 'absolute' as const,
      width: 44,
      height: 44,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    gate: {
      flex: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: spacing.md,
      paddingHorizontal: spacing.xl,
    },
    gateIcon: {
      width: 56,
      height: 56,
      borderRadius: 18,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: 'rgba(255,255,255,0.18)',
    },
    gateTitle: { fontFamily: fonts.semibold, fontSize: 20, color: '#ffffff', textAlign: 'center' as const, ...shadow },
    gateText: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: 'rgba(255,255,255,0.7)',
      textAlign: 'center' as const,
      maxWidth: 360,
    },
    pill: { marginTop: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: 12, borderRadius: 999, backgroundColor: '#ffffff' },
    pillText: { fontFamily: fonts.semibold, fontSize: 15, color: '#111111' },
    pressed: { opacity: 0.7 },
  };
}
