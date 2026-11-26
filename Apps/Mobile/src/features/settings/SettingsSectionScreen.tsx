import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import AssistSettingsPanel from '@/features/assists/AssistSettingsPanel';
import MediaSettingsPanel from '@/features/media/MediaSettingsPanel';
import { SettingsScreenPage } from './components/ui';
import type { LegalPage } from './legal';
import { LegalDocumentSheet } from './LegalDocumentSheet';
import { ProblemReportSheet } from './ProblemReportSheet';
import { AboutSection } from './sections/AboutSection';
import { ConnectionSection } from './sections/ConnectionSection';
import { ExposureSection } from './sections/ExposureSection';
import { InputSection, MotionSection } from './sections/MotionSections';
import { DisplaySection, OperatorSection } from './sections/OperatorSections';
import { SharingSection } from './sections/SharingSection';
import { StorageSection } from './sections/StorageSection';
import { SupportSection } from './sections/SupportSection';
import { sectionInfo } from './sections';
import { DesktopAppRows, DesktopNetworkRows, DesktopSupportRows } from './desktop/DesktopSettings';

/** `/settings/<section>`: one Operator Setup section as its own settings page (e.g. `/settings/assists`). */
export default function SettingsSectionScreen() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  const info = sectionInfo(typeof section === 'string' ? section : undefined);
  const [legal, setLegal] = useState<LegalPage | null>(null);
  const [reporting, setReporting] = useState(false);
  if (!info) return <Redirect href="/settings" />;

  let body: ReactNode;
  switch (info.id) {
    case 'connection':
      body = (
        <>
          <ConnectionSection />
          <DesktopNetworkRows />
        </>
      );
      break;
    case 'display':
      body = <DisplaySection />;
      break;
    case 'operator':
      body = (
        <>
          <OperatorSection />
          <DesktopAppRows />
        </>
      );
      break;
    case 'input':
      body = <InputSection />;
      break;
    case 'motion':
      body = <MotionSection />;
      break;
    case 'exposure':
      body = <ExposureSection />;
      break;
    case 'assists':
      body = <AssistSettingsPanel />;
      break;
    case 'media':
      body = <MediaSettingsPanel />;
      break;
    case 'sharing':
      body = <SharingSection />;
      break;
    case 'storage':
      body = <StorageSection />;
      break;
    case 'support':
      body = (
        <>
          <SupportSection onReport={() => setReporting(true)} onPrivacy={() => setLegal('privacy')} />
          <DesktopSupportRows />
        </>
      );
      break;
    case 'about':
      body = <AboutSection onLegal={setLegal} />;
      break;
  }

  return (
    <>
      <SettingsScreenPage title={info.title} fallback="/settings">
        {body}
      </SettingsScreenPage>
      {info.id === 'support' || info.id === 'about' ? (
        <>
          <LegalDocumentSheet page={legal} onClose={() => setLegal(null)} />
          <ProblemReportSheet visible={reporting} onClose={() => setReporting(false)} />
        </>
      ) : null}
    </>
  );
}
