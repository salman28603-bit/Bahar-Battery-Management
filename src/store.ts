import Dexie, { type Table } from 'dexie';
import { apply, empty, type Command, type Role, type Snapshot } from './domain';
export type Pending = { op: Command; error?: string };
export type Cache = { key: string; base: Snapshot; pending: Pending[]; role: Role; lastSync?: string; leaseUntil?: number };
export class ShopDB extends Dexie {
  caches!: Table<Cache, string>;
  constructor(name = 'bahar-v1') { super(name); this.version(1).stores({ caches: 'key' }); }
}
export const db = new ShopDB();
export const newCache = (key: string): Cache => ({ key, base: empty(), pending: [], role: 'owner' });
export function project(cache: Cache) {
  let view = cache.base;
  const issues: string[] = [];
  for (const item of cache.pending) {
    if (item.error) { issues.push(item.error); continue; }
    try { view = apply(view, item.op, cache.role); } catch (e) { issues.push((e as Error).message); }
  }
  return { view, issues };
}
export async function enqueue(key: string, op: Command, local: boolean, database = db) {
  await database.transaction('rw', database.caches, async () => {
    const cache = await database.caches.get(key) ?? newCache(key);
    if (!local && (!cache.leaseUntil || cache.leaseUntil < Date.now())) throw new Error('Reconnect and sign in to renew offline access.');
    if (project(cache).issues.length) throw new Error('Resolve pending sync issues before adding more records.');
    const next = apply(project(cache).view, op, cache.role);
    if (local) {
      next.sales = next.sales.map(s => s.number.startsWith('PENDING-') ? { ...s, number: `LOCAL-${s.id.slice(0, 8)}` } : s);
      cache.base = next;
    } else cache.pending.push({ op });
    await database.caches.put(cache);
  });
}
