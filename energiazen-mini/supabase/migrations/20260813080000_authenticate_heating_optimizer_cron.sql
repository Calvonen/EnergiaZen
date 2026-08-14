-- Reschedule the write-capable optimizer with a dedicated private caller
-- secret. The Vault secret must be provisioned separately; no secret value is
-- stored in this migration.
--
-- Architecture note (post-simplification): this single pg_cron schedule is
-- the ONLY thing that requests a run-heating-optimizer invocation. An
-- earlier version of this PR also added a live-trigger subsystem (tank
-- reading materiality baseline, a per-key debounce/pending table, and a
-- separate minute-granularity drain cron) to react to tank_readings/
-- heating_control_settings changes faster than an hourly schedule. An
-- architecture review found that subsystem carried zero safety
-- responsibility of its own - every required protection (concurrent runs,
-- stale/changed inputs, partial publication) lives entirely in
-- run-heating-optimizer's heartbeat CAS and transactional publication RPC,
-- unconditionally, regardless of what asked for the run - while the
-- Shelly controller's own trust window
-- (MAX_BACKEND_VALIDATION_AGE_SECONDS = 90 minutes,
-- shelly/energyzen-controller.js) made the live trigger's latency
-- improvement (worst case ~5-6 minutes vs. a flat schedule's few minutes)
-- immaterial in practice. Tightening this cron from hourly to every 5
-- minutes below gets materially the same real-world reaction latency with
-- none of that additional state, so the live-trigger subsystem was
-- removed rather than kept alongside a faster cron. None of the removed
-- migrations had been applied to any deployed environment, so they were
-- deleted outright instead of superseded by further migrations - see this
-- PR's history for the full removed subsystem if it's ever needed again.
--
-- The job name is kept as 'run-heating-optimizer-shadow-hourly' for
-- continuity with the still-undeployed migration history above this one
-- (20260811010000_schedule_heating_optimizer_shadow_run.sql first created
-- it) even though the job is no longer shadow-only or hourly - renaming it
-- would just be churn before this has ever run anywhere.

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
  '*/5 * * * *',
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
      ),
      'x-energyzen-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'heating_optimizer_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);
