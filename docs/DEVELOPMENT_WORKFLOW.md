# Kehitysprosessi

Tämä dokumentti kuvaa, miten EnergyZen-projektissa oikeasti tehdään töitä
tällä hetkellä. Sisältö perustuu repositorion todelliseen commit- ja
PR-historiaan, ei oletuksiin.

## Päivän aloitusrutiini

1. **Git pull ennen työn aloittamista** – hae aina uusimmat muutokset
   päähaarasta ennen kuin aloitat:

   ```bash
   cd energiazen-mini   # tai vastaava projektihakemisto
   git pull
   ```

2. Asenna riippuvuudet, jos `package-lock.json` on muuttunut tai
   `node_modules` puuttuu:

   ```bash
   npm install
   ```

3. Käynnistä kehityspalvelin. Codespacesissa (README.md:n mukainen
   nykyinen tapa):

   ```bash
   npx expo start --host tunnel --clear
   ```

   Paikallisesti riittää yleensä:

   ```bash
   npx expo start
   ```

4. Odota, että Metro Bundler käynnistyy, ja testaa laitteella Expo Go
   -sovelluksella (ks. README.md:n "Testaus puhelimella").

## Branch-käytäntö

Repon PR-historia näyttää kaksi käytössä olevaa branch-nimeämiskäytäntöä:

- **`codex/<lyhyt-kuvaus-suomeksi>`** – Codex-agentin tekemät muutokset,
  esim. `codex/korjaa-lampohistorian-datan-haku`,
  `codex/lisaa-spot-hintojen-tallennus-supabeseen`.
- **`claude/<slug>`** – Claude Code -istuntojen tekemät muutokset, esim.
  `claude/project-rewrite-estimate-g90yiu`.
- Ihmiskehittäjän omat branchit, esim. `fix/scenario-integration`,
  `fix/heating-planner-stability`.

Uusi branch aina **päähaarasta** (`main`), ei toisesta feature-branchista,
ellei muutos nimenomaan jatka keskeneräistä työtä samalla branchilla.

### Milloin aloitetaan uusi branch

- Aina kun uusi, itsenäinen tehtävä tai korjaus aloitetaan.
- Jos edellisen tehtävän PR on jo mergetty päähaaraan, **älä jatka
  committeja vanhalle branchille** – hae päähaaran uusin tila ja aloita
  uusi branch siitä. Vanhan, jo mergetyn branchin päälle committoiminen
  tuottaa historian, joka ei enää vastaa mitään avointa PR:ää.
- Yksi branch = yksi asiakokonaisuus (ks. `docs/PROJECT_RULES.md`:
  "yksi ominaisuus = yksi PR").

## Feature → PR → Merge

