/**
 * Desktop-only pieces of the Cameras page (`docs/desktop-expo-port.md` A1, A3, B1–B4):
 *
 * - `useDesktopHome`: once per app life, seeds the web stores from the old viewfinder's
 *   settings and follows the command line's first route (`launch_args`, and `launch://args`
 *   when a shortcut is opened while the app runs). On every visit it mirrors the cameras the
 *   PC remembers into the saved list and probes the ones with an address every 3 s.
 * - `DesktopHomeSection`: *Connect by address*, and what the launch chain is doing.
 *
 * Everything here is inert outside the Tauri app.
 */
import { Link04Icon } from '@hugeicons/core-free-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import {
  addressTarget,
  checkCameraAddress,
  launchArgs,
  onLaunchArgs,
  openCamera,
  probeCamera,
  type DesktopLaunchArgs,
} from '@/camera/desktop/connect';
import type { SavedCamera } from '@/camera/types';
import { Button } from '@/components/button';
import { SectionTitle } from '@/components/section-title';
import { TextField } from '@/components/text-field';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { create } from 'zustand';
import { usePendingConnect } from '../pairingStore';
import { useConnectActions } from '../useConnectActions';
import { seedWebStoresOnce, syncKnownCameras } from './desktopSync';

/** How often a remembered address is knocked on, and how long a knock may take (A1). */
const PROBE_EVERY_MS = 3000;

interface LaunchStatus {
  busy: boolean;
  message: string | null;
  set: (patch: Partial<Pick<LaunchStatus, 'busy' | 'message'>>) => void;
}

const useLaunchStatus = create<LaunchStatus>()((set) => ({
  busy: false,
  message: null,
  set: (patch) => set(patch),
}));

let launched = false;

/** Follows one launch's route: the viewfinder (the launch chain or `--camera`), setup, a phone, the demo. */
function useLaunchRouting() {
  const router = useRouter();
  const actions = useConnectActions();
  const begin = usePendingConnect((s) => s.begin);
  const status = useLaunchStatus((s) => s.set);
  const latest = useRef(actions);
  latest.current = actions;

  /** `fresh`: this process's own command line (the backend already linked `--camera`). */
  const follow = useCallback(
    async (args: DesktopLaunchArgs, fresh: boolean) => {
      switch (args.route) {
        case 'setup':
          router.push('/pair');
          return;
        case 'watch':
          router.push(args.phone ? { pathname: '/watcher', params: { phone: args.phone } } : '/watcher');
          return;
        case 'demo':
          latest.current.startDemo();
          return;
        case 'viewfinder':
          break;
        default:
          return;
      }
      if (args.camera) {
        if (fresh) {
          // The backend linked `--camera` at start: follow it on the connect screen.
          begin(addressTarget(args.camera));
          router.push('/connect');
        } else {
          // A second launch handed over: link it the way the address field does.
          void latest.current.connectSaved(addressTarget(args.camera));
        }
        return;
      }
      status({ busy: true, message: 'Opening your camera…' });
      try {
        const opened = await openCamera({ kind: 'auto', ...(args.model != null ? { model: args.model } : {}) });
        status({ busy: false, message: null });
        if (opened.pair) {
          router.push('/pair');
          return;
        }
        if (opened.host) begin(addressTarget(opened.host));
        router.push('/connect');
      } catch (error) {
        status({ busy: false, message: typeof error === 'string' ? error : 'The camera did not answer.' });
      }
    },
    [begin, router, status],
  );

  useEffect(() => {
    if (!desktopCameraEnabled) return;
    const stop = onLaunchArgs((args) => void follow(args, false));
    if (!launched) {
      launched = true;
      void seedWebStoresOnce();
      launchArgs()
        .then((args) => follow(args, true))
        .catch(() => {});
    }
    return stop;
  }, [follow]);
}

/**
 * Desktop behaviour for the Cameras page. Returns which saved cameras answer at their
 * address right now (`true`), do not (`false`), or have not been asked.
 */
export function useDesktopHome(cameras: SavedCamera[]): { online: Record<string, boolean | undefined> } {
  useLaunchRouting();
  const [online, setOnline] = useState<Record<string, boolean | undefined>>({});
  const hosts = cameras
    .filter((c) => c.id.startsWith('desktop-') && c.path.kind === 'station' && c.path.host)
    .map((c) => [c.id, (c.path as { host?: string }).host as string] as const);
  const key = hosts.map(([id, host]) => `${id}=${host}`).join(',');

  useFocusEffect(
    useCallback(() => {
      if (!desktopCameraEnabled) return;
      void syncKnownCameras().catch(() => {});
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      if (!desktopCameraEnabled || !key) return;
      let stopped = false;
      const targets = key.split(',').map((pair) => pair.split('=') as [string, string]);
      const knock = () =>
        targets.forEach(([id, host]) =>
          probeCamera(host)
            .then((up) => !stopped && setOnline((o) => (o[id] === up ? o : { ...o, [id]: up })))
            .catch(() => {}),
        );
      knock();
      const timer = setInterval(knock, PROBE_EVERY_MS);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }, [key]),
  );

  return { online };
}

/** *Connect by address*: an IP, or IP:port (9004 when left out). */
export function DesktopHomeSection({ disabled }: { disabled?: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { connectSaved } = useConnectActions();
  const launch = useLaunchStatus();
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);

  if (!desktopCameraEnabled) return null;

  const connect = async () => {
    try {
      const host = await checkCameraAddress(text);
      setNote(null);
      void connectSaved(addressTarget(host));
    } catch (error) {
      setNote(typeof error === 'string' ? error : "That isn't an address. Try something like 10.0.0.213.");
    }
  };

  return (
    <View style={styles.section}>
      <SectionTitle title="Connect by address" dot={colors.success} />
      {launch.message ? (
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {launch.message}
        </Text>
      ) : null}
      <View style={styles.row}>
        <TextField
          testID="desktop.address"
          accessibilityLabel="Camera address"
          value={text}
          onChangeText={(t) => {
            setText(t);
            if (note) setNote(null);
          }}
          placeholder="10.0.0.213"
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="decimal"
          returnKeyType="go"
          onSubmitEditing={() => void connect()}
          style={styles.field}
        />
        <Button
          title="Connect"
          icon={Link04Icon}
          variant="secondary"
          disabled={disabled || launch.busy || !text.trim()}
          loading={launch.busy}
          onPress={() => void connect()}
          style={styles.button}
        />
      </View>
      {note ? <Text style={styles.error}>{note}</Text> : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    section: { gap: spacing.md },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm },
    field: { flex: 1, minWidth: 0, borderRadius: radius.md },
    button: { minHeight: 50 },
    status: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
    error: { fontFamily: fonts.regular, fontSize: 13, color: colors.destructive },
  };
}
