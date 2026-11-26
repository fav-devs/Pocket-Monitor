import { Alert02Icon, ArrowUp01Icon, CheckmarkCircle02Icon, CloudUploadIcon, Download04Icon, Share08Icon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { Pressable, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Sheet } from '@/components/sheet';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import {
  activeBatch,
  batchCaption,
  batchFraction,
  batchStatusLine,
  type DeliveryBatch,
  type DeliveryDestination,
  destinationTitle,
  useDelivery,
} from './deliveryStore';
import { ProgressBar, TextAction } from './MediaChips';

export function destinationIcon(destination: DeliveryDestination): IconSvgElement {
  return destination === 'share' ? Share08Icon : destination === 'photos' ? Download04Icon : CloudUploadIcon;
}

/** A destination's icon in a 36pt squircle well (or a spinner while it gets going). */
export function DestinationWell({ destination, busy, tone = 'plain' }: { destination: DeliveryDestination; busy?: boolean; tone?: 'plain' | 'done' | 'failed' }) {
  const { colors } = useTheme();
  const icon = tone === 'done' ? CheckmarkCircle02Icon : tone === 'failed' ? Alert02Icon : destinationIcon(destination);
  const color = tone === 'done' ? colors.success : tone === 'failed' ? colors.destructive : colors.foreground;
  return (
    <Squircle width={36} height={36} radius={12} color={tone === 'failed' ? colors.destructiveSoft : colors.surfaceStrong}>
      {busy ? <Spinner opacity={1} size={18} color={colors.foreground} /> : <Icon icon={icon} size={18} color={color} />}
    </Squircle>
  );
}

/** One delivery: what it's doing, its progress, the file in hand and any notes. Sits in a surface card. */
export function BatchRow({ batch, onCancel, last }: { batch: DeliveryBatch; onCancel: () => void; last?: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const live = batch.status === 'running' || batch.status === 'queued';
  const preparing = batch.status === 'running' && batch.clipFraction <= 0;
  const tone = batch.status === 'failed' ? 'failed' : batch.status === 'done' ? 'done' : 'plain';
  const percent = Math.round(batchFraction(batch) * 100);
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={styles.rowTop}>
        <DestinationWell destination={batch.destination} busy={preparing} tone={tone} />
        <View style={styles.rowText}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            style={[styles.rowTitle, batch.status === 'failed' && { color: colors.destructive }, batch.status === 'cancelled' && { color: colors.mutedForeground }]}
          >
            {batchStatusLine(batch)}
          </Text>
          <Text numberOfLines={1} style={styles.rowMeta}>
            {destinationTitle(batch.destination)}
            {batch.project ? ` · ${batch.project.name}` : ''} · {batchCaption(batch)}
          </Text>
        </View>
        {batch.status === 'running' ? <Text style={styles.percent}>{percent}%</Text> : null}
        {live ? <TextAction title="Cancel" label="Cancel delivery" tone="muted" onPress={onCancel} /> : null}
      </View>
      {batch.status === 'running' ? <ProgressBar fraction={batchFraction(batch)} style={styles.bar} /> : null}
      {batch.status === 'running' && batch.filename ? (
        <Text numberOfLines={1} style={styles.file}>
          {batch.filename}
        </Text>
      ) : null}
      {batch.notes.map((n) => (
        <Text key={n} style={styles.note}>
          {n}
        </Text>
      ))}
    </View>
  );
}

/** Expanded delivery chrome (`MonitorMediaDeliveryProgressPanel`): the session's batches in a sheet. */
export function DeliveryQueueSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const batches = useDelivery((s) => s.batches);
  const cancel = useDelivery((s) => s.cancel);
  const clear = useDelivery((s) => s.clearFinished);
  const ordered = [...batches].reverse();
  const finished = batches.some((b) => b.status !== 'running' && b.status !== 'queued');
  return (
    <Sheet
      visible={visible}
      title="Deliveries"
      onClose={onClose}
      footer={
        <View style={styles.footer}>
          <Button title="Clear finished" variant="secondary" disabled={!finished} onPress={clear} style={styles.flex} />
          <Button title="Done" onPress={onClose} style={styles.flex} />
        </View>
      }
    >
      {ordered.length === 0 ? (
        <View style={styles.empty}>
          <Squircle width={52} height={52} radius={17} color={colors.surface}>
            <Icon icon={CloudUploadIcon} size={24} />
          </Squircle>
          <Text style={styles.emptyTitle}>Nothing queued</Text>
          <Text style={styles.emptyMuted}>Select clips, then Share. Progress shows here.</Text>
        </View>
      ) : (
        <View style={styles.card}>
          {ordered.map((b, i) => (
            <BatchRow key={b.id} batch={b} last={i === ordered.length - 1} onCancel={() => cancel(b.id)} />
          ))}
        </View>
      )}
    </Sheet>
  );
}

/** Compact delivery status (`MonitorMediaDeliveryProgressContent`): a floating dock that opens the queue. */
export function DeliveryProgressPill({ bottom }: { bottom: number }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const batches = useDelivery((s) => s.batches);
  const open = useDelivery((s) => s.setPanelOpen);
  const cancel = useDelivery((s) => s.cancel);
  const batch = activeBatch(batches);
  if (!batch) return null;
  const queued = batches.filter((b) => b.status === 'queued').length - (batch.status === 'queued' ? 1 : 0);
  return (
    <View pointerEvents="box-none" style={[styles.pillWrap, { bottom }]}>
      <View style={styles.pill}>
        <Pressable accessibilityRole="button" accessibilityLabel="Expand delivery progress" onPress={() => open(true)} style={({ pressed }) => [styles.pillMain, pressed && { opacity: 0.75 }]}>
          <DestinationWell destination={batch.destination} busy={batch.clipFraction <= 0} />
          <View style={styles.rowText}>
            <View style={styles.pillLine}>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.pillTitle]}>
                {batchStatusLine(batch)}
              </Text>
              <Icon icon={ArrowUp01Icon} size={14} color={colors.mutedForeground} />
            </View>
            <ProgressBar fraction={batchFraction(batch)} height={3} />
            <Text numberOfLines={1} style={styles.rowMeta}>
              {batchCaption(batch)}
              {queued > 0 ? ` · ${queued} more queued` : ''}
            </Text>
          </View>
        </Pressable>
        <TextAction title="Cancel" label="Cancel delivery" tone="muted" onPress={() => cancel(batch.id)} />
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const, marginBottom: spacing.sm },
    row: { paddingHorizontal: spacing.md, paddingVertical: 12, gap: 8 },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    rowTop: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
    rowText: { flex: 1, minWidth: 0, gap: 3 },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    percent: { fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground, fontVariant: ['tabular-nums' as const] },
    bar: { marginLeft: 48 },
    file: { marginLeft: 48, fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
    note: { marginLeft: 48, fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.warning },
    footer: { flexDirection: 'row' as const, gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
    flex: { flex: 1 },
    empty: { alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.lg },
    emptyTitle: { fontFamily: fonts.semibold, fontSize: 17, color: colors.foreground, marginTop: spacing.xs },
    emptyMuted: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, textAlign: 'center' as const },
    pillWrap: { position: 'absolute' as const, left: 16, right: 16, alignItems: 'center' as const, zIndex: 30 },
    pill: {
      width: '100%' as const,
      maxWidth: 460,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      paddingLeft: 10,
      paddingRight: 12,
      paddingVertical: 8,
      borderRadius: 24,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    pillMain: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, minHeight: 44 },
    pillLine: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
    pillTitle: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.foreground },
  };
}
