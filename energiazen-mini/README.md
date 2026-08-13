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

## Varaajan mittausvian sähköpostihälytys

`check-tank-monitor-health` tarkistaa 5 minuutin välein (`pg_cron`-jobi
`check-tank-monitor-health-every-5-minutes`, migraatio
`supabase/migrations/20260802000000_add_tank_monitor_health_alert_schedule.sql`)
onko `tank_readings`-taulun tuorein rivi yli 30 minuuttia vanha (kynnys
`supabase/functions/check-tank-monitor-health/alertLogic.ts`:n
`staleReadingAlertThresholdMinutes` - pidä synkassa
`lib/tankMonitorAlert.ts`:n vastaavan vakion kanssa, jota etusivun
virhebanneri käyttää). Sähköposti lähtee [Resendillä](https://resend.com)
vain terve → vanhentunut -tilasiirtymässä, ei joka ajolla eikä uudestaan
niin kauan kuin vika on jo tiedossa (`device_monitor_state`-taulun yhden
rivin tila). Palautumisesta ei lähetetä erillistä sähköpostia - se näkyy
suoraan etusivun bannerin katoamisena heti kun tuore mittaus saapuu.

Vastaanottajat haetaan Supabase Authista
(`supabase.auth.admin.listUsers()`, kaikki sivut käyden läpi), ei
kovakoodata - kaikki appiin kirjautuneet käyttäjät saavat hälytyksen
samaan osoitteeseen jolla he kirjautuvat sisään. Jokaiselle
vastaanottajalle lähetetään oma erillinen viesti, jottei kukaan näe
muiden kirjautumissähköposteja.

**Rajoitus:** `onboarding@resend.dev`-testidomain toimittaa viestejä vain
Resend-tilin *omistajan* sähköpostiin. Tämä toimii nyt koska ainoa
Supabase Auth -käyttäjä on sama henkilö kuin Resend-tilin omistaja. Jos
appiin lisätään joskus toinen kirjautuva käyttäjä eri sähköpostilla,
tarvitaan oma verifioitu lähetysdomain Resendissä
(https://resend.com/domains), muuten kyseisen käyttäjän hälytys epäonnistuu
äänettömästi (Edge Function palauttaa 502:n, mutta cron-ajo ei ilmoita
siitä mihinkään erikseen).

`device_monitor_state`-taulussa on RLS käytössä ilman client-policyja -
vain `service_role` (joka ohittaa RLS:n) pääsee siihen käsiksi, joten
appin/Shellyn julkisella avaimella ei voi peukaloida hälytystilaa.

Tallenna Resendin API-avain secretiksi (ei koskaan repoon):

```bash
supabase secrets set RESEND_API_KEY=re_xxxxxxxx --project-ref amyvzelzbvjvrevikvrp
```

Deployaa funktio:

```bash
supabase functions deploy check-tank-monitor-health
```

Aja migraatiot linkitettyyn projektiin (luo `device_monitor_state`-taulun ja
ajastuksen - käyttää samoja `project_url`/`publishable_key`-Vault-secretejä
jotka on jo luotu sähkön hintahaun ajastusta varten yllä):

```bash
supabase link --project-ref amyvzelzbvjvrevikvrp
supabase db push
```

Tarkista jobi ja viimeisimmät ajot:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'check-tank-monitor-health-every-5-minutes';

select *
from cron.job_run_details
where jobid = (
  select jobid
  from cron.job
  where jobname = 'check-tank-monitor-health-every-5-minutes'
)
order by start_time desc
limit 10;
```

Tarkista nykyinen tila:

```sql
select * from public.device_monitor_state;
```

## Lämmitysoptimoinnin backend shadow mode

`run-heating-optimizer` ajaa saman lämmitysoptimoinnin kuin appi
(`optimizeHeatingPlan()`, `supabase/functions/_shared/heatingOptimizer.ts` -
ks. alla miksi tämä ei asu `lib/`:ssä) backendissä, tuotanto-
Supabasen hinta-, varaaja- ja asetusdatalla, mutta **ei kirjoita
`heating_plans`-tauluun**. Jokainen ajo tallentaa yhden diagnostisen rivin
`heating_plan_shadow_runs`-tauluun (suunniteltu tulos, verrattuna appin
nykyiseen julkaisuun) - Shelly ja appi jatkavat toimimista täysin
muuttumattomina. Tämä on tarkoituksella väliaikainen vaihe: backendistä
tehdään ensisijainen kirjoittaja `heating_plans`-tauluun vasta erikseen
hyväksyttävässä myöhemmässä muutoksessa.

Optimizerin ja julkaisun turvamekanismit (current-hour preservation,
unknown heating state, stale-input/valmiusgate, duplikaatti-/vanhentunut
julkaisusuoja) tulevat suoraan appin omista, jo framework-riippumattomista
moduuleista (`heatingPlanPublication.ts`, `heatingPlanOrchestration.ts`) -
ei kopioita. Kaikki funktion oma logiikka on
`supabase/functions/run-heating-optimizer/logic.ts`:ssä (ei
Deno-only-APIeja, yksikkötestattu Node:n alla `logic.test.ts`:llä,
mukana `npm test`:ssä); `index.ts` on ohut Supabase-IO-kuori (hakee inputit
service role -oikeuksilla, kutsuu `logic.ts`:ää, tallentaa yhden
shadow-rivin).

**Jaettu domain-logiikka asuu `supabase/functions/_shared/`-hakemistossa,
ei `lib/`:ssä.** `npx supabase functions deploy <nimi> --use-api`
bundlaa vain `supabase/functions/`-hakemiston sisällä pysyvät importit -
`../../../lib/...`-tyyppinen reitti ulos kyseisestä hakemistosta
epäonnistuu bundlauksessa ("Module not found"), vaikka se tyyppitarkistuu
ja läpäisee `npm test`:n täysin ongelmitta Node/tsc:n alla. Siksi
`optimizeHeatingPlan()` ja sen koko riippuvuuspuu (`heatingOptimizer.ts`,
`heatingOptimizationRun.ts`, `heatingPlanOrchestration.ts`,
`heatingPlanPublication.ts`, `tankTemperatureForecast.ts`,
`temperatureDropProfile.ts`, `settingsDefaults.ts`, `heatingLogic.ts`,
`tankReadingFreshness.ts`, `heatingGain.ts`, `heatingGain.ts`:n omat
riippuvuudet ja `energyModelV2/sensorGeometry.ts`) asuvat fyysisesti
`supabase/functions/_shared/`:ssä - se on yksi ainoa lähde, ei toinen
rinnakkainen toteutus. `lib/`-hakemistossa samannimiset tiedostot ovat
ohuita `export * from "../supabase/functions/_shared/<nimi>"`
-uudelleenvientejä, jotta jokainen appin olemassa oleva import-polku
(mukaan lukien testit) toimii muuttumattomana. Jos jonkin näistä
tiedostoista sisältöä muuttaa, muokkaa `_shared/`-versiota - `lib/`-versio
on vain ohitus, ei erillinen kopio.

`tests/edgeFunctionImportBoundaries.test.ts` (osa `npm test`:iä) tarkistaa
staattisesti, ettei mikään `supabase/functions/`:n alla oleva `.ts`-tiedosto
(pl. `.test.ts`) tuo mitään suhteellisella polulla kyseisen hakemiston
ulkopuolelta - sama sääntö jota `--use-api`-bundleri noudattaa. Tämä
havaitsee tämän luokan regression ilman oikeaa Deno CLI:tä tai
tuotantodeployta.

**Tunnettu rajoitus:** `heating_control_settings`-taulussa ei tällä
hetkellä ole kaikkia optimizerin tarvitsemia asetuksia (mm.
`automaticMaxHeatingHours`, `safetyShowerReserve` puuttuvat - appin oikea
asetuslähde on laitekohtainen `AsyncStorage`). Näiltä osin funktio käyttää
`defaultSettings`-oletuksia, ja jokainen shadow-rivi kertoo tämän
`settings_source`-sarakkeessa (`heating_control_settings+defaults` tai
`defaults_only`) sen sijaan että väittäisi hiljaa täyttä yhteensopivuutta.

`planned_hours_match` vertaa backendin tulosta appin `heating_plans`-tauluun
tallentamaan tämän päivän suunnitelmaan **vain** jos kyseinen appin
suunnitelma on julkaistu automaattitilassa (`app_plan_mode = 'automatic'`) -
backend ajaa aina vain automaattista optimizeria, joten vertailu appin
`fixed`-tilan suunnitelmaan ei olisi mielekäs signaali. Muissa tapauksissa
(`fixed`-tila, appin suunnitelmaa ei löytynyt) `planned_hours_match` on
`null`; `app_plan_mode` kertoo kummasta on kyse.

Deployaa funktio:

```bash
supabase functions deploy run-heating-optimizer
```

Aja migraatiot linkitettyyn projektiin (luo `heating_plan_shadow_runs`-taulun
ja diagnostisen ajastuksen - käyttää samoja `project_url`/
`publishable_key`-Vault-secretejä jotka on jo luotu sähkön hintahaun
ajastusta varten yllä):

```bash
supabase link --project-ref amyvzelzbvjvrevikvrp
supabase db push
```

### Ajastus

Migraatio luo jobin `run-heating-optimizer-shadow-hourly`, joka käynnistyy
kerran tunnissa minuutilla 20 - 10 minuuttia `fetch-electricity-prices-hourly`
(minuutti 10) jälkeen, jotta jokainen ajo näkee kyseisen tunnin tuoreimmat
hinnat. Koska `tank_readings` päivittyy noin minuutin välein, sama tunnin
välein toistuva ajo poimii myös aina tuoreen varaajalukeman - erillistä
"muutaman kerran päivässä" -jobia ei tarvita. Ajastus on mitoitettu
vertailutrendin keräämiseen, ei tuotantopäätöksiin - tarkista ennen
mahdollista production write -vaihetta, tarvitaanko appin omaa
uudelleenajotiheyttä lähempänä oleva ajastus.

Tarkista jobi ja viimeisimmät ajot:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'run-heating-optimizer-shadow-hourly';

select *
from cron.job_run_details
where jobid = (
  select jobid
  from cron.job
  where jobname = 'run-heating-optimizer-shadow-hourly'
)
order by start_time desc
limit 10;
```

Tarkista viimeisimmät shadow-ajot ja niiden vertailu appin julkaisuun:

```sql
select
  run_at,
  today_plan_date,
  today_planned_hours,
  app_planned_hours_today,
  app_plan_mode,
  planned_hours_match,
  reason,
  optimizer_valid,
  settings_source,
  uncertainty_reason
from public.heating_plan_shadow_runs
order by run_at desc
limit 20;
```

`heating_plan_shadow_runs`-taulussa on RLS käytössä ilman client-policyja -
sama malli kuin `device_monitor_state`:lla - vain `service_role` pääsee
siihen käsiksi, koska data on toistaiseksi puhtaasti diagnostista eikä
appissa ole sille vielä käyttöliittymää.

Poista ajastus tarvittaessa:

```sql
select cron.unschedule(jobid)
from cron.job
where jobname = 'run-heating-optimizer-shadow-hourly';
```

### Backend-optimoijan trust-heartbeat (shadow mode)

Migraatio `20260813000000_create_backend_heating_optimizer_state.sql` luo yhden
`id = 1` current-state-rivin. Historiataulua ei tarvita Shellyn päätökseen;
`heating_plan_shadow_runs` säilyttää jo ajokohtaisen diagnostiikan. Erilliset
`last_run_attempt_at`, `last_validated_plan_at` ja `last_published_at` estävät
ajoyrityksen, onnistuneen validoinnin ja todellisen kirjoituksen sekoittamisen.

Tunnin välein ajettavalle jobille production trust-raja on 90 minuuttia:
yksi normaali 60 minuutin ajoväli ja 30 minuutin operatiivinen liikkumavara.
Kun gate myöhemmin aktivoidaan, Shelly luottaa tämän päivän suunnitelmaan vain,
kun heartbeat on `healthy`, heartbeatin plan-fingerprint vastaa luettua
`plan_date` + normalisoitua `planned_hours` -identiteettiä ja
`last_validated_plan_at` on kelvollinen, enintään 90 minuuttia vanha eikä
tulevaisuudessa. Muuten se käyttää `backup_hours`-tunteja, jos
`fallback_enabled = true`; muulloin releohjaus failaa kiinni. Suunnitelman
`updated_at` ei gatea luottamusta: `no_changes` päivittää validoinnin mutta ei
julkaisuaikaa.

Shadow mode säilyy: vain validi, tallennettuun suunnitelmaan identtinen
`no_changes` merkitään terveeksi ja päivittää validointiajan. Muuttunut validi
tulos merkitään `changes_not_published`/unhealthy, koska tätä luonnosta ei vielä
kirjoiteta `heating_plans`-tauluun; `last_published_at` ei siis etene tässä
PR:ssä. Invalidit ja deferred-ajot ovat unhealthy. Hintojen tuoreus perustuu
käyttökelpoiseen kattavuuteen: ensimmäisen optimizerille annetun tuntivälin on
katettava nykyhetki ja kaikkien valittuun optimointi-ikkunaan kuuluvien
hintavälien on oltava valideja, tunnin mittaisia ja aukottomia. `fetched_at`-iälle
ei aseteta keinotekoista rajaa.

Heartbeat ei yksin todista pg_cronin tai Edge Functionin olevan elossa. Jos
cron ei käynnistä funktiota tai funktio kaatuu ennen ensimmäistä state-kirjoitusta,
se ei voi kirjata omaa epäonnistumistaan; Shelly havaitsee tilanteen vasta
edellisen validoinnin 90 minuutin vanhenemisesta. Käynnistyksen jälkeen jäävä
`running`-tila on tarkoituksella unhealthy. Erillinen ulkoinen cron/deploy-
monitorointi tarvitaan edelleen ennen backend-primary-vaihetta.

**Deployment-gate:** `BACKEND_PLAN_TRUST_ENABLED` on Shelly-lähteessä tässä
shadow-PR:ssä tarkoituksella `false`. Shadow-optimizer voi merkitä terveeksi vain
`no_changes`-ajon, joten gaten aktivointi nyt voisi ajaa laitteen jatkuvaan
fallbackiin aina appin julkaisun muututtua. Gate aktivoidaan vasta erillisessä,
hyväksytyn plan-publication-polun sisältävässä kontrolloidussa Shelly-deployssa;
tämä PR ei muuta nykyistä tuotanto-ohjausta eikä ota backend-primaryä käyttöön.

Rinnakkaiset ajot omistavat singletonin UUID `current_run_id` +
`current_run_started_at` -CAS-tokenilla. Uudempi aloitusaika syrjäyttää vanhemman,
ja lopetus-RPC päivittää rivin vain molempien arvojen täsmätessä. Siksi myöhään
valmistuva vanha ajo ei voi ylikirjoittaa uudemman ajon tulosta. Onnistunut
`no_changes` tallentaa lisäksi deterministisen identiteetin muodossa
`YYYY-MM-DD|h1,h2,...`, jossa tunnit deduplikoidaan ja järjestetään.
