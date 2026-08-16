-- Siirtää fetch-electricity-prices-hourly-jobin ajastuksen kerran tunnissa
-- (minuutilla 10) ajettavasta kahdesti tunnissa (minuutilla 20 ja 50)
-- ajettavaksi, jotta noin klo 14:15 julkaistavat huomisen sähköhinnat
-- saadaan nopeammin mukaan backend-optimointiin.

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'fetch-electricity-prices-hourly'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'fetch-electricity-prices-hourly',
  '20,50 * * * *',
  $cron$
  select net.http_post(
    url := (
      select rtrim(decrypted_secret, '/')
      from vault.decrypted_secrets
      where name = 'project_url'
      limit 1
    ) || '/functions/v1/fetch-electricity-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
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
