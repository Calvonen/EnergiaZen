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
   ollut käytössä).
6. Käsittele katselmointikommentit. Repossa on nähty automaattista
   koodikatselmointia (esim. `chatgpt-codex-connector`-botti, joka jättää
   P1-tason huomioita), joiden korjaukset committoidaan samalle branchille
   ja vastataan kommenttiketjussa.
7. Kun CI/katselmointi on kunnossa, mergeä PR päähaaraan (historiassa
   käytetty GitHubin oletusmerge, "Merge pull request #N" – ei squash).
8. Jos muutos vaatii OTA-julkaisun tai uuden buildin, käynnistä se
   GitHub Actionsista mergen jälkeen (ks. `docs/RELEASE_PROCESS.md`).

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
