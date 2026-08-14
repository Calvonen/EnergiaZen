-- Backend-primary publication needs the same user-selected optimizer
-- settings the app uses. Keep these nullable for forward-only compatibility
-- with existing rows; run-heating-optimizer treats NULL/missing values as
-- not publication-ready and fails closed.

alter table public.heating_control_settings
  add column if not exists heating_need_mode text,
  add column if not exists automatic_max_heating_hours integer,
  add column if not exists safety_shower_reserve double precision,
  add column if not exists heating_gain_source text;

comment on column public.heating_control_settings.heating_need_mode is
  'User-selected heating control mode. Backend-primary may publish automatic plans only when this is automatic.';
comment on column public.heating_control_settings.automatic_max_heating_hours is
  'User-selected maximum automatic heating hours used by backend-primary optimizer publication.';
comment on column public.heating_control_settings.safety_shower_reserve is
  'User-selected safety shower reserve used by backend-primary optimizer publication.';
comment on column public.heating_control_settings.heating_gain_source is
  'User-selected heating gain source: learned or fixed.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.heating_control_settings'::regclass
      and conname = 'heating_control_settings_heating_need_mode_check'
  ) then
    alter table public.heating_control_settings
      add constraint heating_control_settings_heating_need_mode_check
      check (heating_need_mode is null or heating_need_mode in ('automatic', 'fixed'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.heating_control_settings'::regclass
      and conname = 'heating_control_settings_heating_gain_source_check'
  ) then
    alter table public.heating_control_settings
      add constraint heating_control_settings_heating_gain_source_check
      check (heating_gain_source is null or heating_gain_source in ('learned', 'fixed'));
  end if;
end;
$$;

grant select, update on table public.heating_control_settings to service_role;
