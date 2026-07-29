# Julkaisuprosessi

EnergyZenillä on kaksi tapaa viedä muutokset käyttäjien puhelimiin, molemmat
käynnistettävissä GitHubin selainkäyttöliittymästä ilman kotikonetta tai
Codespacesia. Molemmat ovat `workflow_dispatch`-tyyppisiä GitHub Actions
-workflow'ja ja käyttävät samaa `EXPO_TOKEN`-repository-secretiä sekä
`expo/expo-github-action`-actionia Expo-tilille kirjautumiseen.

## OTA Update GitHub Actionsilla

**Workflow:** `.github/workflows/eas-update.yml` ("EAS Update")

Julkaisee sovelluksen JS/asset-muutokset olemassa oleviin asennuksiin
`eas update`-komennolla, ilman uutta APK/AAB-julkaisua.

1. Avaa repon **Actions**-välilehti.
2. Valitse työnkulku **EAS Update**.
3. Paina **Run workflow**.
4. Valitse **branch** (`production`, `preview` tai `development` – vastaa
   `eas.json`:n build-profiilien `channel`-arvoja) ja halutessasi oma
   julkaisuviesti (tyhjänä käytetään viimeisimmän commitin viestiä).
5. Paina **Run workflow**.

Ajon **Summary**-välilehdellä näkyy julkaistun update-ryhmän tunnus
(`group`) ja linkit jokaisen alustan manifestiin, jos EAS palautti ne.

## Android Build GitHub Actionsilla

**Workflow:** `.github/workflows/eas-build-android.yml` ("Android Build")

Käynnistää uuden natiivin Android-buildin (`eas build --platform android`)
pilvipalvelimella.

1. Avaa repon **Actions**-välilehti.
2. Valitse työnkulku **Android Build**.
3. Paina **Run workflow**.
4. Valitse **profile** (`preview`, `production` tai `development` – vastaa
   `eas.json`:n build-profiileja). Alusta on tällä hetkellä kiinteästi
   Android.
5. Paina **Run workflow**.

Ajo odottaa buildin valmistumista (tyypillisesti n. 10-15 minuuttia).
**Summary**-välilehdellä näkyy: käytetty build profile, git commit, EAS:n
build ID, buildin tila, linkki Expo Dashboardin build-sivulle (josta löytyy
myös QR-koodi ja asennusohje puhelimelle) sekä suora latauslinkki, jos EAS
palautti sen.

## Milloin OTA riittää

OTA (`eas update`) riittää, kun muutos koskee **vain** JavaScriptiä/
TypeScriptiä, tyylejä tai assetteja – eikä mitään seuraavista ole muutettu:

- `app.json`:n `android`/`ios`/`androidNavigationBar`-lohkot tai muut
  natiivikonfiguraatiota ohjaavat kentät
- `eas.json`:n build-profiilit
- uudet tai poistetut riippuvuudet, joilla on natiivikoodia (esim. uusi
  Expo-moduuli)
- Expo SDK -versio

OTA on nopea (sekunneista minuutteihin) tapa saada muutos käyttäjille ilman
uutta kauppajulkaisua tai APK:n uudelleenasennusta.

## Milloin tarvitaan uusi Build

Uusi EAS Build tarvitaan aina, kun muutos vaikuttaa natiiviin binääriin.
Tästä repositoriosta löytyy jo konkreettinen esimerkki: Android-
navigointipalkin korjaus vaati kaksi erillistä muutosta, joista vain toinen
oli OTA-kelpoinen –

- `app/_layout.tsx`:n `SystemUI.setBackgroundColorAsync(...)`-kutsu on
  puhdasta JS:ää natiivimoduulia (`expo-system-ui`) vasten, joka oli jo
  linkitetty aiempaan buildiin → **julkaistiin OTA:na**.
- `app.json`:n `androidNavigationBar.enforceContrast: false` muuttaa
  prebuild-vaiheessa generoitavaa natiivia Android-teemaa
  (`styles.xml`:n `android:enforceNavigationBarContrast`) → **vaati uuden
  EAS Buildin**, koska `eas update` ei koskaan päivitä natiivia koodia tai
  natiivikonfiguraatiosta generoitua sisältöä.

Yleisemmin uusi build tarvitaan, kun jokin näistä muuttuu:

- `app.json`:n `android`/`ios`-lohkot, `androidNavigationBar`, pluginit
- `eas.json`
- natiivimoduulia sisältävä riippuvuus lisätään/poistetaan/päivitetään
- Expo SDK -versio

## EAS Channels

`app.json`:

- `runtimeVersion.policy: "appVersion"` – OTA-päivitys on yhteensopiva vain
  saman `version`-numeron (app.json) buildien kanssa.
- `updates.url` osoittaa projektin EAS Update -päätepisteeseen.

`eas.json`:n `build`-profiilit sitovat jokaisen buildin tiettyyn OTA-kanavaan
(`channel`), jolta se hakee OTA-päivityksiä:

| Profiili      | `channel`     | `distribution` | Muuta                        |
|---------------|---------------|-----------------|-------------------------------|
| `development` | `development` | `internal`      | `developmentClient: true`     |
| `preview`     | `preview`     | `internal`      | –                              |
| `production`  | `production`  | *(ei asetettu, oletus `store`)* | `autoIncrement: true` |

`EAS Update`-workflow'n `branch`-valinta ja `Android Build`-workflow'n
`profile`-valinta käyttävät samoja nimiä (`production`/`preview`/
`development`) tarkoituksella – valitse aina sama nimi molemmissa, jotta OTA
menee oikean buildin käyttäjille.

## Preview vs. Production

- **Preview** (`distribution: internal`): sisäinen jakelu testaajille. Build
  on suoraan asennettava APK, ladattavissa Expo Dashboardista tai
  `Android Build`-workflow'n Summary-näkymän linkistä ilman kaupan kautta
  kulkemista.
- **Production** (`autoIncrement: true`, oletus `distribution: store`):
  virallista/kauppajulkaisua varten. `autoIncrement` kasvattaa
  versiokoodia automaattisesti jokaisella buildilla. `eas.json`:ssa on myös
  `submit.production` -profiili kaupan submit-vaihetta varten, mutta tämä
  dokumentti ei kata submit-prosessia – sitä ei ole vielä ajettu/dokumentoitu
  tässä repossa.
- **Development**: `developmentClient: true` – development-buildiin asennettu
  Expo Dev Client, jota käytetään paikallisen kehityksen debug-buildina, ei
  loppukäyttäjille.
