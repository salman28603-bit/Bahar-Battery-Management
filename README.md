# Bahar Battery Management

Starter blueprint for **Bahar Battery Sales and Service**.

**Status:** Planning documentation only. Application code, database migrations, authentication, and deployment have not yet been implemented.

## Goal and scope

Build one installable Progressive Web App (PWA) for an Android phone and shop computer. Start with one shop, INR currency, and Asia/Kolkata business dates.

The first version covers:
- Inventory by product and physical serial number.
- Customer records and search.
- Sales and stock deduction.
- Warranty coverage lookup.
- Installed UPS equipment, AMC contracts, service visits, and reminders.

## Recommended architecture

| Layer | Choice | Purpose |
| --- | --- | --- |
| Interface | React + TypeScript + Vite | Responsive phone and desktop application |
| Installation | PWA | Browser access and installation on supported devices |
| Local storage | IndexedDB through Dexie | Cached records and durable pending operations |
| App caching | Service worker | Load application assets offline after initial setup |
| Central database | Supabase PostgreSQL | Authoritative shared shop records |
| Authentication | Supabase Auth | Individual owner and staff accounts |
| Synchronisation | Custom outbox module and transactional database functions | Validate, deduplicate, and apply changes |
| Reminders | Daily server job and in-app due list | Service and renewal reminders |

Supabase alone does not provide this custom offline sync implementation. Build and test it explicitly. Do not depend on browser background execution: sync on app open, reconnect, and a Sync now button.

## Proposed folder structure

These paths are planned, not existing implementation.

| Path | Responsibility |
| --- | --- |
| README.md | Scope, architecture, and build order |
| .env.example | Configuration placeholders only |
| .gitignore | Exclude secrets, dependencies, and build output |
| src/app/ | Routes, navigation, and layout |
| src/features/auth/ | Login and account access |
| src/features/customers/ | Customer forms and search |
| src/features/inventory/ | Products, serialised units, and stock movements |
| src/features/sales/ | Sale entry and history |
| src/features/warranties/ | Coverage dates and lookup |
| src/features/amc/ | Equipment, contracts, visits, and reminders |
| src/components/ | Shared controls and sync status |
| src/db/ | IndexedDB schema and migrations |
| src/sync/ | Outbox, retries, downloads, and conflict handling |
| src/lib/ | Supabase client, validation, currency/date helpers |
| public/ | Icons and manifest assets |
| supabase/migrations/ | Tables, constraints, policies, and database functions |
| supabase/functions/ | Scheduled reminder processing |
| tests/ | Access control, sale integrity, and offline sync tests |
| docs/ | Further architecture decisions |

## First database tables

Use UUID primary keys so records can be created offline. Business records carry shop_id, created_at, updated_at, and a server-controlled version. The shops table is the root and does not need its own shop_id.

| Table | Initial fields | Relationships and purpose |
| --- | --- | --- |
| shops | id, name, address, timezone | Initial shop: Bahar Battery Sales and Service |
| shop_members | shop_id, user_id, role, active | user_id references the managed Auth user; unique shop/user pair |
| customers | id, shop_id, name, phone, address, notes | One customer has many sales, installed units, and contracts |
| products | id, shop_id, sku, brand, model, category, capacity_ah, default_price_paise | One product has many physical stock units |
| stock_units | id, shop_id, product_id, serial_number, received_date | Individual battery or UPS |
| stock_movements | id, shop_id, stock_unit_id, type, sale_item_id, reason, reverses_movement_id | Append-only receipt, sale, return, and adjustment history |
| sales | id, shop_id, customer_id, status, total_paise, sale_date, confirmed_number | Sale header; final number assigned centrally |
| sale_items | id, shop_id, sale_id, stock_unit_id, unit_price_paise, discount_paise, product_snapshot | One line per physical unit in the first version |
| warranties | id, shop_id, sale_item_id, start_date, free_replacement_end, prorated_end, terms_snapshot | Coverage for a sold unit; sale_item_id is unique |
| customer_equipment | id, shop_id, customer_id, type, model, serial_number, installation_location, stock_unit_id | Installed UPS/batteries; stock_unit_id optional for externally bought equipment |
| amc_contracts | id, shop_id, customer_id, start_date, end_date, amount_paise, status | Maintenance agreement |
| amc_equipment | id, shop_id, contract_id, equipment_id | Contract/equipment join; unique contract/equipment pair |
| amc_visits | id, shop_id, contract_id, due_date, completed_at, notes | Explicit scheduled visits and completion record |
| reminders | id, shop_id, visit_id, contract_id, reminder_date, type, status | Service-due or renewal reminder with a unique deduplication key |

### Integrity rules

- Store money in integer paise: INR 1,250 equals 125000 paise. Compute totals on the server.
- Use calendar dates for coverage and service due dates; use UTC timestamps for events.
- Enforce unique SKU per shop and unique serial number per product within a shop.
- Enforce same-shop foreign-key relationships. AMC equipment must belong to the contract's customer.
- Derive available stock from accepted movements; do not synchronise an editable stock counter.
- Lock and validate the unit inside sale confirmation so two devices cannot confirm selling the same available unit.
- Confirm the sale, sale items, movements, warranties, and sync receipt in one transaction.
- Snapshot product descriptions, prices, and agreed warranty terms at sale time.
- Reverse confirmed transactions with linked corrections; do not delete their history.
- Record created_by and the acting user for auditable changes.
- Validate warranty and contract date order, nonnegative amounts, and allowed status transitions.
- For an AMC with two visits, create two explicit due dates.

