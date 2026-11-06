# Bahar Battery Management

An installable web app for **Bahar Battery Sales and Service**, designed for an Android phone and shop computer.

## Implemented

- Customer creation, search, and editing with conflict detection.
- Product catalogue, individual serial numbers, and stock receipts.
- One-unit sales with price snapshots, stock deduction, and warranty records.
- Warranty lookup by customer, serial number, or product.
- UPS AMC contracts with equipment descriptions, two scheduled visits, visit completion, and renewal reminders.
- Responsive dashboard, INR formatting, and India business dates.
- IndexedDB persistence, offline app loading, JSON backup export, and visible sync status.
- Optional Supabase login, owner/staff permissions, durable operation queue, retry deduplication, and atomic database operations.

**This is an initial implementation, not a deployed service.** Local mode works immediately. Shared phone/computer data requires the Supabase setup below and an HTTPS deployment.

## Run locally

Use Node.js 22.12+ or 24 LTS and npm.

```bash
npm ci
npm run dev
```

Open the URL printed by Vite. Without environment settings, the app clearly labels itself **Single-device workspace**. It starts empty and saves data in that browser only. Local records are separate from signed-in cloud records and are not automatically uploaded when you enable cloud mode.

To test production offline behaviour:

```bash
npm run build
npm run preview
```

Open the app online once, then reload and disconnect. Service workers require localhost or HTTPS. An ordinary HTTP LAN address on an Android phone is not enough for offline installation.

## First use

1. Add a customer.
2. Add a product in Inventory, then receive a physical unit using its serial number.
3. Record a sale, selecting that customer and unit. Enter the agreed price and actual warranty dates.
4. Find the coverage in Warranties.
5. Add an AMC with the installed equipment description and two visit dates. Complete visits from AMC.

The default product price is a reference; the sale form deliberately asks for the actual agreed price. Each initial sale contains one unit. Sale references are internal records, not a GST invoice system.

## Enable login and two-device sync

See [the setup guide](docs/SETUP.md) for the database migration, account provisioning, deployment, and verification steps.

Copy `.env.example` to `.env.local` and fill in:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY
VITE_SHOP_ID=YOUR_SHOP_UUID
```

Never use a service-role/secret key in a `VITE_` variable. These variables are public browser configuration. Rebuild after changing them.

## Validation

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit/storage tests cover stock, warranty dates, money, reminders, and durable local work. Database integration tests run the real SQL migration in embedded PostgreSQL (PGlite), with simulated Supabase Auth roles. Browser tests exercise the customer-to-sale-to-AMC flow and offline reload on desktop and Android-sized viewports.

Live Supabase Auth, real device installation, and hosted two-device sync must also be checked after configuration; the automated database tests do not replace those deployment checks.

## Implementation decisions and limits

- To keep the initial implementation small, sync downloads a complete shop snapshot under a shop transaction lock. It does not yet use incremental cursors. This is suitable for an initial small shop dataset; pagination/incremental sync is later work.
- The database uses `units` for stock units. A sale is one line; equipment is stored as a contract description. Separate multi-item sale lines and normalised equipment records remain in the [original blueprint](docs/BLUEPRINT.md).
- Customer edits use expected versions. Conflicting edits or stock conflicts remain visible; export pending work if needed, discard the rejected change, then re-enter against current data.
- Offline sales remain provisional until accepted centrally. Two disconnected devices cannot guarantee stock availability; only one can confirm selling the same unit.
- Offline write access expires 24 hours after successful authenticated sync. Revocation is enforced on the server at the next request; cached local data is not remote-wipeable.
- Reminders are computed in the app (overdue or due within seven days). There is no scheduled message sender, SMS, WhatsApp, push, or closed-app notification in this release.
- JSON export includes cached data and pending commands for recovery. Automated backup restore/import is not implemented. Configure central backups before using live records.
- Staff provisioning is performed by the owner in Supabase, not through an admin screen. Staff may enter sales and AMCs; only owners may add products or stock receipts.
- Returns, stock adjustments, warranty claims, attachments, tax invoicing, and multi-shop switching are not implemented.

## Source map

| File | Purpose |
| --- | --- |
| `src/App.tsx` | Responsive forms, dashboard, search, authentication UI |
| `src/domain.ts` | Business types, validation, optimistic changes, date/currency helpers |
| `src/store.ts` | IndexedDB cache, atomic local writes, durable pending queue |
| `src/cloud.ts` | Supabase authentication client and synchronisation |
| `supabase/migrations/001_shop.sql` | Tables, access policies, atomic sync RPC |
| `tests/` | Business, storage, database, and browser tests |
| `docs/BLUEPRINT.md` | Original longer-term architecture |
