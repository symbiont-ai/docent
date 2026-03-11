// ==========================================================
// DOCENT — IndexedDB Storage Adapter
// Replaces Claude artifact's window.storage API
// ==========================================================

import { get, set, del, keys } from 'idb-keyval';

export const storage = {
  async get(key: string): Promise<{ value: string | undefined }> {
    const value = await get<string>(key);
    return { value };
  },

  async set(key: string, value: string): Promise<void> {
    await set(key, value);
  },

  async delete(key: string): Promise<void> {
    await del(key);
  },

  async list(prefix: string): Promise<{ keys: string[] }> {
    const allKeys = await keys();
    return {
      keys: allKeys
        .map(k => String(k))
        .filter(k => k.startsWith(prefix)),
    };
  },
};
