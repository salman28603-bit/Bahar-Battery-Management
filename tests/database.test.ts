import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID as id } from 'node:crypto';
const sql = new PGlite();
const owner = id(), staff = id(), outsider = id(), shop = id(), otherShop = id();
const customer = id(), product = id(), unit = id();
async function as(user: string) { await sql.query("select set_config('request.jwt.claim.sub', $1, false)", [user]); }
async function call(type: string, data: object, opid = id()) { return sql.query('select public.shop_sync($1, $2::jsonb) as result', [shop, JSON.stringify({ id: opid, type, data })]); }
beforeAll(async () => {
 await sql.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 await sql.exec(readFileSync('supabase/migrations/001_shop.sql','utf8'));
 for (const user of [owner,staff,outsider]) await sql.query('insert into auth.users values($1)',[user]);
 await sql.query("insert into shops(id,name) values($1,'Test shop'),($2,'Other shop')",[shop,otherShop]);
 await sql.query("insert into shop_members values($1,$2,'owner',true),($1,$3,'staff',true)",[shop,owner,staff]);
 await sql.exec('set role authenticated'); await as(owner);
 await call('customer.add',{id:customer,name:'Customer',phone:'9000000000',address:''});
 await call('product.add',{id:product,sku:'SKU',brand:'Test',model:'Battery',category:'Battery',ah:60,price:500000});
 await call('unit.receive',{id:unit,product_id:product,serial:'ABC',received:'2026-11-06'});
});
afterAll(() => sql.close());
it('denies unauthorised shop access and raw writes', async () => {
 await as(outsider); await expect(sql.query('select shop_sync($1,null)',[shop])).rejects.toThrow('access denied');
 expect((await sql.query('select * from customers')).rows).toHaveLength(0);
 await as(owner); await expect(sql.query('select shop_sync($1,null)',[otherShop])).rejects.toThrow('access denied');
 await expect(sql.query("insert into customers(id,shop_id,name,phone,address) values($1,$2,'Bad','1','')",[id(),shop])).rejects.toThrow('permission denied');
});
it('prevents staff from receiving inventory or escalating role', async () => {
 await as(staff); await expect(call('unit.receive',{id:id(),product_id:product,serial:'DEF',received:'2026-11-06'})).rejects.toThrow('owner');
 await expect(sql.query("update shop_members set role='owner' where user_id=$1",[staff])).rejects.toThrow('permission denied'); await as(owner);
});
it('rolls back sale and number on warranty failure, then handles retries and competing sales', async () => {
 const data = { id:id(),customer_id:customer,unit_id:unit,price:500000,date:'2026-11-06',free_end:'2025-11-06',prorated_end:'2029-11-06',terms:'Test' };
 await expect(call('sale.create',data)).rejects.toThrow(); expect((await sql.query('select * from sales')).rows).toHaveLength(0);
 data.free_end='2028-11-06'; const opid=id(); await call('sale.create',data,opid); await call('sale.create',data,opid);
 expect((await sql.query('select * from sales')).rows).toHaveLength(1); expect((await sql.query('select * from warranties')).rows).toHaveLength(1);
 expect((await sql.query("select * from stock_movements where kind='sale'")).rows).toHaveLength(1);
 expect((await sql.query('select number from sales')).rows[0]).toEqual({number:'BHR-000001'});
 await expect(call('sale.create',{...data,id:id()})).rejects.toThrow('no longer available');
 await expect(call('sale.create',{...data,price:1},opid)).rejects.toThrow('reused');
});
it('rejects cross-shop references and duplicate serial numbers', async () => {
 await expect(call('unit.receive',{id:id(),product_id:product,serial:'abc',received:'2026-11-06'})).rejects.toThrow();
 await sql.exec('reset role'); const foreignCustomer=id(); await sql.query("insert into customers(id,shop_id,name,phone,address) values($1,$2,'Other','1','')",[foreignCustomer,otherShop]); await sql.exec('set role authenticated');
 await expect(call('amc.create',{id:id(),customer_id:foreignCustomer,equipment:'UPS',start:'2026-01-01',end:'2027-01-01',amount:10000,visits:[{id:id(),due:'2026-06-01'}]})).rejects.toThrow('foreign key');
});
it('validates AMC dates and returns completed visits in a consistent snapshot', async () => {
 const visit=id(), contract=id(); const data={id:contract,customer_id:customer,equipment:'2 UPS, serials T1/T2, shop floor',start:'2026-01-01',end:'2027-01-01',amount:10000,visits:[{id:visit,due:'2028-01-01'}]};
 await expect(call('amc.create',data)).rejects.toThrow('inside'); data.visits[0].due='2026-06-01'; await call('amc.create',data);
 await as(staff); const r=await call('visit.complete',{id:visit,completed:'2026-06-01'}); const result=(r.rows[0] as any).result;
 expect(result.role).toBe('staff'); expect(result.snapshot.visits[0].completed).toBe('2026-06-01'); expect(result.snapshot.sales).toHaveLength(1); await as(owner);
});
it('rejects stale customer edits without overwriting newer contact details', async () => {
 await call('customer.update',{id:customer,name:'Updated',phone:'9000000001',address:'New',expected_version:1});
 await expect(call('customer.update',{id:customer,name:'Stale',phone:'1',address:'',expected_version:1})).rejects.toThrow('another device');
 expect((await sql.query('select name,version from customers where id=$1',[customer])).rows[0]).toEqual({name:'Updated',version:2});
});
it('denies access after membership is revoked', async () => {
 await sql.exec('reset role'); await sql.query('update shop_members set active=false where user_id=$1',[staff]); await sql.exec('set role authenticated'); await as(staff); await expect(sql.query('select shop_sync($1,null)',[shop])).rejects.toThrow('access denied');
});
