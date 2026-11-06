-- Run once in a new Supabase project. All writes go through shop_sync.
create table public.shops (
 id uuid primary key default gen_random_uuid(), name text not null,
 revision bigint not null default 0, next_sale bigint not null default 1
);
create table public.shop_members (
 shop_id uuid references public.shops(id), user_id uuid references auth.users(id),
 role text not null check (role in ('owner','staff')), active boolean not null default true,
 primary key(shop_id,user_id)
);
create table public.customers (
 id uuid primary key, shop_id uuid not null references public.shops(id),
 name text not null check(length(trim(name)) > 0), phone text not null check(length(trim(phone)) > 0), address text not null default '', version integer not null default 1,
 unique(shop_id,id)
);
create table public.products (
 id uuid primary key, shop_id uuid not null references public.shops(id),
 sku text not null check(length(trim(sku)) > 0), brand text not null check(length(trim(brand)) > 0), model text not null check(length(trim(model)) > 0),
 category text not null, ah numeric not null check(ah >= 0), price bigint not null check(price between 0 and 1000000000), unique(shop_id,id)
);
create unique index product_sku on public.products(shop_id,lower(sku));
create table public.units (
 id uuid primary key, shop_id uuid not null references public.shops(id), product_id uuid not null,
 serial text not null check(length(trim(serial)) > 0), received date not null,
 unique(shop_id,id), foreign key(shop_id,product_id) references public.products(shop_id,id)
);
create unique index unit_serial on public.units(shop_id,product_id,lower(serial));
create table public.sales (
 id uuid primary key, shop_id uuid not null references public.shops(id), customer_id uuid not null, unit_id uuid not null,
 price bigint not null check(price between 0 and 1000000000), date date not null, number text not null, product_name text not null,
 unique(shop_id,id), unique(shop_id,unit_id), unique(shop_id,number),
 foreign key(shop_id,customer_id) references public.customers(shop_id,id),
 foreign key(shop_id,unit_id) references public.units(shop_id,id)
);
create table public.warranties (
 id uuid primary key, shop_id uuid not null references public.shops(id), sale_id uuid not null,
 start date not null, free_end date not null, prorated_end date not null, terms text not null default '',
 check(free_end >= start and prorated_end >= free_end), unique(shop_id,sale_id),
 foreign key(shop_id,sale_id) references public.sales(shop_id,id)
);
create table public.contracts (
 id uuid primary key, shop_id uuid not null references public.shops(id), customer_id uuid not null,
 equipment text not null check(length(trim(equipment)) > 0), start date not null, "end" date not null,
 amount bigint not null check(amount between 0 and 1000000000), check("end" >= start), unique(shop_id,id),
 foreign key(shop_id,customer_id) references public.customers(shop_id,id)
);
create table public.visits (
 id uuid primary key, shop_id uuid not null references public.shops(id), contract_id uuid not null,
 due date not null, completed date,
 foreign key(shop_id,contract_id) references public.contracts(shop_id,id)
);
create table public.stock_movements (
 id uuid primary key default gen_random_uuid(), shop_id uuid not null references public.shops(id), unit_id uuid not null,
 kind text not null check(kind in ('receipt','sale')), sale_id uuid, created_at timestamptz not null default now(), created_by uuid not null references auth.users(id),
 foreign key(shop_id,unit_id) references public.units(shop_id,id), foreign key(shop_id,sale_id) references public.sales(shop_id,id)
);
create table public.processed_operations (
 shop_id uuid not null references public.shops(id), operation_id uuid not null, actor_id uuid not null references auth.users(id),
 payload jsonb not null, created_at timestamptz not null default now(), primary key(shop_id,operation_id)
);

create function public.my_shop_role(p_shop uuid) returns text
language sql stable security definer set search_path = '' as $$
 select role from public.shop_members where shop_id = p_shop and user_id = auth.uid() and active;
$$;
revoke all on function public.my_shop_role(uuid) from public;
grant execute on function public.my_shop_role(uuid) to authenticated;

alter table public.shops enable row level security;
create policy shop_read on public.shops for select to authenticated using(public.my_shop_role(id) is not null);
alter table public.shop_members enable row level security;
create policy member_read on public.shop_members for select to authenticated using(user_id = auth.uid() and active);
-- Read-only access; no client may bypass the transaction function.
do $$ declare t text; begin
 foreach t in array array['customers','products','units','sales','warranties','contracts','visits','stock_movements','processed_operations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy shop_read on public.%I for select to authenticated using (public.my_shop_role(shop_id) is not null)',t);
 end loop;
 foreach t in array array['shops','shop_members','customers','products','units','sales','warranties','contracts','visits','stock_movements','processed_operations'] loop
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