1. Tee muutos branchilla.
2. Aja testit ja tyyppitarkistus paikallisesti ennen pushia (ks. alla).
3. Committoi selkeällä viestillä.
4. `git push -u origin <branch>`.
5. Avaa Pull Request `main`-haaraa vasten. Jos repossa on
   PR-templaatti, käytä sitä (Summary / Test plan -tyylinen jäsennys on
   ollut käytössä). Lisää kuvauksen loppuun tilarivi (ks. "PR:n
   tilarivi" alla) – näin ei tarvitse muistaa ulkoa mikä branch, mikä
   PR ja mikä seuraava askel.
6. Käsittele katselmointikommentit. Repossa on nähty automaattista
   koodikatselmointia (esim. `chatgpt-codex-connector`-botti, joka jättää
   P1-tason huomioita), joiden korjaukset committoidaan samalle branchille
   ja vastataan kommenttiketjussa.
7. Kun CI/katselmointi on kunnossa, mergeä PR päähaaraan.
   **Squash-merge on oletusstrategia** (koko PR yhdeksi committiksi
   mainiin). Jos PR:iä on pinottu (PR B on avattu PR A:n, vielä
   mergetyn, branchin päälle), A:n squash-mergaus **vaihtaa aina A:n
   commit-SHA:n** – tämä ei ole valinnainen riski jota merge-metodin
   valinnalla voisi välttää, vaan squash-mergen luonne. B:n branch pitää
   siis **aina restacking** A:n mergen jälkeen, ei vain joskus (ks.
   varoitus alla – väärä, liian yksinkertainen ohje oli aiemmin tässä
   dokumentissa).
8. Jos muutos vaatii OTA-julkaisun tai uuden buildin, käynnistä se
   GitHub Actionsista mergen jälkeen (ks. `docs/RELEASE_PROCESS.md`).

### PR:n tilarivi

Jokaisen PR-kuvauksen loppuun lisätään lyhyt, koneellisesti skannattava
tilarivi. Tarkoitus: kuka tahansa (ihminen tai toinen istunto) näkee
yhdellä silmäyksellä minkä branchin pitää valita, mistä PR:stä on kyse,
onko se jo mergetty, ja mikä on seuraava askel – ilman että täytyy
selata koko keskusteluhistoriaa.

```
---
PR: #123
Branch: claude/feature-name

Testaa EAS Update -workflow'lla ennen mergeä:
1. Actions -> EAS Update -> Run workflow
2. "Use workflow from": claude/feature-name
3. branch-valinta: development (EI production)

Mergetty: Ei

Seuraava vaihe:
- Testaa puhelimella development-kanavalta
- Jos OK -> mergeä PR mainiin
- Julkaise tuotanto-OTA (EAS Update, branch: production) main-haarasta
```

Huom. tässä on **kolme eri käsitettä**, ei kaksi, ja niitä ei pidä
sekoittaa keskenään:

1. **Git-branch/ref** – Run workflow -dialogin **"Use workflow from"**
   valitsee, minkä git-branchin koodi checkoutataan ja julkaistaan.
2. **EAS Update -branch** – dialogin **`branch`-input-parametri**
   välitetään suoraan komennolle `eas update --branch <arvo>`
   (`.github/workflows/eas-update.yml`). Tämä on EAS:n oma käsite:
   nimetty julkaisuvirta EAS:n puolella, **ei** git-branch eikä
   suoraan sama asia kuin kanava.
3. **EAS-kanava (channel)** – määritelty `eas.json`:n build-
   profiileissa (`channel: "development"` jne., ks.
   `docs/RELEASE_PROCESS.md`). Kanava on se, mihin asennettu build on
   kytketty ja mistä se hakee OTA-päivityksensä.

Tässä repossa EAS Update -branchien nimet (`production`/`preview`/
`development`) **sattuvat olemaan samat** kuin kanavien nimet, minkä
takia ero (2) ja (3) välillä ei ole näkynyt käytännössä. Tämä ei
kuitenkaan ole taattu jatkossakin – EAS:ssa kanava voidaan linkittää
mihin tahansa nimettyyn branchiin (`eas channel:edit`) riippumatta
nimestä. Jos tämä linkitys joskus muutetaan, `branch`-input ei enää
suoraan kerro mitä kanavaa julkaisu koskee – tarkista silloin
todellinen linkitys `eas channel:view <kanava>`-komennolla ennen
julkaisua.

Feature-branchin testaus tarkoittaa siis käytännössä: "Use workflow
from" = oma feature-branch (1), `branch`-input = `development` tai
`preview` (2) (**ei koskaan `production`** ennen kuin PR on mergetty
main-haaraan) – ja luota siihen, että se osuu oikeaan kanavaan (3)
vain niin kauan kuin branch- ja kanavanimet täsmäävät nykyistä
konfiguraatiota vastaavasti.

### Varoitus: pinotut PR:t (stacked PRs) vaativat aina restackingin

Jos PR B on avattu PR A:n (vielä mergetyn) branchia vasten (esim. jatkuu
suoraan siitä), ja A **squash**-mergetään, A:n alkuperäiset commitit
katoavat mainista ja korvautuvat yhdellä uudella squash-committilla, jolla
on eri SHA. B:n branch sisältää kuitenkin edelleen A:n **alkuperäiset**
commitit esivanhempinaan. Tämä ei ole vain kosmeettinen ero: se
tarkoittaa, että B:tä pitää **aina restackata** A:n mergen jälkeen, ennen
kuin B:tä voi mergeta – tämä ei ole valinnainen eikä riipu siitä onko
merge-metodi ollut "johdonmukainen".

**Miksi pelkkä `git rebase origin/main` ei riitä:** tavallinen
`git rebase origin/main` päättelee yhteisen esi-isän (`git merge-base`)
B:n ja vanhan `origin/main`:n väliltä. Koska B:n branch haarautui A:n
branchista (ei suoraan vanhasta mainista), tämä yhteinen esi-isä on
**ennen** A:n commiteja – rebase yrittää siis toistaa sekä A:n
alkuperäiset commitit **että** B:n omat commitit uuden, jo A:n
muutokset sisältävän squash-committin päälle. A:n commitit yritetään
näin soveltaa toiseen kertaan sisältöön, jossa ne on jo olemassa, mikä
tyypillisesti pysähtyy heti ensimmäiseen A:n committiin konfliktiin
(täsmälleen näin kävi PR #117 → #118 -ketjussa).

**Oikea tapa – rebase vain B:n omat commitit `--onto`-lipulla:**

```bash
git fetch origin main

# 1. Selvitä OLD_A_TIP: se commit-SHA josta B alun perin haarautui, eli
#    A:n branchin tip ENNEN squash-mergea. Kaksi luotettavaa lähdettä:
#    - PR B:n oma "base" (GitHub API/UI näyttää tämän PR:n sivulla, tai
#      pull_request_read-työkalun `base.sha`-kenttä) - jos B avattiin
#      suoraan A:n branchia vasten, tämä ON A:n vanha tip.
#    - Jos A:n branch on yhä paikallisesti/etänä tallessa (ei vielä
#      poistettu): `git merge-base B <A:n-branch>`.
OLD_A_TIP=<PR B:n base.sha ennen retargetointia, tai merge-base>

git checkout B

# 2. Toista UUDESTA main-haarasta VAIN ne commitit, jotka ovat B:ssä
#    OLD_A_TIP:n jälkeen (eli B:n omat commitit) - A:n alkuperäisiä
#    commiteja ei toisteta lainkaan.
git rebase --onto origin/main "$OLD_A_TIP" B

# 3. Ratkaise konfliktit vain jos B:n OMAT commitit oikeasti koskevat
#    samoja rivejä kuin jokin toinen samaan aikaan mainiin mennyt muutos
#    - ei A:n oman sisällön takia, koska A:ta ei enää toisteta.
git push --force-with-lease origin B
```

`git rebase --onto <uusi-base> <vanha-base> <branch>` tarkoittaa: "ota
branchilta `<branch>` kaikki commitit jotka ovat sen ja `<vanha-base>`:n
välissä, ja toista ne `<uusi-base>`:n päälle" – eli täsmälleen B:n omat
commitit, ei A:n. Jos A:n vanhaa branchia ei enää ole tallessa mistään
(esim. paikallinen kopio poistettu), vaihtoehto on nollata B tuoreesta
mainista ja tuoda vain B:n lopulliset tiedostomuutokset takaisin yhtenä
committina (`git checkout <B:n vanha tip> -- <tiedostot>`) – tämä ei
säilytä B:n commit-historiaa erillisinä committeina mutta antaa saman
lopputuloksen sisällön suhteen.

Tarkista aina PR:n `mergeable_state` ja diffin koko (`additions`/
`deletions`/`changed_files`) restackingin jälkeen ennen mergeä – diffin
pitää vastata vain B:n omia muutoksia, ei A:n muutoksia uudelleen.

## Commit-käytännöt

Historiassa esiintyy kaksi tyyliä:

- Uudemmissa muutoksissa `tyyppi(alue): lyhyt kuvaus` -muoto englanniksi,
  esim. `fix(android): disable enforced nav bar contrast scrim on edge-to-edge`,
  `feat(ci): add GitHub Actions workflow to trigger EAS Build for Android`.
- Vanhemmissa/ihmisen tekemissä committeissa pelkkä suomenkielinen kuvaus,
  esim. `Muuta Lämmin vesi -korttia`, `Säädä saunakortin asettelua`.

**Suositus jatkossa:** käytä `tyyppi(alue): kuvaus`-muotoa (`fix`, `feat`,
`chore`, `refactor`, `docs`...) ja kuvaile commit-viestin rungossa **miksi**
muutos tehtiin, ei vain mitä muutettiin – tämä on ollut käytäntönä viimeisimmissä
PR:issä ja helpottaa historian lukemista jälkikäteen.

## Tyypillinen kehityssykli

1. `git pull` päähaarasta.
2. Luo uusi branch tehtävälle (`codex/...`, `claude/...` tai `fix/...`).
3. Tee muutos.
4. Aja paikallisesti:
   ```bash
   npx tsc --noEmit -p tsconfig.json
   npm test
   ```
5. Committoi ja pushaa branch.
6. Avaa PR, kuvaa muutos ja testaustapa.
7. Käsittele katselmointikommentit tarvittaessa.
8. Mergeä PR päähaaraan.
9. Jos tarpeen, käynnistä OTA-päivitys tai uusi Android-build
   GitHub Actionsista (`docs/RELEASE_PROCESS.md`).
10. Jos kehitystapa tai -prosessi muuttui matkan varrella, päivitä
    tämä dokumentti tai muu `docs/`-tiedosto samassa tai erillisessä PR:ssä.

## Tunnettu poikkeama nykyisestä prosessista

Repon historiassa on myös suoria merge-committeja ja pushja päähaaraan ilman
erillistä PR:ää (esim. `Merge branch 'fix/scenario-integration' into
fix/heating-planner-stability`, `chore: install Codex automatically in
Codespaces`). Nämä ovat vanhempaa käytäntöä ennen kuin
`docs/PROJECT_RULES.md`:n "ei suoria committeja mainiin" -sääntö
muotoiltiin selkeästi. Tästä eteenpäin noudatetaan PR-pohjaista prosessia.
