create table if not exists public.happy_orders (
  id uuid primary key,
  sequence integer not null unique,
  order_number text not null unique,
  status text not null default 'new',
  printed_at timestamptz,
  order_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists happy_orders_created_at_idx
  on public.happy_orders (created_at desc);

create index if not exists happy_orders_status_idx
  on public.happy_orders (status);

create index if not exists happy_orders_printed_at_idx
  on public.happy_orders (printed_at);
