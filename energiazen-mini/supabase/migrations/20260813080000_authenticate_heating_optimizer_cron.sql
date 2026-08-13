-- Reschedule the write-capable optimizer with a dedicated private caller
-- secret. The Vault secret must be provisioned separately; no secret value is
-- stored in this migration.

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
