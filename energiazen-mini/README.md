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

Migraatio luo jobin `fetch-electricity-prices-hourly`, joka käynnistyy kahdesti
tunnissa minuuteilla 20 ja 50. Tarkista jobi:

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

## Lämmitysoptimoinnin backend-primary

`run-heating-optimizer` ajaa saman lämmitysoptimoinnin kuin appi
(`optimizeHeatingPlan()`, `supabase/functions/_shared/heatingOptimizer.ts` -
ks. alla miksi tämä ei asu `lib/`:ssä) backendissä, tuotanto-
Supabasen hinta-, varaaja- ja asetusdatalla. Jokainen ajo tallentaa edelleen
diagnostisen rivin `heating_plan_shadow_runs`-tauluun, mutta validi ja valmis
ajo saa nyt julkaista duplicate-suppressionin tunnistamat muuttuneet rivit
`heating_plans`-tauluun. Julkaisu tehdään vain heartbeat-omistajuuden
CAS-suojauksen alla, ja onnistunut julkaisu päivittää samalla Shellyn
trust-fingerprintin.

Optimizerin ja julkaisun turvamekanismit (current-hour preservation,
unknown heating state, stale-input/valmiusgate, duplikaatti-/vanhentunut
julkaisusuoja) tulevat suoraan appin omista, jo framework-riippumattomista
moduuleista (`heatingPlanPublication.ts`, `heatingPlanOrchestration.ts`) -
ei kopioita. Kaikki funktion oma logiikka on
`supabase/functions/run-heating-optimizer/logic.ts`:ssä (ei
Deno-only-APIeja, yksikkötestattu Node:n alla `logic.test.ts`:llä,
mukana `npm test`:ssä); `index.ts` on ohut Supabase-IO-kuori (hakee inputit
service role -oikeuksilla, kutsuu `logic.ts`:ää, tallentaa shadow-rivin ja
kutsuu tarvittaessa transaktionaalista publication-RPC:tä).

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
**viiden minuutin välein** (`*/5 * * * *`). Nimi on historiallinen jäänne
ensimmäisestä shadow-mode-versiosta (ks. alla "Yksinkertaistushistoria") -
job ei ole enää shadow-only eikä hourly, mutta sitä ei ole nähty
tarpeelliseksi nimetä uudelleen ennen kuin mikään tämän PR:n migraatioista
on koskaan ajettu tuotantoon. Tämä yksi ajastus on **ainoa** tapa pyytää
`run-heating-optimizer`-ajo - ei erillisiä tietokantatriggereitä millekään
inputille.

Miksi 5 min riittää ilman erillistä live-triggeriä: Shellyn oma
luottamusikkuna (`MAX_BACKEND_VALIDATION_AGE_SECONDS`,
`shelly/energyzen-controller.js`) on 90 minuuttia, ja optimizer joka
tapauksessa tekee vain tuntitason ajastuspäätöksiä (Shellyn oma
current-hour-preservation hoitaa reaaliaikaisen releohjauksen paikallisesti).
5 minuutin ajastus tuo saman käytännön reaktioajan kuin aiempi
materiaalisuus+debounce+drain-ketju olisi antanut parhaimmillaankin, mutta
ilman mitään uutta tilaa tai epäonnistumispistettä - ks. alla.

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

Tarkista viimeisimmät ajot ja niiden vertailu appin julkaisuun (shadow-
diagnostiikka säilytetään toistaiseksi - ks. alla):

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

### Yksinkertaistushistoria: live-triggerin poisto

Tämän PR:n aiempi versio lisäsi `run-heating-optimizer-shadow-hourly`-cronin
rinnalle erillisen live-trigger-alijärjestelmän, joka pyysi ajon heti kun
`tank_readings` sai uuden rivin tai `heating_control_settings` muuttui:
materiaalisuustarkistus (baseline-taulu), per-avain debounce/pending-taulu
ja lopulta vielä minuutin välein ajettava erillinen drain-cron sen
purkamiseen. Kolme peräkkäistä arviointikierrosta löysi siitä P1-tason
korjattavaa (liian lyhyt debounce, materiaalisuuden puuttuminen, purkamaton
pending-tila) - jokainen korjaus lisäsi tilaa poistamisen sijaan.

