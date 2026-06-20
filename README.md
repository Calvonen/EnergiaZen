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