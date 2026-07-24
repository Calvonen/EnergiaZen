# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

## Sähkön hintahistorian Edge Function

`fetch-electricity-prices` hakee Spot-hinta.fi-palvelusta Suomen nykyisen ja
seuraavan saatavilla olevan vuorokauden hinnat. Funktio käyttää oletuksena 60
minuutin resoluutiota. Resoluutio voidaan vaihtaa 15 minuuttiin secretillä:

```bash
supabase secrets set PRICE_RESOLUTION_MINUTES=15
```

Supabasen hostatussa Edge Function -ympäristössä `SUPABASE_URL` ja
`SUPABASE_SERVICE_ROLE_KEY` ovat valmiiksi käytettävissä, eikä niitä pidä
kirjoittaa lähdekoodiin tai commitoitavaan `.env`-tiedostoon. Paikallista ajoa
varten tee versionhallinnan ulkopuolinen `.env.local`:

```dotenv
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key>
PRICE_RESOLUTION_MINUTES=60
```

Käynnistä funktio paikallisesti:

```bash
supabase functions serve fetch-electricity-prices --env-file .env.local
curl --request POST http://127.0.0.1:54321/functions/v1/fetch-electricity-prices \
  --header "Authorization: Bearer <local-anon-key>"
```

Linkitä projekti ja deployaa funktio:

```bash
supabase login
supabase link --project-ref <project-ref>
supabase functions deploy fetch-electricity-prices
```

Käynnistä deployattu funktio käsin projektin publishable-avaimella:

```bash
curl --request POST \
  https://<project-ref>.supabase.co/functions/v1/fetch-electricity-prices \
  --header "apikey: <publishable-key>"
```

Varmista tallennus Supabase SQL Editorissä:

```sql
select
  region,
  price_date,
  starts_at,
  ends_at,
  spot_price_cents_kwh,
  resolution_minutes,
  fetched_at
from public.electricity_prices
where region = 'FI'
order by starts_at desc
limit 20;
```

Upsert käyttää konfliktisarakkeita
`region,starts_at,resolution_minutes`, joten saman aineiston uudelleenajo
päivittää olemassa olevat rivit eikä luo duplikaatteja. Edge Functionin
tarvitsemat `service_role`-oikeudet ja
sovelluksen `authenticated`-lukuoikeus tulevat Supabase-migraatiosta, joten
niitä ei tarvitse myöntää käsin SQL Editorissä.

### Automaattisen hintahaun ajastus

Tallenna Cron-kutsun URL ja publishable-avain ensin Supabase Vaultiin SQL
Editorissä. Avainta ei tallenneta migraatioon tai repoon:

```sql
select vault.create_secret(
  'https://amyvzelzbvjvrevikvrp.supabase.co',
  'project_url'
);

select vault.create_secret(
  '<SUPABASE_PUBLISHABLE_KEY>',
  'publishable_key'
);
```

Aja migraatiot linkitettyyn projektiin:

```bash
supabase link --project-ref amyvzelzbvjvrevikvrp
supabase db push
```

Migraatio luo jobin `fetch-electricity-prices-hourly`, joka käynnistyy kerran
tunnissa minuutilla 10. Tarkista jobi:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'fetch-electricity-prices-hourly';
```

Tarkista kymmenen viimeisintä Cron-ajoa:

```sql
select *
from cron.job_run_details
where jobid = (
  select jobid
  from cron.job
  where jobname = 'fetch-electricity-prices-hourly'
)
order by start_time desc
limit 10;
```

Testaa sama kutsu käsin SQL Editorissä Vault-arvoja käyttäen:

```sql
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
```

Poista ajastus tarvittaessa:

```sql
select cron.unschedule(jobid)
from cron.job
where jobname = 'fetch-electricity-prices-hourly';
```
