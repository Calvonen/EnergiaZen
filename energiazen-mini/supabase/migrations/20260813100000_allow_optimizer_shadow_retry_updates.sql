-- A tank-snapshot retry remains one backend invocation and one diagnostic
-- row. The Edge Function updates that row with the retry attempt's fresh
-- optimizer inputs instead of inserting a second shadow row.
grant update on table public.heating_plan_shadow_runs to service_role;
