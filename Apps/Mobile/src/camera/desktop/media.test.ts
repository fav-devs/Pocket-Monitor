import { afterEach, describe, expect, it } from 'vitest';
import { controlCopy } from './relay';
import { DesktopMediaService, pmUrl, withUrls, type DesktopMediaItem } from './media';

type Call = { cmd: string; args?: Record<string, unknown> };

/** Tauri's injected internals: records invokes, delivers events to every listener. */
function fakeTauri(answers: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (response: unknown) => void>();
  const listeners = new Map<string, number[]>();
  let next = 1;
  const internals = {
    transformCallback(callback: (response: unknown) => void) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    invoke(cmd: string, args?: Record<string, unknown>) {
      calls.push({ cmd, args });
      if (cmd === 'plugin:event|listen') {
        const event = args!.event as string;
        listeners.set(event, [...(listeners.get(event) ?? []), args!.handler as number]);
        return Promise.resolve(next++);
      }
      if (cmd === 'plugin:event|unlisten') return Promise.resolve();
      const answer = answers[cmd];
      try {
        return Promise.resolve(answer ? answer(args) : null);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  (globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: internals };
  return {
    calls,
    emit(event: string, payload: unknown) {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id: 0, payload });
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function item(n: number): DesktopMediaItem {
  return {
    id: `DCIM/DJI_001/DJI_2026081412520${n}_000${n}_D.MP4`,
    kind: 'video',
    fileName: `DJI_2026081412520${n}_000${n}_D.MP4`,
    createdAt: 1_786_711_921_000,
    sizeBytes: 1000,
    favorite: false,
    deletable: true,
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('pm:// URLs', () => {
  it('names the scheme the way each web view serves it', () => {
    expect(pmUrl('thumb', 'DCIM/A B.MP4', true)).toBe('http://pm.localhost/thumb/DCIM%2FA%20B.MP4');
    expect(pmUrl('thumb', 'DCIM/A.MP4', false)).toBe('pm://localhost/thumb/DCIM%2FA.MP4');
    expect(pmUrl('strip', '3/7', true)).toBe('http://pm.localhost/strip/3/7');
    expect(withUrls(item(1), true).thumbnailUrl).toBe(`http://pm.localhost/thumb/${encodeURIComponent(item(1).id)}`);
  });
});

describe('desktop media service', () => {
  it('answers with the cached list at once and keeps the listing running', async () => {
    const tauri = fakeTauri({ media_list: () => ({ items: [item(1)], listing: true, status: '' }) });
    const service = new DesktopMediaService();
    const items = await service.list();
    expect(items.map((i) => i.id)).toEqual([item(1).id]);
    expect(items[0].thumbnailUrl).toContain('thumb/');
    expect(tauri.calls.find((c) => c.cmd === 'media_list')?.args).toEqual({ refresh: false });
  });

  it('waits for the first page when nothing is cached', async () => {
    const tauri = fakeTauri({ media_list: () => ({ items: [], listing: true, status: 'Listing the card…' }) });
    const service = new DesktopMediaService();
    await flush();
    let done: string[] | null = null;
    void service.list().then((items) => (done = items.map((i) => i.id)));
    await flush();
    expect(done).toBeNull();
    tauri.emit('media://list', { items: [], listing: true, status: '' });
    await flush();
    expect(done).toBeNull();
    tauri.emit('media://list', { items: [item(2)], listing: true, status: '' });
    await flush();
    expect(done).toEqual([item(2).id]);
  });

  it('says so when the camera listed nothing', async () => {
    fakeTauri({ media_list: () => ({ items: [], listing: false, status: 'The camera listed nothing.' }) });
    const service = new DesktopMediaService();
    await expect(service.list()).rejects.toThrow('The camera listed nothing.');
  });

  it('fails a delete Rust refused, so the grid keeps the file', async () => {
    fakeTauri({ media_delete: (args) => ({ deleted: [], refused: args!.ids }) });
    const service = new DesktopMediaService();
    await expect(service.delete([item(1).id])).rejects.toThrow("can't delete");
    fakeTauri({ media_delete: (args) => ({ deleted: args!.ids, refused: [] }) });
    await expect(new DesktopMediaService().delete([item(1).id])).resolves.toBeUndefined();
  });

  it('resolves a download when the original is on disk, with progress on the way', async () => {
    const tauri = fakeTauri();
    const service = new DesktopMediaService();
    const seen: number[] = [];
    const result = service.download(item(1).id, (p) => seen.push(p.bytesDone));
    await flush();
    tauri.emit('media://progress', { id: item(1).id, done: 500, total: 1000 });
    tauri.emit('media://progress', { id: 'other', done: 1, total: 2 });
    tauri.emit('media://ready', { id: item(1).id, local: '/cache/x', proxy: true });
    tauri.emit('media://ready', { id: item(1).id, local: '/cache/x', proxy: false });
    await expect(result).resolves.toContain('file/');
    expect(seen).toEqual([500]);
  });
});

describe('relay copy', () => {
  it('reads the lease in the Link tab words', () => {
    expect(controlCopy({ control: 'held-by', holder: 'Studio iPad' })).toBe('Studio iPad has control');
    expect(controlCopy({ control: 'not-offered', holder: '' })).toBe('Not offered');
  });
});
