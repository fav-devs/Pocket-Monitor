import { useRef } from 'react';
import { Text } from 'react-native';
import { Sheet } from '@/components/sheet';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { legalDocuments, legalTitles, type LegalPage } from './legal';

/** One legal page in a tall sheet, from bundled text. */
export function LegalDocumentSheet({ page, onClose }: { page: LegalPage | null; onClose: () => void }) {
  const styles = useThemedStyles(createStyles);
  // The page stays on screen while the sheet slides away.
  const last = useRef<LegalPage | null>(page);
  if (page) last.current = page;
  const shown = page ?? last.current;
  return (
    <Sheet visible={!!page} title={shown ? legalTitles[shown] : ''} onClose={onClose} tall>
      <Text selectable style={styles.text} testID={shown ? `legal.document.${shown}` : undefined}>
        {shown ? legalDocuments[shown] : ''}
      </Text>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    text: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.foreground, paddingBottom: 24 },
  };
}
