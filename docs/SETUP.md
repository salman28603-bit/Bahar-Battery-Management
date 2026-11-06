# Set up Bahar for the phone and shop computer

## 1. Create the central database

Create a Supabase project owned by the shop. Run `supabase/migrations/001_shop.sql` once in its SQL editor on a new database. The migration creates tables, policies, and the `shop_sync` transaction function. It is not designed to be rerun over an existing installation.

Disable public sign-up in Supabase Authentication. Create the owner's email/password account using the dashboard and copy its user UUID. Add staff accounts individually later. Do not paste passwords into SQL or commit them to GitHub.

Create the shop and record the returned shop UUID:

```sql
insert into public.shops (name)
values ('Bahar Battery Sales and Service')
returning id;
```

Replace the two placeholders below with the real UUIDs:

```sql
insert into public.shop_members (shop_id, user_id, role)
values ('YOUR_SHOP_UUID', 'YOUR_OWNER_AUTH_UUID', 'owner');
```

For each staff account:

```sql
insert into public.shop_members (shop_id, user_id, role)
values ('YOUR_SHOP_UUID', 'YOUR_STAFF_AUTH_UUID', 'staff');
```

To revoke a staff member:

```sql
update public.shop_members set active = false
where shop_id = 'YOUR_SHOP_UUID' and user_id = 'YOUR_STAFF_AUTH_UUID';
```

Provisioning SQL runs only as the database administrator. App users cannot modify membership or write directly to business tables.

## 2. Configure the app

Copy `.env.example` to `.env.local`. Fill the URL, public key, and shop UUID. All three values are required; otherwise the app runs as a local workspace. Never set a secret/service-role key.

Run `npm ci`, `npm test`, then `npm run build`. The generated `dist/` folder is the static website.

## 3. Host over HTTPS

Deploy with a static host that supports HTTPS and SPA fallback to `index.html`.

- Build command: `npm run build`
- Output directory: `dist`
- Build-time environment: the three `VITE_` settings above
- Serve `sw.js` and `index.html` with revalidation, not a long immutable cache lifetime.
- Hashed files in `assets/` may use a long immutable cache lifetime.
- Restrict the Supabase authentication Site URL and allowed redirect URLs to the actual deployment.

Use the same deployed URL on both devices. Installation can be offered by supported Chrome/Edge browsers using Install app or Add to Home screen. First login and initial data download need internet. Do not browse privately or clear browser storage while changes are pending.

## 4. Verify before entering live shop records

1. Sign in as owner. Create a test customer, product and serial-numbered unit.
2. Sign in as staff on a second device. Confirm the records appear after Sync now and inventory creation is unavailable.
3. Disconnect the second device. Create a customer, reload the app, and confirm the pending count survives.
4. Reconnect and sync. Confirm the new customer appears once on the first device.
5. Try selling the same test unit from both disconnected devices. Sync both. Exactly one sale should confirm; the other should show a conflict.
6. Edit one customer on both offline devices. Sync them and confirm stale contact information does not silently overwrite the first accepted edit.
7. Create an AMC and mark a visit completed. Check the other device sees its completion.
8. Revoke a test account and verify its next server request is denied.
9. Configure and verify database backups in the hosting account before live use.

## Recovery and maintenance

Sync retries network failures on open, reconnect, manual action and every 30 seconds while the app is open. Work stays queued if authentication expires. Signing out is blocked while work remains pending. Use Export backup before resolving conflicts; exported JSON contains customer information and should be kept private.

For a rejected operation, review the reason, discard that operation, then correct/re-enter it. If later operations depend on it, they may also be rejected and require review. Do not edit IndexedDB manually during normal use.

Local exports are recovery evidence, not automatically restorable backups. Cloud data should be recovered through the database provider's backup process. Do not switch to another account to resolve someone else's pending work: local caches are partitioned by shop and account.

The app calculates reminder lists from saved dates. The initial release does not send messages while closed. Keep the AMC page in the shop's daily review routine.