Arkkitehtuurikatselmus totesi, että koko alijärjestelmällä ei ollut
omaa turvallisuusvastuuta lainkaan: kaikki vaaditut suojaukset
(samanaikaiset ajot, muuttuneet hinnat/asetukset, tuntematon
rele/lämmitystila, osittainen julkaisu) toteutuvat kokonaan
`run-heating-optimizer`:n heartbeat-CAS:ssa ja transaktionaalisessa
julkaisu-RPC:ssä, riippumatta siitä mikä pyysi ajon. Koska mikään näistä
migraatioista ei ollut koskaan ajettu tuotantoon, ne poistettiin suoraan
historiasta migraatiotiedostoina sen sijaan että niitä olisi kumottu
uusilla "drop"-migraatioilla - lopputulos on nyt yksi ajastus (yllä) sen
sijaan että koko alijärjestelmä rakennettaisiin migraatiohistoriaan vain
purettavaksi heti perään. Poistetut taulut/funktiot:
`backend_heating_optimizer_trigger_state`,
`backend_heating_optimizer_trigger_debounce`,
`backend_heating_optimizer_tank_trigger_baseline`,
`request_backend_heating_optimizer_run`,
`dispatch_backend_heating_optimizer_run`,
`drain_pending_backend_heating_optimizer_dispatch`, sekä
`tank_readings`- ja `heating_control_settings`-triggerit joita ne
palvelivat. `BACKEND_PLAN_TRUST_ENABLED` on edelleen `false` Shellyn
controllerissa - tämä yksinkertaistus ei muuta laitteen luottamustilaa.

### Asetusten backfill ennen backend-primary-julkaisua

Olemassa olevalla asennuksella `heating_control_settings`-rivi on voinut
syntyä ennen kuin backend-primaryn vaatimat authoritative-sarakkeet
(`heating_need_mode`, `automatic_max_heating_hours`,
`safety_shower_reserve`, `target_shower_reserve`, `full_tank_showers`,
`full_tank_average_temperature`, `min_tank_temperature`,
`max_tank_temperature`, `heating_gain_source`) ylipäätään olivat olemassa,
jolloin ne ovat `NULL`. `resolveOptimizerSettings` (backend) failaa tällöin
kiinni (`control_mode_missing`/`settings_incomplete`) eikä koskaan
julkaise - ja koska appin oma legacy-automaattijulkaisija on
backend-primary-tilassa poissa käytöstä, käyttäjän `heating_plans` voisi
jäädä jäätyneeksi kunnes hän sattuu avaamaan Asetukset ja painamaan
Tallenna.

`lib/settingsScenarioContext.tsx` (`SettingsScenarioProvider`, koko sovelluksen
jaettu asetuskonteksti) ratkaisee tämän ilman käyttäjän toimenpiteitä:
heti kun `loadSettings()` on ladannut appin todelliset paikalliset
asetukset AsyncStoragesta, se tarkistaa `lib/heatingControlSettingsBackfill.ts`:n
`isHeatingControlSettingsRowAuthoritative`-funktiolla onko Supabasen rivi jo
täydellinen. Jos ei, se kutsuu täsmälleen samaa
`upsertHeatingControlSettings`/`buildHeatingControlSettingsPayload`-polkua
jota Asetukset-ruudun oma Tallenna-painike käyttää, ja kirjoittaa appin
**nykyiset** paikalliset asetukset (ei mitään erillistä "backend-oletusta")
Supabaseen. `heating_need_mode` kirjoitetaan täsmälleen sellaisena kuin se
paikallisesti on - `fixed`-tilassa oleva asennus pysyy `fixed`-tilassa,
backfill ei koskaan pakota sitä automaattiseksi.

