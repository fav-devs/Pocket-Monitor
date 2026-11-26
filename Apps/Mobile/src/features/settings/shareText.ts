import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform, Share } from 'react-native';

export type ShareOutcome = 'shared' | 'downloaded' | 'copied' | 'cancelled' | 'failed';

/**
 * Hands a text report to the system share sheet. Phones write a .txt file and share it with
 * expo-sharing (falling back to the plain text share); web uses the Web Share API or a download.
 * Nothing is uploaded by the app itself.
 */
export async function shareTextReport(fileName: string, title: string, text: string): Promise<ShareOutcome> {
  if (Platform.OS === 'web') return shareOnWeb(fileName, title, text);
  try {
    if (await Sharing.isAvailableAsync()) {
      const file = new File(Paths.cache, fileName);
      if (file.exists) file.delete();
      file.create();
      file.write(text);
      await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: title, UTI: 'public.plain-text' });
      return 'shared';
    }
  } catch {
    // fall through to the text share
  }
  try {
    const result = await Share.share({ title, message: text });
    return result.action === Share.dismissedAction ? 'cancelled' : 'shared';
  } catch {
    return 'failed';
  }
}

async function shareOnWeb(fileName: string, title: string, text: string): Promise<ShareOutcome> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  try {
    if (nav && typeof nav.share === 'function') {
      await nav.share({ title, text });
      return 'shared';
    }
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
  }
  try {
    const doc = (globalThis as { document?: Document }).document;
    if (doc && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = doc.createElement('a');
      a.href = url;
      a.download = fileName;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return 'downloaded';
    }
  } catch {
    // try the clipboard
  }
  try {
    await nav?.clipboard?.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function shareOutcomeMessage(outcome: ShareOutcome): string | null {
  switch (outcome) {
    case 'downloaded':
      return 'Report saved to Downloads';
    case 'copied':
      return 'Report copied';
    case 'failed':
      return "Couldn't share the report. Try again.";
    default:
      return null;
  }
}
