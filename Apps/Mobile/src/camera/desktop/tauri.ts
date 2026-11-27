/**
 * The smallest typed bridge to Tauri 2's IPC, without `@tauri-apps/api`.
 *
 * Inside the desktop app (`Apps/Desktop/crates/pm-desktop`) Tauri injects
 * `window.__TAURI_INTERNALS__` (and `window.__TAURI__`, since `withGlobalTauri` is on). This
 * file talks to those directly so the mobile app gains no dependency. In a browser, on a
 * phone and in tests without a fake, `isTauri()` is false and nothing here is called.
 */

type Callback = (response: unknown) => void;

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>, options?: unknown): Promise<unknown>;
  transformCallback(callback: Callback, once?: boolean): number;
  unregisterCallback?(id: number): void;
}

interface TauriGlobal {
  core?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  event?: {
    listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
  };
}

interface TauriWindow {
  __TAURI_INTERNALS__?: TauriInternals;
  __TAURI__?: TauriGlobal;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener(event: string, eventId: number): void };
}

function tauriWindow(): TauriWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as TauriWindow);
}

/** True inside the Tauri desktop app. */
export function isTauri(): boolean {
  return !!tauriWindow()?.__TAURI_INTERNALS__;
}

/** Calls a Rust `#[tauri::command]`. Arguments are camelCase; Tauri maps them to snake_case. */
export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = tauriWindow();
  if (w?.__TAURI_INTERNALS__) return w.__TAURI_INTERNALS__.invoke(cmd, args) as Promise<T>;
  if (w?.__TAURI__?.core) return w.__TAURI__.core.invoke(cmd, args) as Promise<T>;
  return Promise.reject(new Error('Not running inside the Pocket Monitor desktop app.'));
}

export type Unlisten = () => void;

/**
 * Listens for a Rust `emit`. Returns an unlisten that is safe to call before the listen has
 * resolved (it unregisters as soon as it can).
 */
export function listen<T>(event: string, handler: (payload: T) => void): Unlisten {
  const w = tauriWindow();
  let stopped = false;
  let stop: Unlisten | null = null;
  const done = (unlisten: Unlisten) => {
    if (stopped) unlisten();
    else stop = unlisten;
  };
  if (w?.__TAURI__?.event) {
    w.__TAURI__.event
      .listen(event, (e) => handler(e.payload as T))
      .then(done)
      .catch(() => {});
  } else if (w?.__TAURI_INTERNALS__) {
    const internals = w.__TAURI_INTERNALS__;
    const id = internals.transformCallback((e) => handler((e as { payload: T }).payload));
    internals
      .invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler: id })
      .then((eventId) =>
        done(() => {
          w.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener(event, eventId as number);
          internals.invoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
        }),
      )
      .catch(() => {});
  }
  return () => {
    stopped = true;
    stop?.();
    stop = null;
  };
}
