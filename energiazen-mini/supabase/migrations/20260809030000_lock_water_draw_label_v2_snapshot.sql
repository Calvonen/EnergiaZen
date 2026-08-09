-- A legacy snapshot may be promoted to v2 exactly once. Updates that do not
-- explicitly promote it cannot mutate the v2 feature columns. Once promoted,
-- every model-derived value remains immutable while label and note stay editable.
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

  if old.feature_snapshot_version = 2 then
    new.energy_before_kwh = old.energy_before_kwh;
    new.energy_after_stabilization_kwh = old.energy_after_stabilization_kwh;
    new.raw_energy_change_kwh = old.raw_energy_change_kwh;
    new.estimated_natural_loss_kwh = old.estimated_natural_loss_kwh;
    new.feature_snapshot_version = 2;
  elsif new.feature_snapshot_version is distinct from 2 then
    new.energy_before_kwh = old.energy_before_kwh;
    new.energy_after_stabilization_kwh = old.energy_after_stabilization_kwh;
    new.raw_energy_change_kwh = old.raw_energy_change_kwh;
    new.estimated_natural_loss_kwh = old.estimated_natural_loss_kwh;
    new.feature_snapshot_version = old.feature_snapshot_version;
  end if;

  return new;
end;
$$;
