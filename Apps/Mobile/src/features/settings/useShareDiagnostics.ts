import { useCallback, useState } from 'react';
import { useCameraSession } from '@/camera';
import { usePreferences } from '@/state/preferences';
import { useSavedCameras } from '@/state/savedCameras';
import { buildDiagnosticsReport, diagnosticsFileName } from './diagnostics';
import { shareOutcomeMessage, shareTextReport } from './shareText';

/** Share Diagnostics: builds the report on this phone and opens the share sheet. */
export function useShareDiagnostics() {
  const session = useCameraSession();
  const [note, setNote] = useState<string | null>(null);
  const share = useCallback(async () => {
    const text = buildDiagnosticsReport({
      session,
      saved: useSavedCameras.getState().cameras,
      preferences: usePreferences.getState(),
    });
    const outcome = await shareTextReport(diagnosticsFileName(), 'Share Diagnostics', text);
    const message = shareOutcomeMessage(outcome);
    setNote(message);
    if (message) setTimeout(() => setNote((n) => (n === message ? null : n)), 3500);
    return outcome;
  }, [session]);
  return { share, note };
}
