import { createClient } from '@supabase/supabase-js';
import { db, newCache, type Cache } from './store';
import type { Role, Snapshot } from './domain';
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const shopId = import.meta.env.VITE_SHOP_ID || '';
export const cloud = url && key && shopId ? createClient(url, key) : null;
export const configured = Boolean(cloud);
let running: Promise<void> | null = null;
type Response = { snapshot: Snapshot; role: Role };
export async function sync(key: string) {
  if (!cloud) return;
  if (running) return running;
  const work = async () => {
    async function request(op: unknown): Promise<Response> {
      const { data, error } = await cloud!.rpc('shop_sync', { p_shop: shopId, p_op: op });
      if (error) throw error;
      return data as Response;
    }
    async function accept(result: Response, operationId?: string) {
      await db.transaction('rw', db.caches, async () => {
        const c: Cache = await db.caches.get(key) ?? newCache(key);
        if (result.snapshot.revision >= c.base.revision) c.base = result.snapshot; c.role = result.role;
        c.lastSync = new Date().toISOString(); c.leaseUntil = Date.now() + 24 * 60 * 60 * 1000;
        if (operationId) c.pending = c.pending.filter(x => x.op.id !== operationId);
        await db.caches.put(c);
      });
    }
    await accept(await request(null));
    while (true) {
      const item = (await db.caches.get(key))?.pending[0];
      if (!item || item.error) break;
      try { await accept(await request(item.op), item.op.id); }
      catch (error) {
        // Only business-rule errors are terminal. Network/auth errors retain retryable work.
        const e = error as { code?: string; message?: string };
        if (['P0001', '23505', '23503', '23514', '23502', '22P02', '22007', '22003'].includes(e.code || '')) {
          await db.transaction('rw', db.caches, async () => {
            const c = (await db.caches.get(key))!;
            const pending = c.pending.find(x => x.op.id === item.op.id);
            if (pending) pending.error = e.message || 'Operation rejected.';
            await db.caches.put(c);
          });
        }
        throw error;
      }
    }
  };
  running = (navigator.locks ? navigator.locks.request(`bahar-sync-${key}`, work) : work()).finally(() => { running = null; });
  return running;
}
