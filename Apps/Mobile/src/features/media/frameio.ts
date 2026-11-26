/**
 * Frame.io upload (Frame.io Platform API v4, OAuth 2.0 PKCE through Adobe IMS), following
 * upstream `docs/frameio-setup.md` and OpenCine `OpenCineFrameIO`.
 *
 * - The operator supplies their own Adobe Developer Console "OAuth Native App" Client ID and
 *   the full Default redirect URI (Settings → Media → Frame.io). Nothing is hardcoded; there is
 *   no client secret. An unconfigured build has the feature disabled.
 * - Access and refresh tokens live in expo-secure-store (Keychain / Keystore). On web they are
 *   kept in memory only and vanish on reload.
 *
 * What is real here: configuration checks, PKCE (S256), the authorize URL, redirect parsing,
 * the token exchange/refresh requests, and the v4 REST calls (me, accounts, workspaces,
 * projects, local_upload, part PUTs, status).
 *
 * TODO(native sign-in): presenting the IMS page and catching the `adobe+…://adobeid/…` redirect
 * needs an auth browser session (expo-web-browser `openAuthSessionAsync`, not installed) and the
 * redirect scheme registered in app.json (`scheme`). Until then `beginSignIn` opens the page with
 * Linking and `completeSignIn(redirectUrl)` must be fed the redirect by whoever handles the
 * deep link. Uploading from the camera's own Wi-Fi also needs the internet hop
 * (`FrameioInternetHop`), which lives in the native session.
 *
 * The demo camera uses `DemoFrameioClient`, which simulates projects and uploads so the queue UI
 * can be exercised on web.
 */
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { useMediaPreferences } from '@/state/media';
import { base64Url, sha256, utf8 } from './frameioPkce';

export { base64Url, sha256 } from './frameioPkce';

export const FRAMEIO_SCOPE = 'openid email profile offline_access additional_info.roles';
export const FRAMEIO_AUTHORIZE_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
export const FRAMEIO_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
export const FRAMEIO_API_URL = 'https://api.frame.io/v4';

export interface FrameioConfig {
  clientId: string;
  redirectUri: string;
}

/** A redirect looks like `adobe+{unique}://adobeid/{clientId}`. */
export function validateFrameioConfig(c: FrameioConfig): string | null {
  if (!c.clientId.trim()) return 'Add the Client ID from your Adobe Developer Console credential.';
  if (!/^[A-Za-z0-9_-]{8,}$/.test(c.clientId.trim())) return 'That Client ID does not look right.';
  if (!c.redirectUri.trim()) return 'Add the full Default redirect URI from the same credential.';
  const scheme = urlScheme(c.redirectUri);
  if (!scheme) return 'The redirect URI needs a scheme, like adobe+yourid://adobeid/your_client_id.';
  return null;
}

export function urlScheme(redirectUri: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(redirectUri.trim());
  return m ? m[1] : null;
}

function secureRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) {
    // TODO(native): add expo-crypto for a secure generator on Hermes.
    throw new Error('Secure random numbers are not available on this device.');
  }
  c.getRandomValues(bytes);
  return bytes;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkceChallenge(verifier: string): string {
  return base64Url(sha256(utf8(verifier)));
}

export function generatePkce(): Pkce {
  const verifier = base64Url(secureRandom(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function authorizeUrl(config: FrameioConfig, pkce: Pkce, state: string): string {
  return `${FRAMEIO_AUTHORIZE_URL}?${query({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: FRAMEIO_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  })}`;
}

/** Pulls the authorization code from the IMS redirect, checking `state`. */
export function parseRedirect(url: string, expectedState: string): string {
  const q = url.split('?')[1]?.split('#')[0] ?? '';
  const params = new Map(
    q.split('&').filter(Boolean).map((pair) => {
      const [k, v = ''] = pair.split('=');
      return [decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, ' '))] as const;
    }),
  );
  if (params.get('error')) throw new Error(`Adobe sign-in failed: ${params.get('error_description') ?? params.get('error')}`);
  if (params.get('state') !== expectedState) throw new Error('Sign-in answer did not match this request. Try again.');
  const code = params.get('code');
  if (!code) throw new Error('Sign-in returned no authorization code.');
  return code;
}

// ---------------------------------------------------------------------------------------------
// Tokens

export interface FrameioTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms since epoch. */
  expiresAt: number;
}

