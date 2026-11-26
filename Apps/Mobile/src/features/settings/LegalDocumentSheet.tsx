import { ScrollView } from 'react-native';
import { MText, colors } from '@/theme';
import { appBrand } from '@/features/startup/brand';
import { legalDocuments, legalTitles, type LegalPage } from './legal';
import { OverlayScreen } from './OverlayScreen';

/** One legal page over the whole window, from bundled text. */
export function LegalDocumentSheet({ page, onClose }: { page: LegalPage | null; onClose: () => void }) {
  return (
    <OverlayScreen visible={!!page} eyebrow={appBrand.name} title={page ? legalTitles[page] : ''} onClose={onClose}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: 16,
          borderRadius: 12,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <MText size={14} selectable style={{ lineHeight: 21 }} testID={page ? `legal.document.${page}` : undefined}>
          {page ? legalDocuments[page] : ''}
        </MText>
      </ScrollView>
    </OverlayScreen>
  );
}
