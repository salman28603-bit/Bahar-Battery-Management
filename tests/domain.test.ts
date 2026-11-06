import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { apply, available, dueStatus, empty, paise, uid, type Command } from '../src/domain';
import { enqueue, newCache, project, ShopDB } from '../src/store';
const customer: Command = { id: uid(), type: 'customer.add', data: { id: uid(), name: 'Test customer', phone: '9000000000', address: '' } };
const product: Command = { id: uid(), type: 'product.add', data: { id: uid(), sku: 'TEST', brand: 'Test', model: 'Model', category: 'Battery', ah: 60, price: 500000 } };
const unit: Command = { id: uid(), type: 'unit.receive', data: { id: uid(), product_id: product.data.id, serial: 'SERIAL-01', received: '2026-11-06' } };
const sale: Command = { id: uid(), type: 'sale.create', data: { id: uid(), customer_id: customer.data.id, unit_id: unit.data.id, price: 500000, date: '2026-11-06', free_end: '2028-11-06', prorated_end: '2029-11-06', terms: 'Example' } };
function stocked() { return [customer, product, unit].reduce((s, op) => apply(s, op), empty()); }
describe('shop rules', () => {
 it('creates warranty and removes availability atomically without mutating previous state', () => { const before = stocked(); const after = apply(before, sale); expect(after.warranties).toHaveLength(1); expect(available(after, unit.data.id)).toBe(false); expect(before.sales).toHaveLength(0); });
 it('rejects selling a unit twice', () => { expect(() => apply(apply(stocked(), sale), { ...sale, id: uid(), data: { ...sale.data, id: uid() } })).toThrow('no longer available'); });
 it('rejects duplicate serials case-insensitively', () => { expect(() => apply(stocked(), { ...unit, id: uid(), data: { ...unit.data, id: uid(), serial: 'serial-01' } })).toThrow('serial number already'); });
 it('enforces owner inventory permission', () => expect(() => apply(empty(), product, 'staff')).toThrow('owner'));
 it('rejects backwards warranty coverage', () => expect(() => apply(stocked(), { ...sale, data: { ...sale.data, free_end: '2025-01-01' } })).toThrow('Warranty'));
 it('converts money without float rounding or negative values', () => { expect(paise('1234.56')).toBe(123456); expect(() => paise('-1')).toThrow(); expect(() => paise('1.001')).toThrow(); });
 it('classifies overdue and seven-day reminders with calendar dates', () => { expect(dueStatus('2026-11-05', null, '2026-11-06')).toBe('Overdue'); expect(dueStatus('2026-11-13', null, '2026-11-06')).toBe('Due soon'); expect(dueStatus('2026-11-14', null, '2026-11-06')).toBe('Scheduled'); expect(dueStatus('2026-11-05', '2026-11-06')).toBe('Completed'); });
 it('persists queued records across database reopen and isolates accounts', async () => {
  const name = uid(); let db = new ShopDB(name); const c = newCache('account-a'); c.leaseUntil = Date.now() + 50000; await db.caches.put(c);
  await enqueue(c.key, customer, false, db); db.close(); db = new ShopDB(name);
  const restored = (await db.caches.get(c.key))!; expect(restored.pending).toHaveLength(1); expect(project(restored).view.customers).toHaveLength(1); expect(await db.caches.get('account-b')).toBeUndefined(); await db.delete();
 });
 it('rejects expired offline access without saving a command', async () => { const db = new ShopDB(uid()); await expect(enqueue('expired', customer, false, db)).rejects.toThrow('Reconnect'); expect(await db.caches.count()).toBe(0); await db.delete(); });
 it('rolls back invalid local sales', async () => { const db = new ShopDB(uid()); for (const op of [customer, product, unit]) await enqueue('local', op, true, db); await expect(enqueue('local', { ...sale, data: { ...sale.data, price: -1 } }, true, db)).rejects.toThrow(); const c = (await db.caches.get('local'))!; expect(c.base.sales).toHaveLength(0); expect(available(c.base, unit.data.id)).toBe(true); await db.delete(); });
});