const TOKEN_KEY = 'pm.frameio.tokens.v1';
let memoryTokens: string | null = null;

/** Tokens live in the platform keychain (expo-secure-store); web keeps them in memory only. */
export const frameioTokenStore = {
  async read(): Promise<FrameioTokens | null> {
    const raw = Platform.OS === 'web' ? memoryTokens : await (await import('expo-secure-store')).getItemAsync(TOKEN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FrameioTokens;
    } catch {
      return null;
    }
  },
  async write(tokens: FrameioTokens): Promise<void> {
    const raw = JSON.stringify(tokens);
    if (Platform.OS === 'web') memoryTokens = raw;
    else await (await import('expo-secure-store')).setItemAsync(TOKEN_KEY, raw);
  },
  async clear(): Promise<void> {
    if (Platform.OS === 'web') memoryTokens = null;
    else await (await import('expo-secure-store')).deleteItemAsync(TOKEN_KEY);
  },
};

async function tokenRequest(config: FrameioConfig, fields: Record<string, string>): Promise<FrameioTokens> {
  const res = await fetch(`${FRAMEIO_TOKEN_URL}?${query({ client_id: config.clientId })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: query(fields),
  });
  if (!res.ok) throw new Error(`Adobe sign-in answered ${res.status}.`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

// ---------------------------------------------------------------------------------------------
// API

export interface FrameioProject {
  id: string;
  name: string;
  rootFolderId: string | null;
  accountId: string;
  workspaceName?: string;
}

export interface FrameioUploadInput {
  uri: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
}

export interface FrameioClient {
  readonly demo: boolean;
  currentUser(): Promise<{ name: string; email?: string }>;
  listProjects(): Promise<FrameioProject[]>;
  createProject(accountId: string, workspaceId: string, name: string): Promise<FrameioProject>;
  upload(
    project: FrameioProject,
    file: FrameioUploadInput,
    onProgress: (fraction: number) => void,
    signal: { cancelled: boolean },
  ): Promise<{ fileId: string }>;
}

function safeSegment(value: string): string {
  if (!value || value.includes('/') || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid Frame.io identifier.');
  return encodeURIComponent(value);
}

export class HttpFrameioClient implements FrameioClient {
  readonly demo = false;
  constructor(
    private readonly config: FrameioConfig,
    private readonly tokens = frameioTokenStore,
  ) {}

  private async token(): Promise<string> {
    let t = await this.tokens.read();
    if (!t) throw new Error('Sign in to Frame.io first.');
    if (t.expiresAt - Date.now() < 60_000 && t.refreshToken) {
      t = await tokenRequest(this.config, {
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        refresh_token: t.refreshToken,
      });
      await this.tokens.write(t);
    }
    return t.accessToken;
  }

  private async api<T>(path: string[], init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(`${FRAMEIO_API_URL}/${path.map(safeSegment).join('/')}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 401) throw new Error('Frame.io sign-in expired. Sign in again.');
    if (!res.ok) throw new Error(`Frame.io answered ${res.status}.`);
    return (await res.json()) as T;
  }

  async currentUser() {
    const r = await this.api<{ data: { name?: string; email?: string } }>(['me']);
    return { name: r.data.name ?? r.data.email ?? 'Frame.io user', email: r.data.email };
  }

  async listProjects(): Promise<FrameioProject[]> {
    const accounts = await this.api<{ data: { id: string; display_name?: string }[] }>(['accounts']);
    const out: FrameioProject[] = [];
    for (const account of accounts.data) {
      const workspaces = await this.api<{ data: { id: string; name: string }[] }>(['accounts', account.id, 'workspaces']);
      for (const ws of workspaces.data) {
        const projects = await this.api<{ data: { id: string; name: string; root_folder_id?: string }[] }>([
          'accounts',
          account.id,
          'workspaces',
          ws.id,
          'projects',
        ]);
        projects.data.forEach((p) =>
          out.push({ id: p.id, name: p.name, rootFolderId: p.root_folder_id ?? null, accountId: account.id, workspaceName: ws.name }),
        );
      }
    }
    return out;
  }

  async createProject(accountId: string, workspaceId: string, name: string): Promise<FrameioProject> {
    const r = await this.api<{ data: { id: string; name: string; root_folder_id?: string } }>(
      ['accounts', accountId, 'workspaces', workspaceId, 'projects'],
      { method: 'POST', body: { data: { name: name.trim() } } },
    );
    return { id: r.data.id, name: r.data.name, rootFolderId: r.data.root_folder_id ?? null, accountId };
  }

  async upload(project: FrameioProject, file: FrameioUploadInput, onProgress: (f: number) => void, signal: { cancelled: boolean }) {
    if (!project.rootFolderId) throw new Error('That project has no upload folder.');
    if (file.sizeBytes <= 0) throw new Error('Empty file.');
    const created = await this.api<{ data: { id: string; upload_urls: { size: number; url: string }[] } }>(
      ['accounts', project.accountId, 'folders', project.rootFolderId, 'files', 'local_upload'],
      { method: 'POST', body: { data: { name: file.fileName, file_size: file.sizeBytes } } },
    );
    const blob = await (await fetch(file.uri)).blob();
    let offset = 0;
    for (const part of created.data.upload_urls) {
      if (signal.cancelled) throw new Error('Upload cancelled.');
      const chunk = blob.slice(offset, offset + part.size);
      const res = await fetch(part.url, {
        method: 'PUT',
        headers: { 'Content-Type': file.mimeType, 'x-amz-acl': 'private' },
        body: chunk,
      });
      if (!res.ok) throw new Error(`Upload part failed (${res.status}).`);
      offset += part.size;
      onProgress(Math.min(1, offset / file.sizeBytes));
    }
    return { fileId: created.data.id };
  }
}

