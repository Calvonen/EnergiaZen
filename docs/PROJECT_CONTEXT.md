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
Kaikki polut alla ovat suhteessa repositorion juureen.

### 1. Mobiilisovellus (`energiazen-mini/`)

- **Expo** (SDK 54) + **React Native** + **expo-router** (tiedostopohjainen
  reititys, `energiazen-mini/app/`-hakemisto). Katso
  `energiazen-mini/AGENTS.md`: Expo on muuttunut paljon, ja versioidut
  dokumentit (`docs.expo.dev/versions/v54.0.0/`) pitää tarkistaa ennen
  Expo-koodin kirjoittamista.
- Managed workflow: `android/`- ja `ios/`-natiivihakemistoja ei ole
  versionhallinnassa (`.gitignore`), ne generoidaan `expo prebuild`/EAS
  Buildin yhteydessä `app.json`:n ja `eas.json`:n perusteella.
- Kieli: TypeScript. UI-tekstit ja suuri osa kommenteista/committeista
  suomeksi, osa koodin sisäisistä kommenteista ja committeista englanniksi.
- Tila ja logiikka on eriytetty `energiazen-mini/lib/`-kansioon
  (yksikkötestattava, UI-riippumaton koodi) ja `energiazen-mini/app/`-kansion
  näkymiin (React-komponentit). Keskeisiä `lib/`-moduuleja:
  `heatingOptimizer.ts`, `heatingGain.ts`, `tankTemperatureForecast.ts`,
  `electricityPrices.ts`, `heatingHistory.ts`, `heatingPlanPublication.ts`,
  `temperatureHistory*.ts`.
- Autentikointi: Supabase Auth (`energiazen-mini/app/login.tsx`, istunto
  pysyy tallessa `energiazen-mini/app/_layout.tsx`:n auth-kuuntelijalla).

### 2. Supabase-backend

Postgres-tietokanta + Auth + Edge Functions + ajastettu `pg_cron`.
Projektin Supabase-sisältö on `energiazen-mini/supabase/`-hakemistossa
(`energiazen-mini/supabase/functions/`, `energiazen-mini/supabase/migrations/`) –
ei repon juuressa. Sovellus käyttää seuraavia tauluja (todettu
`supabase.from(...)`-kutsuista sovelluskoodissa):

- `electricity_prices` – sähkön spot-hinnat
- `heating_plans` – julkaistut/lasketut lämmityssuunnitelmat
- `heating_control_settings` – varaajan kalibrointi- ja ohjausasetukset
- `tank_readings` – ESP32:n lähettämät lämpötila- ja lämmitystilarivit
- `temperature_drop_profiles` – lasketut lämpötilan laskunopeusprofiilit
- `device_monitor_state` – yhden rivin tila jota
  `check-tank-monitor-health`-Edge Function käyttää (kohta 3b) tunnistaakseen
  terve→vanhentunut-tilasiirtymän eikä lähettääkseen samaa sähköpostihälytystä
  joka ajolla

> **Huom (dokumentoitu ristiriita):** `energiazen-mini/supabase/migrations/`
> -kansiosta löytyy vain `electricity_prices`- ja
> `temperature_drop_profiles`-taulujen luontimigraatiot. `heating_plans`-,
> `heating_control_settings`- ja `tank_readings`-tauluille on migraatioissa
> vain myöhempiä `alter table`-muutoksia (esim.
> `20260726000000_add_heating_control_calibration_settings.sql`), ei
> alkuperäistä `create table`-lausetta. Nämä taulut on siis luotu suoraan
> Supabase Studiossa/SQL Editorissa ennen kuin migraatioseurantaa otettiin
> käyttöön kattavasti, eikä niiden täyttä skeemaa ole tällä hetkellä
> versionhallinnassa. Tämä kannattaa korjata (esim. `supabase db diff` /
> `db dump --schema-only` ja lisäämällä puuttuvat luontimigraatiot).

### 3. Hintadata

