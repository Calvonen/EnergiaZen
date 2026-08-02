-- tank_readings on luotu suoraan Supabase Studiossa ennen kattavaa
-- migraatioseurantaa (ks. docs/PROJECT_CONTEXT.md), joten sen grantit eivat
-- ole versionhallinnassa. service_role ohittaa RLS:n mutta tarvitsee silti
-- taulukohtaisen GRANTin - check-tank-monitor-health-Edge Function
-- (service_role-avaimella) sai "permission denied for table tank_readings"
-- ilman tata.
grant select
on table public.tank_readings
to service_role;
