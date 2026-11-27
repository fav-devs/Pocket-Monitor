import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Bug01Icon,
  Delete02Icon,
  Download01Icon,
  MessageQuestionIcon,
  Settings02Icon,
  Share08Icon,
  Shield01Icon,
} from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { Icon } from '@/components/icon';
import { SettingsRow } from '@/components/settings-ui';
import { useTheme } from '@/constants/theme';
import { ActionRow, Group, LinkRow, ValueRow } from '../components/ui';
import { clearConnectionEvents } from '../diagnostics';
import { useShareDiagnostics } from '../useShareDiagnostics';

/** Support: report a problem, share diagnostics, local report options (`MonitorSupportSettings`). */
export function SupportSection({ onReport, onPrivacy }: { onReport: () => void; onPrivacy: () => void }) {
  const { colors } = useTheme();
  const diagnostics = useShareDiagnostics();
  const [expanded, setExpanded] = useState(false);
  const [cleared, setCleared] = useState(false);
  return (
    <>
      <Group label="Help & feedback" note={diagnostics.note}>
        <LinkRow
          icon={MessageQuestionIcon}
          title="Report a problem"
          onPress={onReport}
          testID="support.report.open"
        />
        <ActionRow
          icon={Share08Icon}
          title="Diagnostics"
          action="Share"
          onPress={() => void diagnostics.share()}
          testID="support.diagnostics"
        />
        <ValueRow icon={Bug01Icon} title="Automatic error reports" value="Off" />
        <LinkRow icon={Shield01Icon} title="Reporting Privacy" onPress={onPrivacy} last />
      </Group>
      <Group>
        <SettingsRow
          icon={Settings02Icon}
          title="Diagnostic options"
          onPress={() => setExpanded((e) => !e)}
          accessory={<Icon icon={expanded ? ArrowUp01Icon : ArrowDown01Icon} size={16} color={colors.mutedForeground} />}
          last={!expanded}
        />
        {expanded ? (
          <>
            <ActionRow
              icon={Download01Icon}
              title="Save diagnostic report"
              action="Save"
              onPress={() => void diagnostics.share()}
            />
            <ActionRow
              icon={Delete02Icon}
              title="Delete connection events"
              action={cleared ? 'Deleted' : 'Delete'}
              destructive={!cleared}
              disabled={cleared}
              onPress={() => {
                clearConnectionEvents();
                setCleared(true);
              }}
              last
            />
          </>
        ) : null}
      </Group>
    </>
  );
}
