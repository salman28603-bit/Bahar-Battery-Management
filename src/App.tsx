import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { liveQuery } from 'dexie';
import { available, dueStatus, money, paise, today, uid, type Command, type Customer } from './domain';
import { db, enqueue, newCache, project, type Cache } from './store';
import { cloud, configured, shopId, sync } from './cloud';

const tabs = ['Overview', 'Customers', 'Inventory', 'Sales', 'Warranties', 'AMC'] as const;
type Tab = typeof tabs[number];
function Field({ label, name, type = 'text', value, required = true, min, step }: { label: string; name: string; type?: string; value?: string; required?: boolean; min?: string; step?: string }) {
  return <label>{label}<input name={name} type={type} defaultValue={value} required={required} min={min} step={step} /></label>;
}
function Select({ label, name, children }: { label: string; name: string; children: ReactNode }) { return <label>{label}<select name={name} required defaultValue=""><option value="" disabled>Choose…</option>{children}</select></label>; }
function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className="panel"><h2>{title}</h2>{children}</section>; }
function Table({ heads, rows, emptyText = 'No records yet. Add your first record to get started.' }: { heads: string[]; rows: ReactNode[][]; emptyText?: string }) {
  return rows.length ? <div className="table-wrap"><table><thead><tr>{heads.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div> : <div className="empty">{emptyText}</div>;
}
export default function App() {
  const [user, setUser] = useState<string | null>(null);
  const [ready, setReady] = useState(!configured);
  const [cache, setCache] = useState<Cache>(newCache('local'));
  const [tab, setTab] = useState<Tab>('Overview');
  const [editing, setEditing] = useState<Customer | null>(null);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [clock, setClock] = useState(Date.now());
  const local = !configured;
  const key = local ? 'local' : `${shopId}:${user}`;
  const activeCache = cache.key === key ? cache : newCache(key);
  const { view: s, issues } = project(activeCache);
  const leaseExpired = !local && (!activeCache.leaseUntil || activeCache.leaseUntil < clock);
  const owner = local || activeCache.role === 'owner';
  const customer = (id: string) => s.customers.find(c => c.id === id)?.name || 'Unknown customer';
  const product = (id: string) => { const p = s.products.find(p => p.id === id); return p ? `${p.brand} ${p.model}` : 'Unknown product'; };
  const matches = (...parts: unknown[]) => parts.join(' ').toLowerCase().includes(search.toLowerCase());
  useEffect(() => {
    if (!cloud) return;
    cloud.auth.getSession().then(({ data, error }) => { setUser(data.session?.user.id ?? null); if (error) setError(error.message); setReady(true); });
    const { data } = cloud.auth.onAuthStateChange((_event, session) => { setUser(session?.user.id ?? null); setReady(true); });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!local && !user) return;
    const sub = liveQuery(() => db.caches.get(key)).subscribe({ next: c => setCache(c ?? newCache(key)), error: e => setError(`Device storage failed: ${e}`) });
    return () => sub.unsubscribe();
  }, [key, local, user]);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(timer); };
  }, []);
  async function runSync() {
    if (!user || !online || !cloud) return;
    setBusy(true);
    try { await sync(key); setError(''); } catch (e) { setError(`Sync: ${(e as Error).message || 'Connection failed. Pending work is saved.'}`); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!user || !online || !cloud) return;
    void runSync();
    const timer = setInterval(() => { void runSync(); }, 30_000);
    return () => clearInterval(timer);
    // All values used by the sync target are represented here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, online, key]);
  async function save(e: FormEvent<HTMLFormElement>, make: (f: FormData) => Command) {
    e.preventDefault(); const form = e.currentTarget;
    setError(''); setMessage('');
    try {
      await enqueue(key, make(new FormData(form)), local);
      form.reset(); setEditing(null); setMessage(local ? 'Saved on this device.' : 'Saved on device. Waiting for server confirmation.');
      if (navigator.storage?.persist) void navigator.storage.persist();
      void runSync();
    } catch (err) { setError((err as Error).message); }
  }
  function exportData() {
    const blob = new Blob([JSON.stringify(activeCache, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `bahar-backup-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function signOut() {
    if (activeCache.pending.length) { setError('Sync or resolve pending work before signing out.'); return; }
    try { const { error } = await cloud!.auth.signOut({ scope: 'local' }); if (error) throw error; await db.caches.delete(key); setCache(newCache('signed-out')); setTab('Overview'); } catch (e) { setError((e as Error).message); }
  }
  const text = (f: FormData, name: string) => String(f.get(name) || '').trim();
  const options = s.customers.map(c => <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>);
  if (!ready) return <main className="login"><h1>Opening Bahar…</h1></main>;
  if (!local && !user) return <main className="login"><img src="/icon.svg" alt="" width="64"/><p className="eyebrow">BAHAR BATTERY SALES AND SERVICE</p><h1>Your shop.<br/>All in one place.</h1><p>Sign in with the account your shop owner created.</p><form onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(''); try { const { error } = await cloud!.auth.signInWithPassword({ email: text(f, 'email'), password: String(f.get('password')) }); if (error) throw error; } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Field label="Email" name="email" type="email"/><Field label="Password" name="password" type="password"/><button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form>{error && <p role="alert" className="error">{error}</p>}</main>;
  const due = s.visits.filter(v => !v.completed && dueStatus(v.due, null) !== 'Scheduled');
  return <div className="layout"><aside><a className="brand" href="#" onClick={() => setTab('Overview')}><img src="/icon.svg" alt=""/><span>BAHAR<small>BATTERY SALES & SERVICE</small></span></a><p className="nav-label">SHOP WORKSPACE</p><nav aria-label="Main navigation">{tabs.map((t, i) => <button className={tab === t ? 'active' : ''} key={t} onClick={() => { setTab(t); setSearch(''); setMessage(''); }}><span className="nav-icon" aria-hidden="true">{['◈', '◉', '▤', '↗', '◇', '▦'][i]}</span>{t}{t === 'AMC' && due.length > 0 && <b className="count" aria-hidden="true">{due.length}</b>}</button>)}</nav><div className="aside-bottom"><span className="dot"/> {online ? 'Device online' : 'Working offline'}<small>{local ? 'Local workspace' : `${activeCache.role} account`}</small></div></aside>
    <main><header><div><p className="eyebrow">BAHAR · SHOP MANAGER</p><h1>{tab === 'Overview' ? 'A clearer view of your shop.' : tab}</h1></div><span className="date">{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date())}</span></header>
      <div className="statusbar"><div><strong>{local ? 'Single-device workspace' : `${activeCache.pending.length} pending · ${issues.length ? 'Needs attention' : activeCache.pending.length ? 'Saved on device' : activeCache.lastSync ? 'Synced' : 'Not synced yet'}`}</strong><small>{local ? 'Data stays in this browser. Configure Supabase to connect your phone and computer.' : `Last sync: ${activeCache.lastSync ? new Date(activeCache.lastSync).toLocaleString('en-IN') : 'Never'}`}</small></div><div className="actions">{!local && <button className="secondary" onClick={() => void runSync()} disabled={busy || !online}>{busy ? 'Syncing…' : 'Sync now'}</button>}<button className="secondary" onClick={exportData}>Export backup</button>{!local && <button className="secondary" onClick={() => void signOut()}>Sign out</button>}</div></div>
      {error && <div className="error" role="alert">{error}</div>}{message && <div className="success" role="status">{message}</div>}
      {leaseExpired && <div className="error">Reconnect and sync to enable changes. Offline access lasts 24 hours after a successful sync.</div>}
      {activeCache.pending.some(x => x.error) && <Panel title="Resolve pending work">{activeCache.pending.filter(x => x.error).map(item => <div key={item.op.id} className="conflict"><p><strong>{item.op.type}</strong> · {item.error}</p><button className="secondary" onClick={async () => { if (!confirm('Discard this rejected change? Related queued changes may also need review. Export a backup first if needed.')) return; await db.transaction('rw', db.caches, async () => { const c = (await db.caches.get(key))!; c.pending = c.pending.filter(x => x.op.id !== item.op.id); await db.caches.put(c); }); void runSync(); }}>Discard rejected change</button></div>)}</Panel>}
      {issues.length > 0 && <p className="error">{issues.join(' · ')}</p>}
      {tab === 'Overview' ? <><div className="metrics">{[['Available units', s.units.filter(u => available(s, u.id)).length, 'Ready in inventory'], ['Customers', s.customers.length, 'Relationships to build'], ['Recorded sales', money(s.sales.reduce((a, x) => a + x.price, 0)), 'All time · includes pending'], ['Service attention', due.length, 'Overdue or due in 7 days']].map(([label, value, note]) => <section className="metric" key={String(label)}><p>{label}</p><strong>{value}</strong><small>{note}</small></section>)}</div><div className="hero"><div><p className="eyebrow">KEEP YOUR SHOP MOVING</p><h2>Every battery.<br/>Every customer. One place.</h2><p>Start with a customer and product, receive a serialised unit,<br className="desktop"/> then record its sale and warranty.</p><button onClick={() => setTab('Customers')}>Add your first customer <span>↗</span></button></div><img src="/icon.svg" alt="Bahar battery symbol"/></div><Panel title="Upcoming service visits"><Table heads={['Customer', 'Equipment', 'Due date', 'Status']} rows={due.map(v => { const c = s.contracts.find(c => c.id === v.contract_id)!; return [customer(c.customer_id), c.equipment, v.due, <span className="badge">{dueStatus(v.due, v.completed)}</span>]; })} emptyText="No service visits need attention. Your upcoming visits will appear here."/></Panel></> : <>
      <div className="toolbar"><p>{({ Customers: 'Customer contact details', Inventory: 'Products and serialised stock', Sales: 'One unit per sale · automatic warranty record', Warranties: 'Coverage recorded at the time of sale', AMC: 'UPS contracts, visits and renewal dates' } as Partial<Record<Tab, string>>)[tab]}</p><input aria-label="Search records" placeholder="Search records…" value={search} onChange={e => setSearch(e.target.value)}/></div>
      <fieldset disabled={leaseExpired} className="workspace">
      {tab === 'Customers' && <><Panel title={editing ? 'Edit customer' : 'Add customer'}><form key={editing?.id ?? 'new'} onSubmit={e => save(e, f => editing ? ({ id: uid(), type: 'customer.update', data: { id: editing.id, name: text(f, 'name'), phone: text(f, 'phone'), address: text(f, 'address'), expected_version: editing.version ?? 1 } }) : ({ id: uid(), type: 'customer.add', data: { id: uid(), name: text(f, 'name'), phone: text(f, 'phone'), address: text(f, 'address') } }))}><Field label="Customer name" name="name" value={editing?.name}/><Field label="Phone" name="phone" type="tel" value={editing?.phone}/><Field label="Address" name="address" required={false} value={editing?.address}/><button>{editing ? 'Save changes' : 'Save customer'}</button>{editing && <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel edit</button>}</form></Panel><Panel title={`Customer directory · ${s.customers.length}`}><Table heads={['Name', 'Phone', 'Address', 'Action']} rows={s.customers.filter(c => matches(c.name, c.phone, c.address)).map(c => [c.name, c.phone, c.address || '—', <button className="secondary" onClick={() => setEditing(c)}>Edit customer</button>])}/></Panel></>}
      {tab === 'Inventory' && <>{owner && <div className="two-columns"><Panel title="Add product"><form onSubmit={e => save(e, f => ({ id: uid(), type: 'product.add', data: { id: uid(), sku: text(f, 'sku'), brand: text(f, 'brand'), model: text(f, 'model'), category: text(f, 'category'), ah: Number(text(f, 'ah')), price: paise(text(f, 'price')) } }))}><Field label="SKU / product code" name="sku"/><Field label="Brand" name="brand"/><Field label="Model" name="model"/><Select label="Category" name="category"><option>Battery</option><option>UPS</option><option>Inverter</option></Select><Field label="Capacity (Ah, 0 if not applicable)" name="ah" type="number" min="0" step="0.1" value="0"/><Field label="Default price (₹)" name="price" type="number" min="0" step="0.01"/><button>Save product</button></form></Panel><Panel title="Receive stock"><form onSubmit={e => save(e, f => ({ id: uid(), type: 'unit.receive', data: { id: uid(), product_id: text(f, 'product_id'), serial: text(f, 'serial'), received: text(f, 'received') } }))}><Select label="Product" name="product_id">{s.products.map(p => <option key={p.id} value={p.id}>{p.sku} · {p.brand} {p.model}</option>)}</Select><Field label="Serial number" name="serial"/><Field label="Received date" name="received" type="date" value={today()}/><button>Receive unit</button></form><p className="hint">Each physical battery or UPS gets its own serial-number record.</p></Panel></div>}<Panel title="Stock register"><Table heads={['Product', 'Serial number', 'Received', 'Status']} rows={s.units.filter(u => matches(product(u.product_id), u.serial)).map(u => [product(u.product_id), u.serial, u.received, <span className={`badge ${available(s, u.id) ? 'green' : ''}`}>{available(s, u.id) ? 'Available' : 'Sold / pending'}</span>])}/></Panel><Panel title="Product catalogue"><Table heads={['SKU', 'Product', 'Category', 'Ah', 'Default price']} rows={s.products.filter(p => matches(p.sku, p.brand, p.model)).map(p => [p.sku, `${p.brand} ${p.model}`, p.category, p.ah || '—', money(p.price)])}/></Panel></>}
      {tab === 'Sales' && <><Panel title="Record sale"><form onSubmit={e => save(e, f => ({ id: uid(), type: 'sale.create', data: { id: uid(), customer_id: text(f, 'customer_id'), unit_id: text(f, 'unit_id'), price: paise(text(f, 'price')), date: text(f, 'date'), free_end: text(f, 'free_end'), prorated_end: text(f, 'prorated_end'), terms: text(f, 'terms') } }))}><Select label="Customer" name="customer_id">{options}</Select><Select label="Available unit" name="unit_id">{s.units.filter(u => available(s, u.id)).map(u => <option key={u.id} value={u.id}>{product(u.product_id)} · {u.serial}</option>)}</Select><Field label="Agreed sale price (₹)" name="price" type="number" min="0" step="0.01"/><Field label="Sale date" name="date" type="date" value={today()}/><Field label="Free-replacement end date" name="free_end" type="date"/><Field label="Prorated coverage end date" name="prorated_end" type="date"/><Field label="Warranty terms / reference" name="terms"/><button>Save sale & warranty</button></form><p className="hint">Enter dates from the manufacturer’s actual terms. Use the same end date if there is no prorated period. Offline sales remain provisional until synced.</p></Panel><Panel title="Sale history"><Table heads={['Reference', 'Customer', 'Product', 'Date', 'Amount']} rows={s.sales.filter(x => matches(x.number, customer(x.customer_id), x.product_name)).map(x => [x.number, customer(x.customer_id), x.product_name, x.date, money(x.price)])}/></Panel></>}
      {tab === 'Warranties' && <Panel title="Warranty register"><Table heads={['Customer / serial', 'Product', 'Free replacement until', 'Prorated until', 'Coverage today', 'Terms']} rows={s.warranties.filter(w => { const sale = s.sales.find(x => x.id === w.sale_id)!; return matches(customer(sale.customer_id), s.units.find(u => u.id === sale.unit_id)?.serial, sale.product_name); }).map(w => { const sale = s.sales.find(x => x.id === w.sale_id)!; return [<>{customer(sale.customer_id)}<small>{s.units.find(u => u.id === sale.unit_id)?.serial}</small></>, sale.product_name, w.free_end, w.prorated_end, today() < w.start ? 'Not started' : today() <= w.free_end ? 'Free replacement' : today() <= w.prorated_end ? 'Prorated' : 'Expired', w.terms]; })}/></Panel>}
      {tab === 'AMC' && <><Panel title="New UPS AMC"><form onSubmit={e => save(e, f => ({ id: uid(), type: 'amc.create', data: { id: uid(), customer_id: text(f, 'customer_id'), equipment: text(f, 'equipment'), start: text(f, 'start'), end: text(f, 'end'), amount: paise(text(f, 'amount')), visits: [{ id: uid(), due: text(f, 'visit1') }, { id: uid(), due: text(f, 'visit2') }] } }))}><Select label="Customer" name="customer_id">{options}</Select><Field label="Equipment, serials and installation location" name="equipment"/><Field label="Contract start" name="start" type="date" value={today()}/><Field label="Contract end" name="end" type="date"/><Field label="AMC value (₹)" name="amount" type="number" min="0" step="0.01"/><Field label="First visit due" name="visit1" type="date"/><Field label="Second visit due" name="visit2" type="date"/><button>Save AMC</button></form></Panel><Panel title="Service visits"><Table heads={['Customer', 'Equipment', 'Visit due', 'Status', 'Action']} rows={s.visits.filter(v => { const c = s.contracts.find(c => c.id === v.contract_id)!; return matches(customer(c.customer_id), c.equipment); }).sort((a, b) => a.due.localeCompare(b.due)).map(v => { const c = s.contracts.find(c => c.id === v.contract_id)!; return [customer(c.customer_id), c.equipment, v.due, <span className="badge">{dueStatus(v.due, v.completed)}</span>, v.completed ? `Completed ${v.completed}` : <button className="secondary" onClick={async () => { try { await enqueue(key, { id: uid(), type: 'visit.complete', data: { id: v.id, completed: today() } }, local); void runSync(); } catch (e) { setError((e as Error).message); } }}>Mark completed</button>]; })}/></Panel><Panel title="Contracts & renewals"><Table heads={['Customer', 'Equipment', 'Period', 'Value', 'Renewal']} rows={s.contracts.filter(c => matches(customer(c.customer_id), c.equipment)).map(c => [customer(c.customer_id), c.equipment, `${c.start} → ${c.end}`, money(c.amount), <span className="badge">{dueStatus(c.end, null)}</span>])}/></Panel><p className="hint">Reminders appear here when you open the app. This version does not send SMS, WhatsApp or background push notifications.</p></>}
      </fieldset></>}
      <footer>Bahar Battery Sales and Service <span>Built for the everyday work of your shop.</span></footer>
    </main></div>;
}
