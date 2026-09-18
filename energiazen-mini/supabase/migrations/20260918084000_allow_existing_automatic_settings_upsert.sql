create or replace function public.guard_heating_control_mode_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.heating_need_mode is distinct from 'automatic' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- INSERT ... ON CONFLICT executes BEFORE INSERT triggers before conflict
    -- resolution. If the singleton row already exists, let the upsert reach
    -- its UPDATE phase. A real fixed -> automatic transition is still checked
    -- by this same trigger as an UPDATE.
    if exists (
      select 1
      from public.heating_control_settings
      where id = new.id
    ) then
      return new;
    end if;

    if not public.is_v2_automatic_control_plane_ready() then
      raise exception
        using
          errcode = 'check_violation',
          message = 'Automatic heating control plane is not ready';
    end if;

    return new;
  end if;

  if old.heating_need_mode is distinct from 'automatic'
     and not public.is_v2_automatic_control_plane_ready() then
    raise exception
      using
        errcode = 'check_violation',
        message = 'Automatic heating control plane is not ready';
  end if;

  return new;
end;
$$;

comment on function public.guard_heating_control_mode_transition() is
  'Fail-closed guard for true transitions into automatic mode. Existing-row UPSERT insert probes are allowed to reach ON CONFLICT UPDATE, where fixed-to-automatic transitions remain guarded.';
