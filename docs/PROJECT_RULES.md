# Projektin pelisäännöt

Nämä säännöt koskevat kaikkia EnergyZen-repoon tehtäviä muutoksia,
tekijästä riippumatta (ihminen, Claude, Codex tai muu agentti).

## 1. Ei suoria committeja mainiin

Kaikki muutokset tehdään branchilla ja viedään päähaaraan Pull Requestin
kautta (ks. `docs/DEVELOPMENT_WORKFLOW.md`). Poikkeus vain silloin, kun
käyttäjä nimenomaisesti pyytää suoraa pushia päähaaraan.

> Repon historiassa on suoria main-committeja/mergejä ennen tämän säännön
> kirjaamista (esim. `chore: install Codex automatically in Codespaces`,
> useita `Merge branch '...' into ...`-committeja) – ne edustavat
> vanhempaa käytäntöä, ei nykyistä sääntöä.

## 2. Yksi ominaisuus = yksi PR

Pidä PR:t pieninä ja keskittyneinä yhteen asiakokonaisuuteen. Älä yhdistä
toisiinsa liittymättömiä korjauksia samaan PR:ään – tämä pätee myös silloin,
kun huomaat sivussa jotain muuta korjattavaa: kirjaa se erikseen, älä korjaa
samassa PR:ssä ellei se ole välttämätön edellytys alkuperäiselle muutokselle.

## 3. Testit ennen mergeä

Aja ennen pushia/mergeä:

```bash
npx tsc --noEmit -p tsconfig.json
npm test
```

> **Tunnettu aukko:** tätä ei tällä hetkellä pakoteta automaattisesti –
> repossa ei ole CI-workflow'ta, joka ajaisi nämä komennot PR:ää vastaan
> (molemmat nykyiset GitHub Actions -workflow't, `EAS Update` ja
> `Android Build`, ovat manuaalisia julkaisutoimintoja, eivät testiportteja).
> Tämä sääntö on siis tällä hetkellä prosessi, ei tekninen pakote. Jos
> lisäät CI-testiportin, päivitä tämä kohta.

## 4. Käytä olemassa olevia ratkaisuja

Ennen uuden apufunktion tai laskentalogiikan kirjoittamista, tarkista
löytyykö vastaava jo `lib/`-kansiosta (esim. hintalaskenta
`electricityPrices.ts`:ssä, lämmitysoptimointi `heatingOptimizer.ts`:ssä,
historialaskenta `heatingHistory.ts`/`temperatureHistory*.ts`:ssä). Älä
duplikoi logiikkaa eri tiedostoihin – laajenna tai jaa olemassa olevaa
moduulia.

## 5. Dokumentoi merkittävät muutokset

Päivitä `README.md` ja/tai asiaankuuluva `docs/`-tiedosto, kun muutat:

- kehitysprosessia tai branch-käytäntöä → `docs/DEVELOPMENT_WORKFLOW.md`
- julkaisuprosessia, GitHub Actions -workflow'ja, `eas.json`/`app.json`:n
  julkaisuun liittyviä kenttiä → `docs/RELEASE_PROCESS.md`
- arkkitehtuuria, tietokantaskeemaa, laitteistointegraatiota → `docs/PROJECT_CONTEXT.md`
- itse tätä sääntölistaa → `docs/PROJECT_RULES.md`

Jos löydät ristiriidan dokumentaation ja toteutuksen välillä, älä hiljaa
korjaa dokumenttia niin että ristiriita katoaa jäljettömiin – mainitse se
PR:n kuvauksessa, jotta se voidaan tarkistaa.
