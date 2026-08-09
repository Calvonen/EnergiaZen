alter table public.water_draw_labels
  add column detection_kinds text[],
  add column duration_minutes double precision,
  add column estimated_water_draw_net_energy_kwh double precision;

alter table public.water_draw_labels
  add constraint water_draw_labels_detection_kinds_valid check (
    detection_kinds is null or (
      cardinality(detection_kinds) > 0
      and detection_kinds <@ array['rapid_drop', 'cold_inlet']::text[]
    )
  ),
  add constraint water_draw_labels_duration_nonnegative check (
    duration_minutes is null or duration_minutes >= 0
  );

-- A snapshot is written when a label is first created. Existing rows may be
-- populated once on their next edit; after that the model facts are immutable.
create or replace function public.preserve_water_draw_label_event_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.event_started_at = old.event_started_at;
  new.event_ended_at = old.event_ended_at;
  if old.detection_kinds is not null then
    new.detection_kinds = old.detection_kinds;
    new.duration_minutes = old.duration_minutes;
    new.estimated_water_draw_net_energy_kwh = old.estimated_water_draw_net_energy_kwh;
  end if;
  return new;
end;
$$;

create trigger preserve_water_draw_labels_event_snapshot
before update on public.water_draw_labels
for each row execute function public.preserve_water_draw_label_event_snapshot();