Kontekstin `isHeatingControlSettingsSynced`-arvo on `false` oletuksena
(fail-safe) ja muuttuu `true`:ksi vasta kun rivi on vahvistettu
täydelliseksi (oli se jo valmiiksi sitä, tai backfill juuri onnistui).
`app/(tabs)/index.tsx`:n `shouldPublishHeatingPlanFromApp`-portti vaatii nyt
sekä deploy-aikaisen `BACKEND_PRIMARY_HEATING_PLAN_ENABLED`-lipun että tämän
per-asennuskohtaisen synkronointivahvistuksen - pelkkä lippu ei enää riitä.
Näin yksikään asennus ei jää ilman toimivaa automaattijulkaisijaa: kunnes
oma synkronointi on vahvistettu, appin legacy-automaattijulkaisija pysyy
käytössä täsmälleen kuten ennen backend-primarya. Epäonnistunut tarkistus
tai kirjoitus (verkkovirhe, Supabase-virhe) pitää `isHeatingControlSettingsSynced`-
arvon `false`:na ja yrittää uudelleen 5 minuutin välein taustalla.

Migraatio `20260814020000_grant_heating_control_settings_client_select.sql`
varmistaa idempotentisti, että `anon`/`authenticated` saavat myös SELECT-
oikeuden `heating_control_settings`-tauluun (INSERT/UPDATE toimi jo ennen
tätä appin oman Tallenna-polun kautta, mutta SELECT ei ollut minkään
migraation varmistama) - tätä tarvitaan backfill-tarkistuksen lukuun.

### Fixed-tilan julkaisun etätila-tarkistus

