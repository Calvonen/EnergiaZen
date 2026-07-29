# EnergyZen – projektin konteksti

Tämän dokumentin tarkoitus on auttaa uutta kehittäjää tai tekoälyä
ymmärtämään EnergyZen-projekti nopeasti, ilman että asioita tarvitsee kysyä
aiemmasta keskusteluhistoriasta. Sisältö on kirjoitettu tutkimalla nykyistä
repositoriota – ei oletuksia.

## Sovelluksen tarkoitus

EnergyZen on pörssisähkön ja lämminvesivaraajan älykäs ohjaussovellus.
Se optimoi varaajan lämmityksen ajoittumaan sähkön halvimmille tunneille,
seuraa varaajan lämpötilaa reaaliajassa erillisen laitteiston kautta, ja
näyttää käyttäjälle sähkön hinta- ja lämmityshistorian mobiilisovelluksessa.

## Tekninen arkkitehtuuri

Järjestelmä koostuu neljästä osasta: mobiilisovellus, Supabase-backend,
lämpötilaa mittaava ESP32-laite ja varaajaa fyysisesti ohjaava Shelly-rele.

### 1. Mobiilisovellus (`energiazen-mini/`)

- **Expo** (SDK 54) + **React Native** + **expo-router** (tiedostopohjainen
  reititys, `app/`-hakemisto). Katso `energiazen-mini/AGENTS.md`: Expo on
  muuttunut paljon, ja versioidut dokumentit (`docs.expo.dev/versions/v54.0.0/`)
  pitää tarkistaa ennen Expo-koodin kirjoittamista.
- Managed workflow: `android/`- ja `ios/`-natiivihakemistoja ei ole
  versionhallinnassa (`.gitignore`), ne generoidaan `expo prebuild`/EAS
  Buildin yhteydessä `app.json`:n ja `eas.json`:n perusteella.
- Kieli: TypeScript. UI-tekstit ja suuri osa kommenteista/committeista
  suomeksi, osa koodin sisäisistä kommenteista ja committeista englanniksi.
- Tila ja logiikka on eriytetty `lib/`-kansioon (yksikkötestattava,
  UI-riippumaton koodi) ja `app/`-kansion näkymiin (React-komponentit).
  Keskeisiä `lib/`-moduuleja: `heatingOptimizer.ts`, `heatingGain.ts`,
  `tankTemperatureForecast.ts`, `electricityPrices.ts`, `heatingHistory.ts`,
  `heatingPlanPublication.ts`, `temperatureHistory*.ts`.
- Autentikointi: Supabase Auth (`app/login.tsx`, istunto pysyy tallessa
  `app/_layout.tsx`:n auth-kuuntelijalla).

### 2. Supabase-backend

Postgres-tietokanta + Auth + Edge Functions + ajastettu `pg_cron`. Sovellus
käyttää seuraavia tauluja (todettu `supabase.from(...)`-kutsuista
sovelluskoodissa):

- `electricity_prices` – sähkön spot-hinnat
- `heating_plans` – julkaistut/lasketut lämmityssuunnitelmat
- `heating_control_settings` – varaajan kalibrointi- ja ohjausasetukset
- `tank_readings` – ESP32:n lähettämät lämpötila- ja lämmitystilarivit
- `temperature_drop_profiles` – lasketut lämpötilan laskunopeusprofiilit

> **Huom (dokumentoitu ristiriita):** `supabase/migrations/`-kansiosta
> löytyy vain `electricity_prices`- ja `temperature_drop_profiles`-taulujen
> luontimigraatiot. `heating_plans`-, `heating_control_settings`- ja
> `tank_readings`-tauluille on migraatioissa vain myöhempiä `alter table`
> -muutoksia (esim. `20260726000000_add_heating_control_calibration_settings.sql`),
> ei alkuperäistä `create table`-lausetta. Nämä taulut on siis luotu suoraan
> Supabase Studiossa/SQL Editorissa ennen kuin migraatioseurantaa otettiin
> käyttöön kattavasti, eikä niiden täyttä skeemaa ole tällä hetkellä
> versionhallinnassa. Tämä kannattaa korjata (esim. `supabase db diff` /
> `db dump --schema-only` ja lisäämällä puuttuvat luontimigraatiot).

### 3. Hintadata