Edge Function `energiazen-mini/supabase/functions/fetch-electricity-prices`
hakee [Spot-hinta.fi](https://api.spot-hinta.fi/JustNow?region=FI&priceResolution=60)
-palvelusta Suomen (`FI`) sähkön hinnat, oletuksena 60 minuutin resoluutiolla
(vaihdettavissa 15 minuuttiin secretillä `PRICE_RESOLUTION_MINUTES`), ja
tallentaa ne `electricity_prices`-tauluun. Haku on ajastettu `pg_cron`-jobilla
(`fetch-electricity-prices-hourly`) kerran tunnissa minuutilla 10 (migraatio
`energiazen-mini/supabase/migrations/20260724020000_schedule_electricity_price_fetch.sql`).
Katso `energiazen-mini/README.md` ajastuksen ja Edge Functionin täydet
ohjeet.

### 3b. Varaajan mittausvian sähköpostihälytys

Edge Function
`energiazen-mini/supabase/functions/check-tank-monitor-health` tarkistaa
5 minuutin välein (`pg_cron`-jobi
`check-tank-monitor-health-every-5-minutes`) onko `tank_readings`-taulun
tuorein rivi yli 30 minuuttia vanha. Kynnys on määritelty kahdessa
paikassa jotka pitää pitää synkassa: `alertLogic.ts`:n
`staleReadingAlertThresholdMinutes` (Edge Function) ja
`energiazen-mini/lib/tankMonitorAlert.ts`:n
`tankMonitorAlertThresholdMinutes` (etusivun virhebanneri, joka lasketaan
suoraan appissa jo haetusta `tankUpdatedAt`-arvosta, ei tästä taulusta).
Sähköposti lähtee [Resendillä](https://resend.com) vain terve→vanhentunut
-tilasiirtymässä (`device_monitor_state`-taulu estää toiston), vastaanottajat
haetaan Supabase Authista (`supabase.auth.admin.listUsers()`) - appiin
kirjautuneen käyttäjän sähköposti toimii siis myös hälytysosoitteena, sitä
ei kovakoodata. Palautumisesta ei lähetetä erillistä sähköpostia, koska
etusivun banneri katoaa automaattisesti heti kun tuore mittaus saapuu.
Katso `energiazen-mini/README.md` täydet ohjeet (secretin asetus, deploy,
migraatio).

### 4. Laitteisto: ESP32 + Shelly

- **ESP32** (`esp32/energiazen_tank_monitor/energiazen_tank_monitor.ino`):
  itsenäinen mittalaite. Kaksi pakollista DS18B20-lämpötila-anturia
  (varaajan ylä- ja alaosa) sekä yksi valinnainen DS18B20 tuloveden
  lämpötilalle, kaikki samassa OneWire-väylässä (GPIO4), sekä 1.3" SH1106
  I2C OLED -näyttö. Anturit tunnistetaan niiden yksilöllisillä 64-bittisillä
  ROM-osoitteilla (`TOP_SENSOR_ADDRESS`/`BOTTOM_SENSOR_ADDRESS`/
  `INLET_SENSOR_ADDRESS` .ino-tiedoston alussa), ei väylän skannausjärjes-
  tyksellä, koska järjestys ei ole taattu pysymään samana. Osoitteiden
  selvitys: flashaa oletusarvoisilla (nolla) osoitteilla, avaa sarjaportti
  115200 baudilla ja lue käynnistyksessä tulostettava laitelista (jokaisen
  löydetyn anturin ROM-osoite + sille päätelty rooli), kopioi osoitteet
  oikeisiin vakioihin ja flashaa uudelleen. Niin kauan kuin pakollinen
  `TOP_SENSOR_ADDRESS` tai `BOTTOM_SENSOR_ADDRESS` on määrittämättä, laite
  pysyy määritystilassa (OLED "SETUP MODE", jatkuva laitelistan tulostus
  sarjaporttiin) eikä lähetä mitään Supabaseen eikä käynnistä anturi-
  watchdogin uudelleenkäynnistyslogiikkaa. Tulovesianturi on valinnainen:
  jos `INLET_SENSOR_ADDRESS` on nolla tai lukema on virheellinen, laite
  toimii normaalisti pelkillä ylä-/ala-antureilla ja lähettää `inlet_temp`-
  kentän arvolla `null`. Laite lukee lämpötilat 5 sekunnin välein ja
  lähettää ne Supabaseen (`tank_readings`-taulun REST-rajapintaan, kentät
  `top_temp`, `bottom_temp`, `inlet_temp`, `showers`, `heating`) 60
  sekunnin välein. Laite kysyy myös paikallisverkosta Shellyn RPC-
  statusrajapinnasta (`Switch.GetStatus`) tämänhetkisen lämmitysreleen
  tilan ja tallentaa sen `heating`-kenttään – **ESP32 ei ohjaa Shellyä**,
  se ainoastaan lukee ja raportoi sen tilan.
- **Shelly-ohjain** (`energiazen-mini/shelly/energyzen-controller.js`, sekä
  minifioitu `energyzen-controller.min.js` laitteelle vietäväksi ja
  yksikkötestit `energyzen-controller.test.js`): tämä on Shellyn oma
  Gen2+-skriptausrajapinnan (`Shelly.call`, `Script.storage`, `Timer.set`)
  varaan kirjoitettu JavaScript-ohjelma, joka **ajetaan suoraan Shelly-
  laitteella**, ei sovelluksessa tai Supabasessa. Se on täysin tässä
  repossa – aiempi versio tästä dokumentista väitti virheellisesti, ettei
  Shellyn puoleista logiikkaa löydy repositoriosta.
  - Ajastimella kerran minuutissa (`CHECK_INTERVAL_MS`): hakee
    `heating_control_settings`-rivin (`backup_hours`, `fallback_enabled`,
    `heating_need_mode`) ja `heating_plans`-taulusta kuluvan päivän
    `planned_hours`-listan suoraan Supabasen REST-rajapinnasta, sekä
    tuoreimman `tank_readings`-rivin anturidatan tuoreuden/kelvollisuuden
    tarkistamiseksi (ks. alla). `backup_hours`/`fallback_enabled`
    välimuistoidaan laitteen omaan `Script.storage`:en
    (`hasStoredFallback`-lippu erottaa aidon aiemman synkan pelkistä
    oletusarvoista), jotta ohjaus toimii myös hetkellisen
    verkko-/Supabase-katkon yli.
    **Backend on ainoa lämmityspäätöksen tekijä normaalilla, luotetulla
    suunnitellulla tunnilla** – Shelly ei enää laske paikallisesti
    täyttöastetta/suihkumäärää eikä kalibrointia (poistettu, ks. alla),
    eikä vaadi edes tuoretta/validia `tank_readings`-lukemaa: kun
    `resolveTrustedPlanControl`/`applyControlPlaneDebounce` on jo
    varmistanut tunnin olevan backendin oman, heartbeat-vahvistetun
    suunnitelman mukainen (`control.source === "energyzen"`, kulkee
    `decideHeating`:lle `planSource`-kenttänä), rele kytketään päälle
    ehdoitta (`reason: "planned-heating"`) riippumatta siitä onko
    tuorein lukema puuttuva, vanhentunut vai virheellinen. Tank-readingin
    tuoreus/kelvollisuus tarkistetaan enää `backup_hours`-varapolulla
    (ks. alla) – ei enää normaalin, luotetun suunnitelman hyväksyntään.
    Mikä tahansa AITO ylävirran vikatila (rele/laiteaika/asetukset/
    suunnitelman haku/heartbeat – `failSafeReason`) pysäyttää lämmityksen
    edelleen, vaikka tunti sattuisi olemaan suunniteltu – luottamus koskee
    vain `decideHeating`:n itse laskemia lukemakohtaisia tarkistuksia, ei
    ylävirran infrastruktuurivikoja. Poikkeus: itse `tank_readings`-REST-
    haun epäonnistuminen (`fetchLatestReading`) kulkee `decideHeating`:lle
    omana `readingFetchError`-kenttänään, EI `failSafeReason`ina – tämä on
    tarkoituksellista, koska muuten pelkkä Shellyn oma hetkellinen
    Supabase-katko olisi voinut estää muuten heartbeat-vahvistetun
    suunnitelman lämmityksen. Luotetulla suunnitellulla tunnilla
    `readingFetchError` siis ohitetaan aivan kuten puuttuva/vanhentunut/
    virheellinen lukemakin; `backup_hours`-varapolulla se sen sijaan
    lasketaan yhä samaan `"reading-fetch-error"`-datavikasyyhyn ja
    kolmen kierroksen debounssiin kuin ennenkin (ks. alla).
  - Jos päivän suunnitelmaa ei saada haettua (verkkovirhe, puuttuva rivi tai
    väärä `plan_date`) tai backendin heartbeat ei ole luotettava **ja**
    fallback on käytössä, käytetään Supabasesta/välimuistista luettua
    `backup_hours`-tuntilistaa – tämä ei ole sovelluksen koodiin
    kovakoodattu lista, vaan konfiguroitava, tietokannassa asuva arvo.
    Myös tämä control-plane-fallback (`resolvePlanControl`/
    `resolveTrustedPlanControl`, tulos `source: "backup"`) on debounssattu
    `applyControlPlaneDebounce`-funktiolla samalla periaatteella kuin
    alla kuvattu anturi-/datavikaohitus: yksittäinen transientti plan- tai
    heartbeat-haun häiriö (esim. hetkellinen Wi-Fi-katko) ei enää yksinään
    saa ottaa `backup_hours`-listaa käyttöön ohjaukseen (`source:
    "backup-pending"`, `plannedHours: []` sillä kierroksella) - vasta
    kolmas PERÄKKÄINEN tällainen kierros sallii sen
    (`REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES`). Yksikin sitä ennen
    onnistunut, luotettu `source: "energyzen"`-kierros nollaa laskurin
    heti, eikä normaalia EnergyZen-suunnitelman mukaista lämmitystä
    koskaan viivytetä tällä. Tämä on eri, itsenäinen laskuri kuin alla
    kuvattu tank-reading-datavikalaskuri - molemmat näkyvät erikseen
    Shellyn lokissa (`consecutiveControlPlaneUnreliableCycles` vs.
    `consecutiveUnreliableCycles`).
  - Kytkee releen (`Switch.Set`, `id = 0`) päälle/pois suunniteltujen
    tuntien perusteella, sisältäen lukeman vanhenemistarkistuksen
    (`MAX_READING_AGE_SECONDS = 120`). **Tämä kahden minuutin ohjausraja on
    tarkoituksella eri asia kuin appin ja monitorointifunktion 30 minuutin
    käyttäjähälytysraja:** Shelly tarkistaa tilanteen kerran minuutissa ja
    lakkaa luottamasta reaaliaikaiseen ohjausdataan nopeasti, jotta yhden
    tunnin varatunti ei ehdi kulua suurelta osin ennen fallbackia. Lyhyt
    katko voi siis käynnistää paikallisen varatoiminnan ilman
    käyttäjähälytystä. Arvoa 120 ei pidä synkronoida 30 minuutin
    hälytysrajan kanssa.
  - **Poistettu (backend-primary-arkkitehtuurin myötä tarpeettomaksi
    jäänyt paikallinen heuristiikka):** aiemmin Shelly laski itse
    suihkuvarausarvion (`fullTankShowers`/`fullTankAverageTemperature`/
    `minTankTemperature`/`maxTankTemperature`/`targetShowerReserve`-
    kalibroinnista ja tuoreimmasta lukemasta) ja käytti sitä 92 %
    täyttöasterajana (`START_HEATING_FILL_RATIO`) päättämään KESKEN
    suunnitellun tunnin pitäisikö lämmitys jo lopettaa/olla aloittamatta
    (`REQUIRED_BLOCKING_READINGS`-värähtelyn esto). Tämä oli suora
    duplikaatti backendin `heatingOptimizer`-laskennasta, joka jo ottaa
    kalibroinnin huomioon `planned_hours`-listaa muodostaessaan, ja saattoi
    jopa estää backendin suunnitteleman lämmityksen paikallisen laskennan
    perusteella. Poistettu kokonaan yhdessä siihen liittyvän
    kalibrointivalidoinnin (`isValidCalibration`, `"invalid-calibration"`-
    syy) ja kalibrointikenttien Shelly-puoleisen haun/välimuistituksen
    kanssa – nämä samat `heating_control_settings`-sarakkeet pysyvät
    edelleen käytössä backendissä, vain Shellyn paikallinen kopio/
    uudelleenlasku poistui.
  - **`backup_hours`-varapolulla anturi-/datavika ohittaa lukeman
    validoinnin kokonaan, mutta vasta kolmannen PERÄKKÄISEN
    epäluotettavan kierroksen jälkeen.** Tämä koskee vain tuntia, joka EI
    ole backendin oma luotettu suunnitelma (`planSource !== "energyzen"` -
    esim. `control-plane`-fallbackin adoptoima `backup_hours`-lista, ks.
    yllä; luotettu suunniteltu tunti ohittaa koko tämän tarkistuksen jo
    yllä kuvatulla tavalla). Jos mittausdataa ei voi luottaa (vanha/
    puuttuva/virheellinen `tank_readings`-lukema, tai sen haku
    epäonnistuu) mutta kuluva tunti on silti `backup_hours`-listalla eikä
    fallback ole pois päältä, ohjain kasvattaa laitteen omassa tilassa
    asuvaa `consecutiveUnreliableCycles`-laskuria. Vasta kun laskuri
    saavuttaa
    kynnyksen (`REQUIRED_UNRELIABLE_CYCLES = 3`), rele kytketään päälle
    ehdoitta (`reason: "backup-fault-override"`) - ei lasketa täyttöastetta,
    koska sitä ei voi luottavasti laskea ilman lukemaa. Yksi hetkellinen
    epäluotettava kierros (esim. lyhyt Wi-Fi-katko) ei siis enää yksinään
    käynnistä varatuntilämmitystä sokeasti; yksikin sitä ennen tuleva
    luotettava kierros nollaa laskurin heti. Laskuri kasvaa vain silloin kun
    ollaan varatunnilla eikä fallback ole pois päältä - muilla tunneilla
    epäluotettava kierros ei koskaan käynnistä lämmitystä eikä kartuta
    laskuria. Kolmannen kierroksen jälkeen tämä on tietoinen valinta:
    varaajan oma mekaaninen ylikuumenemissuoja (termostaatti) on todellinen
    turvaraja, joten ohjelmisto suosii "lämmitä varmuuden vuoksi"
    -oletusta "älä lämmitä epävarmuuden vuoksi" -oletuksen sijaan silloin
    kun katko on aidosti pitkittynyt. Muut vikatilat (esim.
    `hour-not-planned`, releen oman tilan kysely epäonnistuu) eivät kuulu
    tähän ohitukseen eivätkä kartuta laskuria.
  - **Mitä jää silti versionhallinnan ulkopuolelle:** Shellyn WiFi-
    verkkoasetukset (laitteen oma ensiasennus), sekä itse
    käyttöönotto/päivitys – `energyzen-controller.min.js`:n vieminen
    fyysiselle Shelly-laitteelle tehdään manuaalisesti Shellyn
    web-/mobiilikäyttöliittymän kautta; repossa ei ole automatisoitua
    deploy-skriptiä tälle, eikä varmuutta siitä, että laitteella ajossa
    oleva versio on aina commitin mukainen.

### 5. Lämmitysoptimointi

`energiazen-mini/lib/heatingOptimizer.ts` valitsee halvimmat sähkön tunnit
annetusta hintadatasta, huomioiden:

- varaajan lämpötilaennuste (`energiazen-mini/lib/tankTemperatureForecast.ts`,
  lämpötilan laskunopeusprofiilit `temperature_drop_profiles`-taulusta)
- lämmitystehon arvio (`energiazen-mini/lib/heatingGain.ts`)
- käyttäjän asettama suihkuvaraus (`targetShowerReserve`,
  `safetyShowerReserve`) ja maksimilämmitystuntien raja
- kalibroidut varaajan raja-arvot (`heating_control_settings`: min/max-
  lämpötilat, täyden varaajan suihkumäärä ja painotettu lämpötila)

Laskettu suunnitelma julkaistaan Supabaseen
`energiazen-mini/lib/heatingPlanPublication.ts`:n kautta (`heating_plans`-
taulu), josta Shelly-ohjain (kohta 4) lukee sen. Sovellus tukee myös
erillistä "scenario"-tilaa (`energiazen-mini/lib/settingsScenarioContext.tsx`,
`draftSettings` vs. `activeSettings`
`energiazen-mini/app/(tabs)/index.tsx`:ssä), jossa
käyttäjä voi kokeilla asetusmuutoksia julkaisematta niitä – vain aktiiviset
(persistoidut) asetukset vaikuttavat oikeaan lämmitykseen.

### 6. Varaajan seuranta ja historia

`energiazen-mini/app/(tabs)/index.tsx` (koti-näkymä),
`energiazen-mini/app/history.tsx` (lämpötilahistoria) ja
`energiazen-mini/app/electricity-history.tsx` (sähkön hinta- ja
lämmityshistoria) näyttävät toteutuneen datan. Historialaskenta hakee dataa
suoraan Supabasen RPC-funktioista
(`energiazen-mini/supabase/migrations/20260724030000_add_history_performance_rpcs.sql`
ja myöhemmät korjaukset) suorituskyvyn vuoksi.

`energiazen-mini/app/history.tsx`:ssä on lisäksi tulovesianturin
viikoittainen trendikäyrä, yksi piste per viikko, kiinteissä
kalenterivuosineljänneksissä (tammi-maalis, huhti-kesä, heinä-syys,
loka-joulu - esim. "Heinä–syyskuu 2026") joita voi selata taaksepäin
‹ › -nuolilla, samaan tapaan kuin päivähistorian selain. Kosketus/veto
kaaviossa näyttää tooltipin viikon koko päivämääräalueesta ja lukemasta.
Jaksojen rajat laskee `energiazen-mini/lib/inletTemperatureTrend.ts`:n
`getInletTrendPeriod`.
Datan laskee `get_weekly_minimum_inlet_temperature`-RPC
(`energiazen-mini/supabase/migrations/20260803000000_add_weekly_minimum_inlet_temperature_rpc.sql`),
joka käyttää samaa "vahvistetun minimin" periaatetta kuin
`energiazen-mini/lib/inletTemperature.ts`:n
`calculateMinimumValidInletTemperature` (yksittäistä lukemaa ei luoteta
ellei toinen kelvollinen lukema samalta viikolta vahvista sitä).
`inlet_temp`-sarake lisättiin `tank_readings`-tauluun vasta 1.8.2026, joten
kuluva jakso täyttyy vasta ajan myötä.

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
`energiazen-mini/lib/`-kansiossa: optimointi, hintalogiikka, historialaskenta,
asetusten validointi jne.). Tyyppitarkistus erikseen: `npx tsc --noEmit`.
Shelly-ohjaimella on oma testinsä, joka ei ole osa `npm test`:iä:

```bash
node energiazen-mini/shelly/energyzen-controller.test.js
```

**Tällä hetkellä ei ole automaattista CI-työnkulkua, joka ajaisi nämä
PR:ää vastaan** – testien ajaminen ennen mergeä on tällä hetkellä
prosessi, ei tekninen pakote (ks. [`docs/PROJECT_RULES.md`](./PROJECT_RULES.md)).
