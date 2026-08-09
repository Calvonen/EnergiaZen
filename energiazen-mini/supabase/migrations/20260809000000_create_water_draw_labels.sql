create table public.water_draw_labels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  event_started_at timestamptz not null,
  event_ended_at timestamptz not null,
  label text not null check (label in (
    'normal_shower', 'long_hot_shower', 'small_wash',
    'large_other_use', 'multiple_showers', 'unknown'
  )),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint water_draw_labels_event_order check (event_ended_at >= event_started_at),
  constraint water_draw_labels_user_event_unique unique (user_id, event_started_at, event_ended_at)
);

create index water_draw_labels_user_recent_idx
  on public.water_draw_labels (user_id, event_started_at desc);

create or replace function public.set_water_draw_label_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_water_draw_labels_updated_at
before update on public.water_draw_labels
for each row execute function public.set_water_draw_label_updated_at();

alter table public.water_draw_labels enable row level security;

create policy "Users can read their water draw labels"
  on public.water_draw_labels for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can insert their water draw labels"
  on public.water_draw_labels for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users can update their water draw labels"
  on public.water_draw_labels for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete their water draw labels"
  on public.water_draw_labels for delete to authenticated
  using ((select auth.uid()) = user_id);
