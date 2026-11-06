export type Customer = { id: string; name: string; phone: string; address: string; version?: number };
export type Product = { id: string; sku: string; brand: string; model: string; category: string; ah: number; price: number };
export type Unit = { id: string; product_id: string; serial: string; received: string };
export type Sale = { id: string; customer_id: string; unit_id: string; price: number; date: string; number: string; product_name: string };
export type Warranty = { id: string; sale_id: string; start: string; free_end: string; prorated_end: string; terms: string };
export type Contract = { id: string; customer_id: string; equipment: string; start: string; end: string; amount: number };
export type Visit = { id: string; contract_id: string; due: string; completed: string | null };
export type Snapshot = { customers: Customer[]; products: Product[]; units: Unit[]; sales: Sale[]; warranties: Warranty[]; contracts: Contract[]; visits: Visit[]; revision: number };
export type Role = 'owner' | 'staff';
export type Command = { id: string } & (
  { type: 'customer.add'; data: Customer } |
  { type: 'customer.update'; data: Customer & { expected_version: number } } |
  { type: 'product.add'; data: Product } |
  { type: 'unit.receive'; data: Unit } |
  { type: 'sale.create'; data: Omit<Sale, 'number' | 'product_name'> & { free_end: string; prorated_end: string; terms: string } } |
  { type: 'amc.create'; data: Contract & { visits: { id: string; due: string }[] } } |
  { type: 'visit.complete'; data: { id: string; completed: string } }
);
export const empty = (): Snapshot => ({ customers: [], products: [], units: [], sales: [], warranties: [], contracts: [], visits: [], revision: 0 });
export const uid = () => crypto.randomUUID();
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
export function paise(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Enter a non-negative amount with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  check(Number.isSafeInteger(n) && n <= 1_000_000_000, 'Amount is too large.');
  return n;
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function date(value: string) { check(/^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Enter a valid date.'); }
function amount(value: number) { check(Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000, 'Invalid amount.'); }
export function available(s: Snapshot, id: string) { return !s.sales.some(sale => sale.unit_id === id); }
/** Pure optimistic validation. The server independently enforces all write rules. */
export function apply(s: Snapshot, op: Command, role: Role = 'owner'): Snapshot {
  const n = structuredClone(s);
  const d = op.data;
  if (op.type === 'product.add' || op.type === 'unit.receive') check(role === 'owner', 'Only the owner can change inventory.');
  switch (op.type) {
    case 'customer.add': {
      const d = op.data;
      if (n.customers.some(x => x.id === d.id)) return n;
      check(d.name.trim() && d.phone.trim(), 'Customer name and phone are required.');
      n.customers.push(d); break;
    }
    case 'customer.update': {
      const d = op.data; const i = n.customers.findIndex(x => x.id === d.id);
      check(i >= 0, 'Customer not found.');
      if (n.customers[i].version === d.expected_version + 1 && n.customers[i].name === d.name && n.customers[i].phone === d.phone && n.customers[i].address === d.address) return n;
      check((n.customers[i].version ?? 1) === d.expected_version, 'Customer changed on another device. Discard this change and edit the latest record.');
      check(d.name.trim() && d.phone.trim(), 'Customer name and phone are required.');
      n.customers[i] = { id: d.id, name: d.name, phone: d.phone, address: d.address, version: d.expected_version + 1 }; break;
    }
    case 'product.add': {
      const d = op.data;
      if (n.products.some(x => x.id === d.id)) return n;
      check(d.sku.trim() && d.brand.trim() && d.model.trim(), 'SKU, brand and model are required.');
      check(!n.products.some(x => x.sku.toLowerCase() === d.sku.toLowerCase()), 'This SKU already exists.');
      check(Number.isFinite(d.ah) && d.ah >= 0, 'Invalid Ah capacity.'); amount(d.price);
      n.products.push(d); break;
    }
    case 'unit.receive': {
      const d = op.data;
      if (n.units.some(x => x.id === d.id)) return n;
      check(n.products.some(x => x.id === d.product_id), 'Choose an existing product.');
      check(d.serial.trim(), 'Serial number is required.'); date(d.received);
      check(!n.units.some(x => x.product_id === d.product_id && x.serial.toLowerCase() === d.serial.toLowerCase()), 'This serial number already exists for this product.');
      n.units.push(d); break;
    }
    case 'sale.create': {
      const d = op.data;
      if (n.sales.some(x => x.id === d.id)) return n;
      check(n.customers.some(x => x.id === d.customer_id), 'Choose an existing customer.');
      const unit = n.units.find(x => x.id === d.unit_id);
      check(unit && available(n, unit.id), 'This battery or UPS is no longer available.');
      amount(d.price); date(d.date); date(d.free_end); date(d.prorated_end);
      check(d.free_end >= d.date && d.prorated_end >= d.free_end, 'Warranty end dates must follow the sale date and free-replacement period.');
      const product = n.products.find(x => x.id === unit.product_id)!;
      n.sales.push({ id: d.id, customer_id: d.customer_id, unit_id: d.unit_id, price: d.price, date: d.date, number: `PENDING-${d.id.slice(0, 8)}`, product_name: `${product.brand} ${product.model}` });
      n.warranties.push({ id: d.id, sale_id: d.id, start: d.date, free_end: d.free_end, prorated_end: d.prorated_end, terms: d.terms }); break;
    }
    case 'amc.create': {
      const d = op.data;
      if (n.contracts.some(x => x.id === d.id)) return n;
      check(n.customers.some(x => x.id === d.customer_id), 'Choose an existing customer.');
      check(d.equipment.trim(), 'Describe the installed UPS and batteries.'); date(d.start); date(d.end); amount(d.amount);
      check(d.end >= d.start, 'AMC end date must follow its start date.');
      check(d.visits.length > 0 && new Set(d.visits.map(v => v.id)).size === d.visits.length, 'Add valid service visits.');
      for (const v of d.visits) { date(v.due); check(v.due >= d.start && v.due <= d.end, 'Visit dates must fall inside the AMC period.'); }
      const { visits, ...contract } = d;
      n.contracts.push(contract);
      n.visits.push(...visits.map(v => ({ ...v, contract_id: d.id, completed: null }))); break;
    }
    case 'visit.complete': {
      const v = n.visits.find(x => x.id === d.id);
      check(v, 'Visit not found.'); date(op.data.completed);
      if (!v.completed) v.completed = op.data.completed;
      break;
    }
  }
  return n;
}
export function dueStatus(due: string, completed: string | null, now = today()) {
  if (completed) return 'Completed';
  if (due < now) return 'Overdue';
  const days = (Date.parse(due) - Date.parse(now)) / 86400000;
  return days <= 7 ? 'Due soon' : 'Scheduled';
}
