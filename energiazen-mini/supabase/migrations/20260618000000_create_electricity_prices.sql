create table if not exists public.electricity_prices (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'FI',
  price_date date not null,
  start_date timestamptz not null,
  end_date timestamptz not null,
  price_no_tax numeric(10, 4),
  price_with_tax numeric(10, 4) not null,
  source text not null default 'spot-hinta.fi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint electricity_prices_time_order check (end_date > start_date),
  constraint electricity_prices_one_price_per_hour unique (region, start_date)
);

create index if not exists electricity_prices_region_price_date_idx
  on public.electricity_prices (region, price_date, start_date);

alter table public.electricity_prices enable row level security;

create policy "Authenticated users can read electricity prices"
  on public.electricity_prices
  for select
  to authenticated
  using (true);