## Authentication and permissions

Use individual email/password accounts through Supabase Auth. Disable public self-registration; the owner provisions or invites staff.

| Role | Permissions |
| --- | --- |
| Owner | Manage staff, products, prices, stock adjustments, corrections, and all shop records |
| Staff | Manage customers, enter sales, view stock and warranties, and complete AMC visits |

Enforce shop membership and roles through PostgreSQL Row Level Security and carefully scoped database functions. Hiding buttons is not access control. Restrict direct writes that could bypass sale and inventory invariants.

- First login requires internet.
- Trusted, previously authenticated devices may read cached data and queue allowed work offline.
- Use a limited offline-access period. Account revocation cannot be detected immediately while disconnected.
- Re-authenticate before uploading if the session has expired.
- Recheck current membership and permissions on every server mutation.
- Partition local storage by account and shop. Resolve or explicitly discard pending work before clearing it on logout.
- Keep passwords, real customer data, service-role keys, database credentials, and production exports out of this public repository.
- Only public client configuration belongs in the browser; server secrets remain server-side.

## Offline-first sync strategy

Display Saved on device, Synced, or Needs attention, plus pending operation count and last successful sync time.

1. In one local IndexedDB transaction, save the record and its outbox operation.
2. Give each operation a UUID, type, payload, expected version, and dependency IDs.
3. Authenticate and upload in dependency order.
4. Server validates membership, business rules, and expected versions.
5. Server applies an operation and stores its result atomically. Repeating the same operation ID returns the original result; a different payload for that ID is rejected.
6. Download authoritative changes and deletion markers using a server-issued cursor.
7. Apply downloaded changes without silently overwriting pending local edits.
8. Keep rejected operations visible with a resolution action. Retry transient failures with backoff.

Supporting storage:
- Server processed_operations: shop_id, operation_id, actor_id, payload fingerprint, result; unique shop/operation pair.
- Server change_log: shop_id, record type/id, version, operation, and a safe cursor.
- Local outbox: operation payload, dependencies, expected version, retry count, and state.
- Local sync_state: last committed cursor and last successful sync time.

The change cursor must not skip concurrent commits. A raw increasing sequence can commit out of order. For this small shop, serialize changes per shop with a transaction lock and allocate cursor values while holding it; require every relevant write path to follow that protocol. Advance the local cursor only after successfully applying the downloaded batch.

| Situation | Behaviour |
| --- | --- |
| Same customer edited on two devices | Version mismatch produces a reviewable conflict |
| Same unit sold by two offline devices | First valid server confirmation succeeds; other attempt needs resolution |
| Connection drops after successful server commit | Retry returns the existing result without duplicating sale or stock movement |
| Cached stock becomes stale | Show last-sync time and pending status |
| Offline sale | Provisional reference; final number only after server confirmation |
| Storage cleared before upload | Unsynced work may be lost; make pending changes prominent |

Browser storage is not a backup. Request persistent storage where supported and set up tested central database backups before live use. Do not automatically discard an outbox during an app update.

## UPS AMC reminders

Start with an in-app Due soon / Overdue list.

A daily server job creates deduplicated reminders from synced visits and contract renewal dates, evaluated in Asia/Kolkata. Completing a visit resolves its outstanding service reminder. Offline changes affect the server schedule after sync.

External SMS, WhatsApp, email, and push delivery are later work. An in-app reminder does not promise a notification while the application is closed.

## First five coding tasks

- [ ] **1. Create the application shell.**
  Set up React, TypeScript, Vite, PWA assets, five feature navigation pages, configuration placeholders, and development instructions.
  Acceptance: responsive phone/desktop layout; shell opens offline after initial online load.

- [ ] **2. Add login and shop access controls.**
  Create shops and shop_members migrations, managed login, owner/staff roles, and security policies.
  Acceptance: anonymous access is denied; a user cannot read or mutate another shop; staff cannot grant themselves owner access.

- [ ] **3. Implement customers as the first offline sync slice.**
  Add customer create/list/edit, local database, outbox, idempotent server operation, and download cursor.
  Acceptance: create offline, restart, reconnect, and see exactly one customer on the second device; stale edits produce a conflict.

- [ ] **4. Implement products and stock receipts.**
  Add products, serialised stock units, append-only receipt movements, and synced inventory views.
  Acceptance: receive two units and see them on both devices; duplicate serials and repeated receipt operations do not inflate stock.

- [ ] **5. Implement a one-item sale and warranty.**
  Add sale confirmation as one server transaction, stock availability checks, final sale numbering, and warranty snapshots.
  Acceptance: retries produce one sale; concurrent attempts cannot both confirm the same unit; a failed transaction leaves no partial sale or stock deduction.

After task 5, extend sales to multiple items, then implement equipment, AMC contracts, explicit visits, and reminders using the established sync foundation.

## Technical references

- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)
- [PWA offline and background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
