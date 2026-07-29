# Ohjeet tekoälyavustajille (Claude, Codex, muut)

Tämä tiedosto on tarkoitettu tekoälyavustajille, jotka työskentelevät
EnergyZen-repossa. Ihmiskehittäjän vastaavat ohjeet ovat samassa
`docs/`-kansiossa.

## Perussäännöt

1. **Vastaa aina suomeksi**, ellei käyttäjä nimenomaisesti pyydä toista
   kieltä.
2. **Tutustu [`docs/PROJECT_CONTEXT.md`](./docs/PROJECT_CONTEXT.md)
   ennen suuria muutoksia** – se kuvaa sovelluksen tarkoituksen,
   arkkitehtuurin (Expo/React Native -sovellus, Supabase-backend, ESP32-
   ja Shelly-laitteisto, lämmitysoptimointi) ja tunnetut dokumentaatioaukot.
3. **Noudata [`docs/PROJECT_RULES.md`](./docs/PROJECT_RULES.md):tä**
   (ei suoria committeja mainiin, yksi ominaisuus = yksi PR, testit ennen
   mergeä, käytä olemassa olevia ratkaisuja, dokumentoi merkittävät
   muutokset).
4. **Käytä [`docs/DEVELOPMENT_WORKFLOW.md`](./docs/DEVELOPMENT_WORKFLOW.md):tä
   kehityksen pohjana** (branch-käytäntö, commit-tyyli, tyypillinen sykli).
5. **Älä tee suoria muutoksia main-haaraan.** Työskentele aina omalla
   branchilla ja vie muutokset PR:n kautta, ellei käyttäjä nimenomaisesti
   pyydä suoraa pushia.
6. **Tee pieniä PR:iä.** Yksi asiakokonaisuus per PR – älä yhdistä siihen
   liittymättömiä korjauksia samaan muutokseen.
7. **Suosi olemassa olevia arkkitehtuuriratkaisuja.** Tarkista ensin
   `lib/`-kansiosta, löytyykö vastaava logiikka jo olemassa, ennen kuin
   kirjoitat uutta apufunktiota tai duplikoit laskentaa.
8. **Päivitä dokumentaatio, jos muutat kehitystapaa**, julkaisuprosessia
   tai arkkitehtuuria – ks. `docs/PROJECT_RULES.md` kohta 5 mistä
   dokumentista mikäkin muutos kuuluu.

## Julkaisut

Ennen kuin julkaiset muutoksen (OTA vai uusi build), lue
[`docs/RELEASE_PROCESS.md`](./docs/RELEASE_PROCESS.md). Lyhyesti: pelkkä
JS/TS/tyyli/asset-muutos → OTA (`EAS Update`-workflow); mikä tahansa muutos
`app.json`:n natiivikonfiguraatioon, `eas.json`:iin tai natiiviriippuvuuksiin
→ uusi build (`Android Build`-workflow). Kumpikaan ei tapahdu automaattisesti
– molemmat käynnistetään erikseen GitHub Actionsista käyttäjän pyynnöstä.

## Muuta huomioitavaa

- `energiazen-mini/`-hakemistossa on oma `CLAUDE.md`/`AGENTS.md`, joka
  muistuttaa: Expo on muuttunut paljon, joten tarkista aina versioidut
  dokumentit (`docs.expo.dev/versions/v54.0.0/`) ennen Expo-koodin
  kirjoittamista. Tämä juuritason `CLAUDE.md` täydentää sitä, ei korvaa.
- Jos huomaat ristiriidan dokumentaation ja toteutuksen välillä, älä
  hiljaa "korjaa" dokumenttia piiloon – mainitse se PR:n kuvauksessa (ks.
  `docs/PROJECT_RULES.md`).
