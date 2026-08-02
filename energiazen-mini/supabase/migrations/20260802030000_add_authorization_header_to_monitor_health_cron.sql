-- Cron-ajot epäonnistuivat 401 UNAUTHORIZED_NO_AUTH_HEADER -virheellä -
-- Supabasen Edge Function -yhdyskäytävä vaatii Authorization-headerin,
-- pelkkä apikey ei riittänyt (todettu net._http_response-taulusta: jokainen
-- ajo sai saman "Missing authorization header" -vastauksen, pyyntö ei
-- koskaan tavoittanut funktiota). Lähetetään nyt molemmat headerit samalla
-- publishable_key-arvolla, joka toimii sekä apikeynä että Bearer-tokenina.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'check-tank-monitor-health-every-5-minutes'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'check-tank-monitor-health-every-5-minutes',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := (
      select rtrim(decrypted_secret, '/')
      from vault.decrypted_secrets
      where name = 'project_url'
      limit 1
    ) || '/functions/v1/check-tank-monitor-health',
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