/** Simulated Frame.io for the demo camera: two projects, uploads that take a moment. */
export class DemoFrameioClient implements FrameioClient {
  readonly demo = true;
  private projects: FrameioProject[] = [
    { id: 'demo-p1', name: 'Pocket Dailies', rootFolderId: 'demo-f1', accountId: 'demo-a', workspaceName: 'Demo' },
    { id: 'demo-p2', name: 'Studio B-Roll', rootFolderId: 'demo-f2', accountId: 'demo-a', workspaceName: 'Demo' },
  ];
  async currentUser() {
    return { name: 'Demo account' };
  }
  async listProjects() {
    await wait(350);
    return [...this.projects];
  }
  async createProject(accountId: string, _workspaceId: string, name: string) {
    const p = { id: `demo-p${this.projects.length + 1}`, name, rootFolderId: `demo-f${this.projects.length + 1}`, accountId };
    this.projects.push(p);
    return p;
  }
  async upload(_project: FrameioProject, file: FrameioUploadInput, onProgress: (f: number) => void, signal: { cancelled: boolean }) {
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      await wait(110);
      if (signal.cancelled) throw new Error('Upload cancelled.');
      onProgress(i / steps);
    }
    return { fileId: `demo-${file.fileName}` };
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------------------------
// Account state

export type FrameioAccountStatus = 'not-configured' | 'signed-out' | 'signing-in' | 'signed-in' | 'error';

interface FrameioAccountState {
  status: FrameioAccountStatus;
  userName: string | null;
  error: string | null;
  projects: FrameioProject[] | null;
  loadingProjects: boolean;
  demo: boolean;
  pending: { state: string; verifier: string } | null;
  /** Re-reads configuration and stored tokens. */
  refresh: (demo: boolean) => Promise<void>;
  beginSignIn: () => Promise<void>;
  completeSignIn: (redirectUrl: string) => Promise<void>;
  signOut: () => Promise<void>;
  loadProjects: () => Promise<void>;
}

export function frameioConfig(): FrameioConfig {
  const p = useMediaPreferences.getState();
  return { clientId: p.frameioClientId.trim(), redirectUri: p.frameioRedirectUri.trim() };
}

/** The client for the current session: simulated for the demo camera, HTTP otherwise. */
export function frameioClient(demo: boolean): FrameioClient {
  return demo ? new DemoFrameioClient() : new HttpFrameioClient(frameioConfig());
}

const demoClient = new DemoFrameioClient();

export const useFrameioAccount = create<FrameioAccountState>()((set, get) => ({
  status: 'not-configured',
  userName: null,
  error: null,
  projects: null,
  loadingProjects: false,
  demo: false,
  pending: null,

  refresh: async (demo) => {
    set({ demo });
    if (demo) {
      const signedIn = get().status === 'signed-in' && get().demo;
      set({ status: signedIn ? 'signed-in' : 'signed-out', error: null });
      return;
    }
    const invalid = validateFrameioConfig(frameioConfig());
    if (invalid) {
      set({ status: 'not-configured', userName: null, projects: null });
      return;
    }
    try {
      const tokens = await frameioTokenStore.read();
      set({ status: tokens ? 'signed-in' : 'signed-out', error: null });
    } catch (e) {
      set({ status: 'error', error: (e as Error).message });
    }
  },

  beginSignIn: async () => {
    if (get().demo) {
      set({ status: 'signing-in', error: null });
      await wait(500);
      set({ status: 'signed-in', userName: (await demoClient.currentUser()).name });
      return;
    }
    const config = frameioConfig();
    const invalid = validateFrameioConfig(config);
    if (invalid) {
      set({ status: 'not-configured', error: invalid });
      return;
    }
    try {
      const pkce = generatePkce();
      const state = base64Url(secureRandom(16));
      set({ status: 'signing-in', error: null, pending: { state, verifier: pkce.verifier } });
      // TODO(native sign-in): use an auth browser session and register the redirect scheme;
      // the deep-link handler then calls `completeSignIn(url)`.
      await Linking.openURL(authorizeUrl(config, pkce, state));
    } catch (e) {
      set({ status: 'error', error: (e as Error).message, pending: null });
    }
  },

  completeSignIn: async (redirectUrl) => {
    const pending = get().pending;
    if (!pending) return;
    try {
      const config = frameioConfig();
      const code = parseRedirect(redirectUrl, pending.state);
      const tokens = await tokenRequest(config, {
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: config.redirectUri,
      });
      await frameioTokenStore.write(tokens);
      const user = await new HttpFrameioClient(config).currentUser();
      set({ status: 'signed-in', userName: user.name, pending: null, error: null });
    } catch (e) {
      set({ status: 'error', error: (e as Error).message, pending: null });
    }
  },

  signOut: async () => {
    if (!get().demo) await frameioTokenStore.clear().catch(() => {});
    set({ status: get().demo || !validateFrameioConfig(frameioConfig()) ? 'signed-out' : 'not-configured', userName: null, projects: null });
  },

  loadProjects: async () => {
    set({ loadingProjects: true, error: null });
    try {
      const projects = await (get().demo ? demoClient : frameioClient(false)).listProjects();
      set({ projects, loadingProjects: false });
    } catch (e) {
      set({ loadingProjects: false, error: (e as Error).message });
    }
  },
}));

export function sharedDemoFrameioClient(): FrameioClient {
  return demoClient;
}
