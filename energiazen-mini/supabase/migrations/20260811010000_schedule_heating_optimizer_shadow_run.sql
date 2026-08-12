-- Diagnostic-only pg_cron schedule for the run-heating-optimizer shadow
-- Edge Function. This job NEVER touches heating_plans - it only makes
-- run-heating-optimizer insert one heating_plan_shadow_runs row per fire,
-- for comparing backend vs. app output over time before any production
-- write phase is separately approved.
--
-- Cadence: hourly at minute 20 ('20 * * * *').
--
-- Why hourly-at-:20, not a separate "few times a day" job:
--   - fetch-electricity-prices-hourly already runs every hour at minute 10
--     (20260724020000_schedule_electricity_price_fetch.sql). Firing 10
--     minutes after that, every hour, means every single shadow run already
--     sees that hour's freshest price data - covering the "run shortly
--     after the price fetch" requirement on every fire, not just once a
--     day when new day-ahead prices are published.
--   - tank_readings land roughly every 60 seconds, so any run this job
--     makes also picks up a fresh reading - covering the "run a few times
--     a day so a fresh tank reading can change the plan" requirement, and
--     doing so more often (24x/day) than "a few times" would.
--   - One hourly job is simpler to reason about and monitor than two
--     overlapping schedules, and shadow mode has no write-side blast
--     radius to control for - the only cost of a tighter cadence is extra
--     rows in heating_plan_shadow_runs and extra function invocations.
-- Revisit this cadence (likely tighter, closer to the app's own re-run
-- frequency) before any future production-write phase - this schedule is
-- sized for building a comparison trend, not for driving real heating
-- decisions.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'run-heating-optimizer-shadow-hourly'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'run-heating-optimizer-shadow-hourly',
  '20 * * * *',
  $cron$
  select net.http_post(
    url := (
      select rtrim(decrypted_secret, '/')
      from vault.decrypted_secrets
      where name = 'project_url'
      limit 1
    ) || '/functions/v1/run-heating-optimizer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'publishable_key'
        limit 1
      ),
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'publishable_key'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);
