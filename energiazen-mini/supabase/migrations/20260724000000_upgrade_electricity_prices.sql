-- Säilytä vanhat start_date/end_date/price-sarakkeet, koska tuotantotaulu ja
-- nykyiset rivit käyttävät niitä. Uudet sarakkeet backfillataan ennen NOT NULL
-- -rajoitteita, joten migraatio ei hävitä olemassa olevaa hintahistoriaa.
alter table public.electricity_prices
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists spot_price_cents_kwh numeric(10, 4),
  add column if not exists resolution_minutes integer,
  add column if not exists region text,
  add column if not exists fetched_at timestamptz,
  add column if not exists price_date date;

update public.electricity_prices
set
  starts_at = coalesce(starts_at, start_date),
  ends_at = coalesce(ends_at, end_date),
  spot_price_cents_kwh = coalesce(spot_price_cents_kwh, price),
  resolution_minutes = coalesce(
    resolution_minutes,
    round(extract(epoch from (end_date - start_date)) / 60)::integer,
    60
  ),
  region = coalesce(region, 'FI'),
  fetched_at = coalesce(fetched_at, now()),
  price_date = coalesce(
    price_date,
    (coalesce(starts_at, start_date) at time zone 'Europe/Helsinki')::date
  );

alter table public.electricity_prices
  alter column starts_at set not null,
  alter column ends_at set not null,
  alter column spot_price_cents_kwh set not null,
  alter column resolution_minutes set not null,
  alter column region set default 'FI',
  alter column region set not null,
  alter column fetched_at set default now(),
  alter column fetched_at set not null,
  alter column price_date set not null;

alter table public.electricity_prices
  drop constraint if exists electricity_prices_resolution_supported;
alter table public.electricity_prices
  add constraint electricity_prices_resolution_supported
  check (resolution_minutes in (15, 60));

-- Vanha uniikkiavain estäisi 15 minuutin hinnan tallentamisen tasatunnilta,
-- jos samalta alkuhetkeltä on jo 60 minuutin rivi.
alter table public.electricity_prices
  drop constraint if exists electricity_prices_one_price_per_hour;

create unique index if not exists electricity_prices_region_start_resolution_uidx
  on public.electricity_prices (region, starts_at, resolution_minutes);
create index if not exists electricity_prices_region_starts_at_idx
  on public.electricity_prices (region, starts_at desc);

drop policy if exists "Authenticated users can insert electricity prices"
  on public.electricity_prices;
create policy "Authenticated users can insert electricity prices"
  on public.electricity_prices for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update electricity prices"
  on public.electricity_prices;
create policy "Authenticated users can update electricity prices"
  on public.electricity_prices for update to authenticated
  using (true) with check (true);

comment on table public.electricity_prices is
  'Price history grows only when the app fetches prices; no scheduled background fetch exists yet.';