create function public.shop_sync(p_shop uuid, p_op jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 r text; d jsonb; typ text; oid uuid; rid uuid; prior public.processed_operations%rowtype;
 serial_product text; number_value bigint; visit jsonb; snapshot jsonb;
begin
 r := public.my_shop_role(p_shop);
 if r is null then raise exception 'Shop access denied' using errcode = '42501'; end if;
 -- One lock covers every mutation and the full snapshot, including concurrent devices.
 perform 1 from public.shops where id=p_shop for update;
 if p_op is not null then
  oid := (p_op->>'id')::uuid; typ := p_op->>'type'; d := p_op->'data'; rid := (d->>'id')::uuid;
  if oid is null or rid is null or typ is null then raise exception 'Invalid operation'; end if;
  select * into prior from public.processed_operations where shop_id=p_shop and operation_id=oid;
  if found then
   if prior.payload <> p_op or prior.actor_id <> auth.uid() then raise exception 'Operation ID reused with different content or account'; end if;
  else
   if typ in ('product.add','unit.receive') and r <> 'owner' then raise exception 'Only the owner can change inventory'; end if;
   case typ
    when 'customer.add' then
     insert into public.customers(id,shop_id,name,phone,address) values(rid,p_shop,trim(d->>'name'),trim(d->>'phone'),coalesce(d->>'address',''));
    when 'customer.update' then
     update public.customers set name=trim(d->>'name'),phone=trim(d->>'phone'),address=coalesce(d->>'address',''),version=version+1
     where shop_id=p_shop and id=rid and version=(d->>'expected_version')::integer;
     if not found then raise exception 'Customer changed on another device. Discard this change and edit the latest record.'; end if;
    when 'product.add' then
     insert into public.products(id,shop_id,sku,brand,model,category,ah,price)
     values(rid,p_shop,trim(d->>'sku'),trim(d->>'brand'),trim(d->>'model'),d->>'category',(d->>'ah')::numeric,(d->>'price')::bigint);
    when 'unit.receive' then
     insert into public.units(id,shop_id,product_id,serial,received) values(rid,p_shop,(d->>'product_id')::uuid,trim(d->>'serial'),(d->>'received')::date);
     insert into public.stock_movements(shop_id,unit_id,kind,created_by) values(p_shop,rid,'receipt',auth.uid());
    when 'sale.create' then
     if exists(select 1 from public.sales where shop_id=p_shop and unit_id=(d->>'unit_id')::uuid) then raise exception 'This battery or UPS is no longer available'; end if;
     select p.brand || ' ' || p.model into serial_product from public.units u join public.products p on p.id=u.product_id and p.shop_id=u.shop_id where u.id=(d->>'unit_id')::uuid and u.shop_id=p_shop;
     if serial_product is null then raise exception 'Unit not found in this shop'; end if;
     select next_sale into number_value from public.shops where id=p_shop;
     insert into public.sales(id,shop_id,customer_id,unit_id,price,date,number,product_name)
     values(rid,p_shop,(d->>'customer_id')::uuid,(d->>'unit_id')::uuid,(d->>'price')::bigint,(d->>'date')::date,'BHR-' || lpad(number_value::text,6,'0'),serial_product);
     insert into public.warranties(id,shop_id,sale_id,start,free_end,prorated_end,terms)
     values(rid,p_shop,rid,(d->>'date')::date,(d->>'free_end')::date,(d->>'prorated_end')::date,coalesce(d->>'terms',''));
     insert into public.stock_movements(shop_id,unit_id,kind,sale_id,created_by) values(p_shop,(d->>'unit_id')::uuid,'sale',rid,auth.uid());
     update public.shops set next_sale=next_sale+1 where id=p_shop;
    when 'amc.create' then
     if jsonb_typeof(d->'visits') is distinct from 'array' or jsonb_array_length(d->'visits') not between 1 and 24 then raise exception 'Add between 1 and 24 visits'; end if;
     insert into public.contracts(id,shop_id,customer_id,equipment,start,"end",amount)
     values(rid,p_shop,(d->>'customer_id')::uuid,trim(d->>'equipment'),(d->>'start')::date,(d->>'end')::date,(d->>'amount')::bigint);
     for visit in select value from jsonb_array_elements(d->'visits') loop
      if (visit->>'due')::date not between (d->>'start')::date and (d->>'end')::date then raise exception 'Visit dates must fall inside the AMC period'; end if;
      insert into public.visits(id,shop_id,contract_id,due) values((visit->>'id')::uuid,p_shop,rid,(visit->>'due')::date);
     end loop;
    when 'visit.complete' then
     if d->>'completed' is null then raise exception 'Completion date required'; end if;
     update public.visits set completed=coalesce(completed,(d->>'completed')::date) where id=rid and shop_id=p_shop;
     if not found then raise exception 'Visit not found'; end if;
    else raise exception 'Unsupported operation';
   end case;
   insert into public.processed_operations(shop_id,operation_id,actor_id,payload) values(p_shop,oid,auth.uid(),p_op);
   update public.shops set revision=revision+1 where id=p_shop;
  end if;
 end if;
 select jsonb_build_object(
  'revision',(select revision from public.shops where id=p_shop),
  'customers',coalesce((select jsonb_agg(to_jsonb(x)-'shop_id' order by x.name,x.id) from public.customers x where shop_id=p_shop),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(to_jsonb(x)-'shop_id' order by x.sku,x.id) from public.products x where shop_id=p_shop),'[]'::jsonb),
  'units',coalesce((select jsonb_agg(to_jsonb(x)-'shop_id' order by x.received,x.id) from public.units x where shop_id=p_shop),'[]'::jsonb),
  'sales',coalesce((select jsonb_agg(to_jsonb(x)-'shop_id' order by x.number,x.id) from public.sales x where shop_id=p_shop),'[]'::jsonb),
  'warranties',coalesce((select jsonb_agg(to_jsonb(x)-'shop_id' order by x.start,x.id) from public.warranties x where shop_id=p_shop),'[]'::jsonb),
  'contracts',coalesce((select jsonb_agg(to_jsonb(x)-'shop_id' order by x.start,x.id) from public.contracts x where shop_id=p_shop),'[]'::jsonb),
  'visits',coalesce((select jsonb_agg(to_jsonb(x)-'shop_id' order by x.due,x.id) from public.visits x where shop_id=p_shop),'[]'::jsonb)
 ) into snapshot;
 return jsonb_build_object('snapshot',snapshot,'role',r);
end;
$$;
revoke all on function public.shop_sync(uuid,jsonb) from public;
grant execute on function public.shop_sync(uuid,jsonb) to authenticated;
