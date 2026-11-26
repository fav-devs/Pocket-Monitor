import { ChevronUp } from 'lucide-react-native';
import { ActivityIndicator, View } from 'react-native';
import { MText, colors, radius } from '@/theme';
import { PressableScale } from '@/ui';
import {
  activeBatch,
  batchCaption,
  batchFraction,
  batchStatusLine,
  type DeliveryBatch,
  destinationTitle,
  useDelivery,
} from './deliveryStore';
import { DestinationIcon } from './DeliverySheet';
import { ProgressTrack } from './MediaChips';
import { ActionButton, CardHeader, CardScroll, OverlayCard } from './MediaOverlays';

export function BatchRow({ batch, onCancel }: { batch: DeliveryBatch; onCancel: () => void }) {
  const live = batch.status === 'running' || batch.status === 'queued';
  const tone = batch.status === 'failed' ? colors.recording : batch.status === 'done' ? colors.linkStable : colors.text;
  const preparing = batch.status === 'running' && batch.clipFraction <= 0;
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {preparing ? <ActivityIndicator size="small" color={colors.accent} /> : <DestinationIcon destination={batch.destination} size={15} />}
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <MText size={12} weight="semibold" color={tone} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
            {batchStatusLine(batch)}
          </MText>
          <MText size={10} weight="medium" color={colors.muted} mono numberOfLines={1}>
            {destinationTitle(batch.destination)}
            {batch.project ? ` · ${batch.project.name}` : ''} · {batchCaption(batch)}
          </MText>
        </View>
        {live ? (
          <PressableScale accessibilityLabel="Cancel delivery" onPress={onCancel} style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }}>
            <MText size={11} weight="semibold" color={colors.muted}>
              Cancel
            </MText>
          </PressableScale>
        ) : null}
      </View>
      {batch.status === 'running' ? <ProgressTrack fraction={batchFraction(batch)} /> : null}
      {batch.status === 'running' && batch.filename ? (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <MText size={10} weight="semibold" color={colors.muted}>
            File
          </MText>
          <MText size={11} mono numberOfLines={1} style={{ flex: 1 }}>
            {batch.filename}
          </MText>
        </View>
      ) : null}
      {batch.notes.map((n) => (
        <MText key={n} size={10.5} color={colors.digitalCrop}>
          {n}
        </MText>
      ))}
    </View>
  );
}

/** Expanded delivery chrome (`MonitorMediaDeliveryProgressPanel`) as a queue of batches. */
export function DeliveryQueuePanel({ onClose }: { onClose: () => void }) {
  const batches = useDelivery((s) => s.batches);
  const cancel = useDelivery((s) => s.cancel);
  const clear = useDelivery((s) => s.clearFinished);
  const ordered = [...batches].reverse();
  const finished = batches.some((b) => b.status !== 'running' && b.status !== 'queued');
  return (
    <OverlayCard onDismiss={onClose} maxWidth={460} label="Delivery queue">
      <CardHeader title="Deliveries" subtitle={batches.length ? `${batches.length} in this session` : 'Nothing queued'} onClose={onClose} />
      <CardScroll>
        {ordered.length === 0 ? (
          <MText size={12} color={colors.muted}>
            Select clips, then Share to cache originals from the camera and deliver them. Progress shows here.
          </MText>
        ) : null}
        {ordered.map((b) => (
          <BatchRow key={b.id} batch={b} onCancel={() => cancel(b.id)} />
        ))}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <ActionButton title="Clear finished" tone="plain" disabled={!finished} onPress={clear} />
          <ActionButton title="Collapse" onPress={onClose} />
        </View>
      </CardScroll>
    </OverlayCard>
  );
}

/** Compact delivery status (`MonitorMediaDeliveryProgressContent` with expand). */
export function DeliveryProgressPill({ bottom }: { bottom: number }) {
  const batches = useDelivery((s) => s.batches);
  const open = useDelivery((s) => s.setPanelOpen);
  const cancel = useDelivery((s) => s.cancel);
  const batch = activeBatch(batches);
  if (!batch) return null;
  const queued = batches.filter((b) => b.status === 'queued').length - (batch.status === 'queued' ? 1 : 0);
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom, alignItems: 'center', zIndex: 30 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingLeft: 12,
          paddingRight: 4,
          borderRadius: radius.lg,
          backgroundColor: colors.glassStrong,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          maxWidth: 440,
          width: '92%',
        }}
      >
        <PressableScale accessibilityLabel="Expand delivery progress" onPress={() => open(true)} noScale style={{ flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {batch.clipFraction <= 0 ? <ActivityIndicator size="small" color={colors.accent} /> : <DestinationIcon destination={batch.destination} size={14} />}
          <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <MText size={12} weight="semibold" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
              {batchStatusLine(batch)}
            </MText>
            <MText size={10} weight="medium" color={colors.muted} mono numberOfLines={1}>
              {batchCaption(batch)}
              {queued > 0 ? ` · ${queued} more queued` : ''}
            </MText>
          </View>
          <ProgressTrack fraction={batchFraction(batch)} style={{ width: 44 }} />
          <ChevronUp size={14} color={colors.muted} />
        </PressableScale>
        <PressableScale accessibilityLabel="Cancel delivery" onPress={() => cancel(batch.id)} style={{ minHeight: 44, minWidth: 52, alignItems: 'center', justifyContent: 'center' }}>
          <MText size={11} weight="semibold" color={colors.muted}>
            Cancel
          </MText>
        </PressableScale>
      </View>
    </View>
  );
}
