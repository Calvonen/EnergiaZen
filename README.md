# EnergiaZen Mini

Pörssisähkön ja lämminvesivaraajan ohjaussovellus.

## Käynnistys Codespacesissa

Siirry projektikansioon:

```bash
cd /workspaces/EnergiaZen/energiazen-mini
```

Asenna riippuvuudet tarvittaessa:

```bash
npm install
```

Käynnistä Expo:

```bash
npx expo start --clear
```

Tai käytä pikakomentoa:

```bash
zen
```

## Testaus puhelimella

1. Avaa Expo Go
2. Käynnistä projekti Codespacesissa
3. Skannaa QR-koodi
4. Sovellus latautuu puhelimeen

## Tietolähteet

### Sähkön hinta

Nykyinen tuntihinta:

```text
https://api.spot-hinta.fi/JustNow?region=FI&priceResolution=60
```

### Päivän hinnat

```text
https://api.spot-hinta.fi/TodayAndDayForward?region=FI
```

## Tulevat ominaisuudet

- ESP32 lämpötilamittaus
- Shelly-ohjaus
- Varaajan energiasisällön laskenta
- "Suihkuja jäljellä" -mittari
- Lämmityshistorian seuranta
- APK-julkaisu Androidille

## Git

Päivitä projekti:

```bash
git pull
```

Tallenna muutokset:

```bash
git add .
git commit -m "Kuvaus muutoksista"
git push
```