`shouldPublishHeatingPlanFromApp` sallii `fixed`-tilan appijulkaisun aina,
riippumatta `BACKEND_PRIMARY_HEATING_PLAN_ENABLED`/
`isHeatingControlSettingsSynced`-portista - kiinteä suunnitelma on
käyttäjän eksplisiittinen komento, ei jotain jonka backend-primary
omistaisi. Tämä avasi kuitenkin oman aukkonsa (Codex P2, PR #193): jos
laite pysyy auki paikallisella `fixed`-asetuksella samalla kun toinen
laite vaihtaa Supabasen authoritative `heating_control_settings.heating_need_mode`-
arvon `automatic`-tilaan, vanhentunut laite jatkaisi `heating_plans`-taulun
ylikirjoittamista `fixed`-suunnitelmilla loputtomiin backend-primaryn
automaattijulkaisujen päälle - mikään ei aiemmin tarkistanut authoritative-
tilaa juuri tämän kirjoituspolun kohdalla.

`lib/heatingPlanFixedModeGuard.ts` lisää kevyen, yksisuuntaisen
tarkistuksen: juuri ennen `heating_plans`-kirjoitusta (ei silloin kun
julkaisu jonotettiin, vaan kun se oikeasti suoritetaan) appi lukee
`heating_control_settings.heating_need_mode`:n Supabasesta uudelleen ja
kirjoittaa vain jos vastaus on täsmälleen `'fixed'`. Lukuvirhe, puuttuva
rivi, `null` tai mikä tahansa muu arvo (mukaan lukien `'automatic'`)
failaa kiinni - kirjoitusta ei tehdä. Koska tarkistus tapahtuu vasta
jonotetun `heatingPlanSaveChainRef`-ketjun sisällä suorituksen hetkellä,
se peruu automaattisesti jo jonotetun `fixed`-julkaisun jos authoritative
tila on ehtinyt vaihtua `automatic`-tilaan sillä välin - ei tarvitse
erikseen "peruuttaa" mitään, tarkistus itsessään estää kirjoituksen.

Tämä ei ole kaksisuuntainen Realtime-asetussynkronointi eikä sellaista
tarvittu: kyse on yhdestä kapeasta portista yhden kirjoituspolun edessä.
Tarkistuksen ja itse kirjoituksen välillä jää teoriassa hetkellinen ikkuna
(yksi verkkopyyntö), jota ei erikseen suljettu - jos se joskus lauetaan,
seuraava backend-primary-cron-ajo (enintään 5 minuutin päässä) laskee ja
julkaisee joka tapauksessa oman authoritative-lukemansa perusteella
uudelleen, samalla itsekorjautuvuusperiaatteella kuin muuallakin tässä
järjestelmässä. Paikallisen Asetukset-näkymän käyttäytymiseen ei koskettu.

### Backend-optimoijan trust-heartbeat

Migraatio `20260813000000_create_backend_heating_optimizer_state.sql` luo yhden
`id = 1` current-state-rivin. Historiataulua ei tarvita Shellyn päätökseen;
`heating_plan_shadow_runs` säilyttää jo ajokohtaisen diagnostiikan. Erilliset
`last_run_attempt_at`, `last_validated_plan_at` ja `last_published_at` estävät
ajoyrityksen, onnistuneen validoinnin ja todellisen kirjoituksen sekoittamisen.

Production trust-raja Shellyn puolella (`MAX_BACKEND_VALIDATION_AGE_SECONDS`,
`shelly/energyzen-controller.js`) on 90 minuuttia - tämä on laitteen oma,
tarkoituksella konservatiivinen arvo eikä tämä yksinkertaistus (5 min
ajastus, ks. yllä "Ajastus" ja "Yksinkertaistushistoria") ole muuttanut sitä
eikä `BACKEND_PLAN_TRUST_ENABLED`-lippua. 5 minuutin ajastuksella
todellinen liikkumavara on käytännössä paljon suurempi kuin 90 minuuttia
vaatisi. Kun gate myöhemmin aktivoidaan, Shelly luottaa tämän päivän suunnitelmaan vain,
kun heartbeat on `healthy`, heartbeatin plan-fingerprint vastaa luettua
`plan_date` + normalisoitua `planned_hours` -identiteettiä ja
`last_validated_plan_at` on kelvollinen, enintään 90 minuuttia vanha eikä
tulevaisuudessa. Muuten se käyttää `backup_hours`-tunteja, jos
`fallback_enabled = true`; muulloin releohjaus failaa kiinni. Suunnitelman
`updated_at` ei gatea luottamusta: `no_changes` päivittää validoinnin mutta ei
julkaisuaikaa.

Backend-primary-tilassa validi muuttunut tulos julkaistaan
`publish_backend_heating_optimizer_plans`-RPC:llä ja merkitään
`published`/healthy-tilaan vasta, kun muuttuneet `heating_plans`-rivit,
`last_published_at`, `last_validated_plan_at` ja tämän päivän
`validated_plan_fingerprint` on päivitetty samassa tietokantatransaktiossa.
Identtinen tulos kulkee saman snapshot-suojatun RPC:n kautta
`no_changes`/healthy-polulle: se päivittää validoinnin mutta ei
`last_published_at`-kenttää. Invalidit, deferred-ajot ja
publication-virheet ovat unhealthy. Hintojen tuoreus perustuu
käyttökelpoiseen kattavuuteen: ensimmäisen optimizerille annetun tuntivälin on
katettava nykyhetki ja kaikkien valittuun optimointi-ikkunaan kuuluvien
hintavälien on oltava valideja, tunnin mittaisia ja aukottomia. Viimeisen välin
on lisäksi ulotuttava vähintään seuraavaan `Europe/Helsinki`-keskiyöhön asti;
huomisen hinnat ovat edelleen optionaalisia. Keskiyö ratkaistaan IANA-
aikavyöhykkeellä, joten DST-päivän todellinen pituus voi olla 23 tai 25 tuntia
kiinteän 24 tunnin oletuksen sijaan. `fetched_at`-iälle ei aseteta keinotekoista
rajaa.

Backend-primary publication vaatii lisäksi, että
`heating_control_settings.heating_need_mode = 'automatic'` ja kaikki
automaattisen optimizerin käyttäjäasetukset löytyvät Supabasesta:
`automatic_max_heating_hours`, `safety_shower_reserve`,
`target_shower_reserve`, `full_tank_showers`,
`full_tank_average_temperature`, `min_tank_temperature`,
`max_tank_temperature` ja `heating_gain_source`. Jos tila on `fixed`,
tuntematon tai jokin näistä arvoista puuttuu, ajo voi yhä tallentaa
diagnostiikan, mutta ei julkaise eikä merkitse automaattista suunnitelmaa
healthy/validated-tilaan.

Backend-primary erottaa optimizer-inputin onnistuneen tyhjän tuloksen
teknisestä hakuvirheestä. Heating gain history, recovery history ja temperature
drop profile voivat edelleen käyttää nykyisiä fallback-arvoja shadow-
diagnostiikassa, mutta yhdenkin haun epäonnistuminen sulkee sekä changed-plan-
julkaisun että `no_changes`-healthy-validoinnin. Heartbeat jää unhealthy/
`deferred`-tilaan, eikä validointi-, fingerprint- tai julkaisuaika etene.
Usean samanaikaisen hakuvirheen reason säilyttää kaikki epäonnistuneet lähteet.

Write-capable `run-heating-optimizer` hyväksyy vain pyynnön, jonka
`x-energyzen-cron-secret` vastaa Edge Functionin
`HEATING_OPTIMIZER_CRON_SECRET`-secretiä. Publishable key palvelee edelleen
Supabase Edge gatewayn tunnistautumista, mutta ei yksin valtuuta optimizer-
ajoa. Sama satunnainen arvo pitää provisionoida ennen cron-migraation ajoa
sekä Edge Function secretiksi että Supabase Vaultiin nimellä
`heating_optimizer_cron_secret`. Secretin arvoa ei tallenneta migraatioon.

Publication-RPC tarkistaa saman tilan uudelleen transaktion sisällä juuri
ennen plan-kirjoitusta tai `no_changes`-validointia. Edge Function välittää full settings -snapshotin
value-by-value (`heating_need_mode`, optimizerin käyttäjäasetukset,
`heating_gain_source`, `updated_at`) sekä plan-version snapshotin. Plan-
snapshot sisältää kaikki `changedPlans`-rivit ja aina myös sen tämän päivän
rivin, jonka fingerprint merkitään validoiduksi, vaikka tänään ei olisi
kirjoitettava rivi. RPC lukitsee `heating_control_settings`-rivin `FOR UPDATE`,
lukitsee `heating_plans`-taulun lyhyen julkaisun ajaksi ja hyväksyy upsertin
vain jos settings-snapshot, validoitava today-row ja kaikki kirjoitettavat
plan-rivit vastaavat alkuperäistä snapshotia. Jos snapshotissa puuttunut rivi
on ilmestynyt tai olemassa ollut rivi on päivittynyt, RPC palauttaa
`plan_conflict`; jos asetukset muuttuivat, se palauttaa `settings_conflict`.
Kumpikaan polku ei kirjoita plan-rivejä eikä päivitä validointi- tai
julkaisuaikoja.

RPC saa lisäksi optimizerin käyttämän latest tank reading -snapshotin
(`created_at`, `heating`, `top_temp`, `bottom_temp`) sekä kanonisen, järjestetyn
snapshotin juuri optimizerille annetuista 60 minuutin hintariveistä (`region`,
`starts_at`, `ends_at`, `resolution_minutes`, `spot_price_cents_kwh`). Se
lukitsee `tank_readings`- ja `electricity_prices`-taulut lyhyen publication/
no-change-transaktion loppuajaksi. Uudempi tank reading sallitaan vain, jos
kaikki optimizerin käyttämät arvot ovat täsmälleen samat; hintavertailu ei
huomioi optimizerin ikkunan ulkopuolisia eikä 15 minuutin rivejä. Muutos,
puuttuva arvo tai puuttuva käytetty hintarivi palauttaa hallitun
`tank_snapshot_conflict`- tai `price_snapshot_conflict`-tuloksen ennen
plan-kirjoituksia, healthy-validointia ja heartbeat-aikaleimojen tai
fingerprintin päivitystä.

Hintasnapshot tarkistetaan molempiin suuntiin. Expected-rivien säilymisen
lisäksi RPC muodostaa lukituksen alla authoritative FI/60 min current-setin
täsmälleen optimizerin samasta ikkunasta: publication-hetkellä jäljellä olevat
tämän päivän intervalit (`ends_at > p_published_at`) sekä kaikki Helsingin
huomisen päivän intervalit. Jos tähän settiin on ilmestynyt rivi, jota Edge
Functionin kanonisessa snapshotissa ei ollut, RPC palauttaa
`price_snapshot_conflict`. Ikkunan ulkopuoliset tulevaisuuden rivit ja 15
minuutin rivit eivät kuulu vertailuun.

Normaali `tank_snapshot_conflict` retrytetään kerran saman backend-runin
sisällä. Ennen retryä Edge Function varmistaa singleton-riviltä, että sama
`current_run_id` + `current_run_started_at` omistaa ajon edelleen. Retry lukee
uudelleen latest tank readingin, hinnat, settingsit, planit, heating gain- ja
recovery-historiat sekä temperature drop profilen, minkä jälkeen optimizer ja
publication-snapshotit rakennetaan alusta. Ensimmäinen konflikti ei päätä
heartbeatia terminal-tilaan. Jos toinenkin yritys konfliktoi, ajo päättyy
`unhealthy`/`deferred`-tilaan syyllä
`tank_snapshot_conflict_retry_exhausted`; settings-, plan-, price- ja
relay-konflikteja ei retrytetä.

**Tunnettu, hyväksytty jäännösriski: temperature drop -profiilin snapshot.**
Codex-review totesi, ettei `temperature_drop_profiles`-taulun uusinta riviä
(`fetchLatestTemperatureDropProfile`, luetaan joka optimizer-yrityksellä
`resolveHourlyDropProfile`:lle) tarkisteta uudelleen transaktionaalisesti
`publish_backend_heating_optimizer_plans`-RPC:ssä, toisin kuin settings-,
plan-, tank- ja price-snapshotit yllä. Viikoittainen
`recalculate-temperature-drop-profile-weekly` (sunnuntaisin klo 01:30) voisi
teoriassa päivittää profiilin juuri optimizerin luvun ja julkaisun välissä,
jolloin yksi julkaisu käyttäisi edellisen viikon profiilia.

Tätä ei korjattu, tietoisena päätöksenä:

- **Ikkuna on paljon pienempi kuin 5 minuutin ajoväli.** Profiili luetaan
  uudelleen jokaisella retry-yrityksellä (index.ts:n retry-loopin sisällä,
  ei kerran koko ajon alussa), joten todellinen race-ikkuna rajoittuu yhden
  yrityksen laskenta-aikaan (sekunnin murto-osia - muutama sekunti), ei koko
  5 minuutin sykliin.
- **Todennäköisyys on häviävän pieni.** Viikoittainen kirjoitus osuu tähän
  sekuntien ikkunaan noin kerran ~604 800 sekunnissa (7 vrk) - satunnaisesti
  osuessaankin vain jos se sattuu juuri jonkin ~2016 viikoittaisen
  optimizer-ajon laskentahetkeen.
- **Seuraus ei riko turvarajaa.** Drop-profiili vaikuttaa vain tuntivalinnan
  laatuun (lämmönhukka-arvio), ei `optimizeHeatingPlan`:n omiin absoluuttisiin
  turvatarkistuksiin (min/max-lämpötila, turvavaraus) - ne pysyvät voimassa
  riippumatta siitä kumman viikon profiilia käytettiin. Väärä tulos on
  korkeintaan hieman epäoptimaalinen yksi 5 minuutin sykli, ei vaarallinen.
- **Itsekorjautuu automaattisesti.** Seuraava, enintään 5 minuutin päässä
  oleva optimizer-ajo lukee tuoreen profiilin normaalisti.
- **Korjaus olisi ollut suhteettoman monimutkainen tähän riskiin nähden.**
  `publish_backend_heating_optimizer_plans` on jo viiden sisäkkäisen,
  toistensa `rename to`+`create or replace` -ketjuun nojaavan tarkistuksen
  "sipuli" (heartbeat → price → tank → settings/plan/relay - ks.
  `20260813040000`...`20260813110000`). Kuudennen kerroksen lisääminen
  tälle jo nyt vaikeasti auditoitavalle, järjestelmän kriittisimmälle
  koodipolulle olisi oma, ei-triviaali muutos. Kevyempi vaihtoehto
  (ylimääräinen TypeScript-puolen uudelleenluku juuri ennen RPC-kutsua)
  harkittiin ja hylättiin: se olisi silti vain check-then-act eikä oikea
  transaktionaalinen CAS kuten muut snapshotit, joten se ei sulkisi ikkunaa
  kokonaan - vain kaventaisi sitä entisestään jo muutenkin häviävän pienestä.

Jos tämä joskus halutaan sulkea kokonaan, luontevin hetki on se, jos/kun
julkaisu-RPC:n sisäkkäinen tarkistusketju muutenkin refaktoroidaan yhdeksi
läpinäkyvämmäksi tarkistukseksi - ei yksinään tämän yhden riskin vuoksi.

Heartbeat ei yksin todista pg_cronin tai Edge Functionin olevan elossa. Jos
cron ei käynnistä funktiota tai funktio kaatuu ennen ensimmäistä state-kirjoitusta,
se ei voi kirjata omaa epäonnistumistaan; Shelly havaitsee tilanteen vasta
edellisen validoinnin 90 minuutin vanhenemisesta. Käynnistyksen jälkeen jäävä
`running`-tila on tarkoituksella unhealthy. Erillinen ulkoinen cron/deploy-
monitorointi tarvitaan edelleen ennen backend-primary-vaihetta.

**Deployment-gate:** Shellyn trust-gate (`BACKEND_PLAN_TRUST_ENABLED`) on
edelleen erillinen laitedeploy-päätös. Tämä backend-muutos ei muuta Shellyn
fallback-logiikkaa eikä minifioitua controlleria.

Rinnakkaiset ajot omistavat singletonin UUID `current_run_id` +
`current_run_started_at` -CAS-tokenilla. Uudempi aloitusaika syrjäyttää vanhemman,
ja lopetus-RPC päivittää rivin vain molempien arvojen täsmätessä. Siksi myöhään
valmistuva vanha ajo ei voi ylikirjoittaa uudemman ajon tulosta eikä julkaista
stale-plania. Onnistunut `published` ja `no_changes` tallentavat lisäksi
deterministisen identiteetin muodossa `YYYY-MM-DD|h1,h2,...`, jossa tunnit
deduplikoidaan ja järjestetään.

RPC:n boolean-paluuarvo on osa CAS-sopimusta: `begin = false` lopettaa
superseded-ajon ennen optimizer-putkea HTTP 409 -vastauksella, eikä singletonia
muuteta. `complete = false` säilyttää optimizerin diagnostisen vastauksen mutta
merkitsee siihen `heartbeat_committed: false` ja `heartbeat_status:
"superseded"`; vastaus ei siis väitä heartbeat-kirjoituksen onnistuneen.
Migraation lähdetesti ei aja PL/pgSQL:ää oikeaa PostgreSQL-instanssia vasten,
joten RPC:iden atomisuus ja oikeudet on validoitava staging-/tuotanto-Supabasessa
ennen deploymentia.

Kun heartbeat-omistajuus on saatu, pakollisten input-hakujen virheet,
shadow-rivin tallennusvirhe ja odottamattomat poikkeukset yrittävät aina päättää
ajon `unhealthy` / `run_error` -tilaan alkuperäisellä virhesyyllä. Jos tämä
complete-RPC epäonnistuu tai palauttaa `false`, ongelma lokitetaan mutta
alkuperäistä HTTP-virhettä ei peitetä. `false` tarkoittaa, että uudempi ajo
omistaa singletonin eikä vanha run_error saa muuttaa sen tilaa. Nykyinen testi
varmistaa tämän lähdekoodisopimuksena ja TypeScript-omistajuusmallina; se ei
suorita Edge Functionia ja RPC:tä oikeaa Supabase/PostgreSQL-instanssia vasten.
