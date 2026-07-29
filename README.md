# EnergyZen Mini

Pörssisähkön ja lämminvesivaraajan ohjaussovellus.

## Käynnistys Codespacesissa

Avaa terminaali ja siirry projektikansioon:

```bash
cd /workspaces/EnergiaZen/energiazen-mini
cd C:\Users\marko\EnergiaZen\energiazen-mini
```

Asenna riippuvuudet tarvittaessa:

```bash
npm install
npm.cmd install
```

Käynnistä Expo Go -palvelin:

```bash
npx expo start --host tunnel --clear
npx.cmd expo start
```

Odota että Metro Bundler käynnistyy.

Kun näet esimerkiksi:

```text
Using Expo Go
Android Bundled ...
```

sovellus on valmis käytettäväksi.

## Testaus puhelimella

1. Asenna Expo Go
2. Käynnistä projekti Codespacesissa
3. Avaa Expo Go
4. Valitse EnergyZen viimeisimmistä projekteista

Jos sovellus ei yhdisty:

```bash
Ctrl + C
npx expo start --host tunnel --clear
```

## Projektin päivitys

Hae uusimmat muutokset:

```bash
git pull
```

## OTA-päivitysten julkaisu (EAS Update GitHub Actionsista)

Sovelluksen voi päivittää käyttäjien puhelimiin ilman uutta APK/AAB-julkaisua
`eas update`-komennolla. Tämä onnistuu suoraan GitHubin selainkäyttöliittymästä
`.github/workflows/eas-update.yml`-workflow'lla — kotikonetta tai Codespacesia
ei tarvita.

### 1. Luo EXPO_TOKEN expo.dev:ssä

1. Kirjaudu osoitteeseen https://expo.dev/settings/access-tokens
2. Paina **Create token**
3. Anna tokenille kuvaava nimi (esim. `github-actions-energyzen`)
4. Kopioi luotu token talteen — se näytetään vain kerran

### 2. Lisää token GitHubin secretiksi

1. Avaa repo GitHubissa ja siirry **Settings → Secrets and variables → Actions**
2. Paina **New repository secret**
3. Nimeksi täsmälleen `EXPO_TOKEN`
4. Arvoksi äsken kopioitu token, ja tallenna

### 3. Käynnistä julkaisu Actions-välilehdeltä

1. Avaa repon **Actions**-välilehti
2. Valitse vasemmalta työnkulku **EAS Update**
3. Paina **Run workflow**
4. Valitse **branch** (`production`, `preview` tai `development` — vastaa
   `eas.json`:n build-kanavia) ja halutessasi kirjoita oma julkaisuviesti
   (tyhjänä käytetään viimeisimmän commitin viestiä)
5. Paina **Run workflow**

Ajon lopussa työnkulun **Summary**-välilehdellä (ja ajon lokissa) näkyy
julkaistun update-ryhmän tunnus (`group`) sekä linkit jokaisen alustan
manifestiin, jos EAS palautti ne.

## Tietolähteet

### Nykyinen sähkön hinta

https://api.spot-hinta.fi/JustNow?region=FI&priceResolution=60

### Päivän ja huomisen hinnat

https://api.spot-hinta.fi/TodayAndDayForward?region=FI

## Tulevat ominaisuudet

- ESP32 lämpötilamittaus
- Shelly-ohjaus
- Varaajan energiasisällön laskenta
- Suihkuja jäljellä -mittari
- Lämmityshistorian seuranta
- Android APK

## Huomioita

Codespaces voi sammua käyttämättömänä.

Jos Expo Go menettää yhteyden:

```bash
npx expo start --host tunnel --clear
```

käynnistää palvelimen uudelleen.