Edge Function `supabase/functions/fetch-electricity-prices` hakee
[Spot-hinta.fi](https://api.spot-hinta.fi/JustNow?region=FI&priceResolution=60)
-palvelusta Suomen (`FI`) sähkön hinnat, oletuksena 60 minuutin resoluutiolla
(vaihdettavissa 15 minuuttiin secretillä `PRICE_RESOLUTION_MINUTES`), ja
tallentaa ne `electricity_prices`-tauluun. Haku on ajastettu `pg_cron`-jobilla
(`fetch-electricity-prices-hourly`) kerran tunnissa minuutilla 10
(migraatio `20260724020000_schedule_electricity_price_fetch.sql`). Katso
`energiazen-mini/README.md` ajastuksen ja Edge Functionin täydet ohjeet.

### 4. Laitteisto: ESP32 + Shelly

- **ESP32** (`esp32/energiazen_tank_monitor/energiazen_tank_monitor.ino`):
  itsenäinen mittalaite. Kaksi DS18B20-lämpötila-anturia (varaajan ylä- ja
  alaosa, GPIO4) sekä 1.3" SH1106 I2C OLED -näyttö. Lukee lämpötilat 5
  sekunnin välein ja lähettää ne Supabaseen (`tank_readings`-taulun REST-
  rajapintaan) 60 sekunnin välein. Laite kysyy myös paikallisverkosta
  Shellyn RPC-statusrajapinnasta (`Switch.GetStatus`) tämänhetkisen
  lämmitysreleen tilan ja tallentaa sen `heating`-kenttään – **ESP32 ei
  ohjaa Shellyä**, se ainoastaan lukee ja raportoi sen tilan.
- **Shelly** (älyrele): kytkee fyysisesti varaajan vastuksen päälle/pois.
  Sovelluksen asetuksissa (`app/settings.tsx`) on kiinteä varatuntilista,
  jota Shellyn kuvataan käyttävän, "jos päivän EnergyZen-suunnitelmaa ei
  saada haettua" – tämä viittaa siihen, että Shelly hakee lämmityssuunnitelman
  itsenäisesti (oletettavasti `heating_plans`-taulusta tai sitä välittävästä
  rajapinnasta) ja kytkeytyy sen mukaan, käyttäen kiinteää tuntilistaa
  varajärjestelmänä. **Tarkkaa Shellyn puoleista integraatiota (esim. Shellyn
  oma skripti tai ajastus) ei löydy tästä repositoriosta** – se elää laitteen
  omassa, versionhallinnan ulkopuolisessa konfiguraatiossa. Tämä on
  dokumentoitu tunnettuna aukkona, ei arvaus.

### 5. Lämmitysoptimointi

`lib/heatingOptimizer.ts` valitsee halvimmat sähkön tunnit annetusta
hintadatasta, huomioiden:

- varaajan lämpötilaennuste (`lib/tankTemperatureForecast.ts`,
  lämpötilan laskunopeusprofiilit `temperature_drop_profiles`-taulusta)
- lämmitystehon arvio (`lib/heatingGain.ts`)
- käyttäjän asettama suihkuvaraus (`targetShowerReserve`,
  `safetyShowerReserve`) ja maksimilämmitystuntien raja
- kalibroidut varaajan raja-arvot (`heating_control_settings`: min/max-
  lämpötilat, täyden varaajan suihkumäärä ja painotettu lämpötila)

Laskettu suunnitelma julkaistaan Supabaseen `lib/heatingPlanPublication.ts`:n
kautta (`heating_plans`-taulu). Sovellus tukee myös erillistä "scenario"-tilaa
(`lib/settingsScenarioContext.tsx`, `draftSettings` vs. `activeSettings`
`app/(tabs)/index.tsx`:ssä), jossa käyttäjä voi kokeilla asetusmuutoksia
julkaisematta niitä – vain aktiiviset (persistoidut) asetukset vaikuttavat
oikeaan lämmitykseen.

### 6. Varaajan seuranta ja historia

`app/(tabs)/index.tsx` (koti-näkymä), `app/history.tsx` (lämpötilahistoria)
ja `app/electricity-history.tsx` (sähkön hinta- ja lämmityshistoria)
näyttävät toteutuneen datan. Historialaskenta hakee dataa suoraan Supabasen
RPC-funktioista (`supabase/migrations/20260724030000_add_history_performance_rpcs.sql`
ja myöhemmät korjaukset) suorituskyvyn vuoksi.

### 7. CI/CD: GitHub Actions

Kaksi `workflow_dispatch`-workflow'ta (ei automaattista ajoa pushissa/PR:ssä):

- **EAS Update** (`.github/workflows/eas-update.yml`) – julkaisee
  OTA-päivityksen (`eas update`) valitulle kanavalle.
- **Android Build** (`.github/workflows/eas-build-android.yml`) – käynnistää
  uuden natiivin Android-buildin (`eas build`) valitulla profiililla.

Molemmat käyttävät samaa `EXPO_TOKEN`-repository-secretiä ja
`expo/expo-github-action`-actionia kirjautumiseen. Täysi kuvaus:
[`docs/RELEASE_PROCESS.md`](./RELEASE_PROCESS.md).

## Testaus

`npm test` (`energiazen-mini/`-hakemistossa) kääntää ja ajaa
Node-pohjaiset yksikkötestit (co-located `*.test.ts`-tiedostot
`lib/`-kansiossa: optimointi, hintalogiikka, historialaskenta,
asetusten validointi jne.). Tyyppitarkistus erikseen: `npx tsc --noEmit`.
**Tällä hetkellä ei ole automaattista CI-työnkulkua, joka ajaisi nämä
PR:ää vastaan** – testien ajaminen ennen mergeä on tällä hetkellä
prosessi, ei tekninen pakote (ks. [`docs/PROJECT_RULES.md`](./PROJECT_RULES.md)).
