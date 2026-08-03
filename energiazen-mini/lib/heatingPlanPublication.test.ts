import {
  canPublishActiveHeatingPlan,
  computeNextUnknownHeatingAnchor,
  getChangedHeatingPlans,
  getHeatingPlanPresentationSource,
  preserveCurrentHourWhileHeatingUnknown,
  publishLatestHeatingPlan,
  shouldDeferHeatingPlanPublicationForUnknownStatus,
} from "./heatingPlanPublication";
import type { PublishedHeatingPlanState } from "./heatingPlanPublication";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertSame(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected the same object reference`);
  }
}

export function runHeatingPlanPublicationUnitTests() {
  assertEqual(
    canPublishActiveHeatingPlan({
      isOptimizationCurrent: true,
      source: "scenario",
    }),
    false,
    "skenaariotuloksen lahde ei voi koskaan julkaista",
  );
  assertEqual(
    canPublishActiveHeatingPlan({
      isOptimizationCurrent: true,
      source: "active",
    }),
    true,
    "ajantasainen persistedSettings-tulos voidaan julkaista",
  );
  assertEqual(
    canPublishActiveHeatingPlan({
      isOptimizationCurrent: true,
      source: "active",
    }),
    true,
    "aktiivinen tulos julkaistaan vaikka luonnoksessa olisi tallentamattomia muutoksia",
  );
  assertEqual(
    canPublishActiveHeatingPlan({
      isOptimizationCurrent: false,
      source: "active",
    }),
    false,
    "vain ajantasainen aktiivinen suunnitelma voidaan julkaista",
  );

  const oldPublication: PublishedHeatingPlanState<
    { plannedHours: number[] },
    number
  > = {
    hours: [6],
    inputKey: "old",
    result: { plannedHours: [6] },
    runId: 2,
  };
  assertEqual(
    publishLatestHeatingPlan(oldPublication, {
      hours: [],
      inputKey: "loading",
      result: null,
      runId: 3,
    }),
    oldPublication,
    "loading tai valiaikainen tyhja tulos ei tyhjenna julkaistua korttia",
  );
  const newPublication: PublishedHeatingPlanState<
    { plannedHours: number[] },
    number
  > = {
    hours: [13],
    inputKey: "new",
    result: { plannedHours: [13] },
    runId: 3,
  };
  assertEqual(
    publishLatestHeatingPlan(oldPublication, newPublication),
    newPublication,
    "uusi tulos ja sen tunnit julkaistaan yhdella atomisella paivityksella",
  );
  assertEqual(
    publishLatestHeatingPlan(newPublication, oldPublication),
    newPublication,
    "vanha asynkroninen tulos ei ylikirjoita uudempaa julkaisua",
  );
  assertSame(
    publishLatestHeatingPlan(newPublication, { ...newPublication }),
    newPublication,
    "sama run id ei paivita korttia eika vuorottele planned_hours-arvoa",
  );

  const storedPlan = {
    mode: "automatic",
    plan_date: "2026-07-26",
    planned_hours: [6, 13],
    reason: "old",
    target_hours: 2,
    updated_at: "2026-07-26T05:00:00.000Z",
  };

  assertEqual(
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: false,
      hasStoredPlan: true,
    }),
    "stored",
    "tallennettu suunnitelma nakyy uuden laskennan valmistumiseen asti",
  );
  assertEqual(
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: true,
      hasStoredPlan: true,
    }),
    "optimizer",
    "uusi optimointitulos vaihtuu esityslahteeksi atomisesti",
  );
  assertEqual(
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: true,
      hasStoredPlan: false,
    }),
    "optimizer",
    "loading tai tallennetun haun tyhjeneminen ei poista julkaistua tulosta",
  );

  const identicalPlan = {
    ...storedPlan,
    planned_hours: [13, 6, 6],
    reason: "new diagnostics",
    updated_at: "2026-07-26T06:00:00.000Z",
  };
  assertEqual(
    getChangedHeatingPlans(
      { "2026-07-26": storedPlan },
      [identicalPlan],
    ),
    [],
    "identtinen operatiivinen suunnitelma ei aiheuta upsertia",
  );
  assertEqual(
    getChangedHeatingPlans(
      { "2026-07-26": storedPlan },
      [{ ...identicalPlan, planned_hours: [13] }],
    ).length,
    1,
    "muuttunut planned_hours julkaistaan",
  );

  const unchangedPollSources = Array.from({ length: 3 }, () =>
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: true,
      hasStoredPlan: true,
    }),
  );
  assertEqual(
    unchangedPollSources,
    ["optimizer", "optimizer", "optimizer"],
    "muuttumaton 30 sekunnin pollaus ei vaihda kortin lahdetta",
  );

  // P1-korjaus (Codex review, PR #147): epavarma (heating=null) nykyinen
  // tunti ei saa havita julkaistusta suunnitelmasta, koska Shellyn oma
  // controller-skripti sammuttaa releen heti kun sen oma tunti puuttuu
  // heating_plans:sta - riippumatta siita onko lammitys todellisuudessa
  // kesken. unknownAnchorHourNumber on tassa aina 14 (= currentHourNumber),
  // eli ankkuri osuu nykyiseen tuntiin normaalisti.
  assertEqual(
    preserveCurrentHourWhileHeatingUnknown({
      currentHourNumber: 14,
      heating: null,
      nextPlannedHours: [10, 18],
      previousPlannedHours: [10, 14, 18],
      unknownAnchorHourNumber: 14,
    }),
    [10, 14, 18],
    "nykyinen tunti oli suunnitelmassa ja heating muuttuu nulliksi - tunti sailyy",
  );
  assertEqual(
    preserveCurrentHourWhileHeatingUnknown({
      currentHourNumber: 14,
      heating: null,
      nextPlannedHours: [10, 18],
      previousPlannedHours: [10, 18],
      unknownAnchorHourNumber: 14,
    }),
    [10, 18],
    "nykyinen tunti ei ollut suunnitelmassa ja heating=null - tuntia ei lisata",
  );
  assertEqual(
    preserveCurrentHourWhileHeatingUnknown({
      currentHourNumber: 14,
      heating: null,
      nextPlannedHours: [10],
      previousPlannedHours: [10, 14, 18],
      unknownAnchorHourNumber: 14,
    }),
    [10, 14],
    "tulevia tunteja (18) ei sailyteta eika lisata null-tilan perusteella - vain nykyinen tunti (14) palautetaan",
  );
  assertEqual(
    preserveCurrentHourWhileHeatingUnknown({
      currentHourNumber: 14,
      heating: false,
      nextPlannedHours: [10, 18],
      previousPlannedHours: [10, 14, 18],
      unknownAnchorHourNumber: 14,
    }),
    [10, 18],
    "heating=false sallii normaalin optimoinnin poistaa nykyisen tunnin",
  );
  assertEqual(
    preserveCurrentHourWhileHeatingUnknown({
      currentHourNumber: 14,
      heating: true,
      nextPlannedHours: [10, 14, 18],
      previousPlannedHours: [10, 14, 18],
      unknownAnchorHourNumber: 14,
    }),
    [10, 14, 18],
    "heating=true kayttaa nykyista lukituslogiikkaa (optimoija on jo lukinnut tunnin, guard ei muuta mitaan)",
  );

  // Codexin jatko-P1-loydos (PR #147, commit 83ef55e): pelkka jasenyys
  // previousPlannedHours-listassa ei riita - se voi sisaltaa myos tunteja
  // jotka olivat vain TULEVIA suunniteltuja tunteja, ei koskaan varmistettu
  // kayynissa olevaksi. Ankkurin taytyy osua tasan nykyiseen tuntiin.
  assertEqual(
    preserveCurrentHourWhileHeatingUnknown({
      // Epavarmuus alkoi tunnilla 14 (ankkuri), kello vaihtui tunniksi 15
      // heatingin pysyessa yha nullina - tunti 15 oli jo ennalta
      // suunnitelmassa (tuleva tunti), mutta sita ei ole koskaan
      // vahvistettu kaynnissa olevaksi.
      currentHourNumber: 15,
      heating: null,
      nextPlannedHours: [10],
      previousPlannedHours: [10, 14, 15],
      unknownAnchorHourNumber: 14,
    }),
    [10],
    "tuntiraja epavarmuuden aikana ei siirra sailytysta uuteen (vain suunniteltuun) tuntiin",
  );
  assertEqual(
    preserveCurrentHourWhileHeatingUnknown({
      currentHourNumber: 14,
      heating: null,
      nextPlannedHours: [10, 18],
      previousPlannedHours: [10, 14, 18],
      // Ankkuria ei viela ole (esim. sovellus juuri kaynnistynyt, tallennettu
      // suunnitelma ei ole viela latautunut) - guard ei saa toimia ilman
      // varmaa ankkuria, vaikka previousPlannedHours nayttaisikin sopivalta.
      unknownAnchorHourNumber: null,
    }),
    [10, 18],
    "ilman ankkuria (esim. suunnitelmaa ei viela ladattu) tuntia ei sailyteta",
  );

  // computeNextUnknownHeatingAnchor (Codex P1 review, PR #147 follow-up).
  // Elokuun alussa Helsinki on UTC+3 (kesaaika): 11:59:30Z = 14:59:30
  // Helsingin aikaa (tunti 14), 12:00:05Z = 15:00:05 (tunti 15).
  assertEqual(
    computeNextUnknownHeatingAnchor({
      currentAnchor: { hourNumber: 10, planDate: "2026-08-03" },
      heating: true,
      now: new Date("2026-08-03T12:00:05.000Z"),
      readingCreatedAt: null,
    }),
    null,
    "heating=true tyhjentaa ankkurin vaikka aiempi olisi asetettu",
  );
  assertEqual(
    computeNextUnknownHeatingAnchor({
      currentAnchor: { hourNumber: 10, planDate: "2026-08-03" },
      heating: null,
      now: new Date("2026-08-03T12:00:05.000Z"),
      readingCreatedAt: "2026-08-03T11:59:30.000Z",
    }),
    { hourNumber: 10, planDate: "2026-08-03" },
    "olemassa olevaa ankkuria ei siirreta uuteen tuntiin heatingin pysyessa nullina",
  );
  assertEqual(
    computeNextUnknownHeatingAnchor({
      currentAnchor: null,
      heating: null,
      now: new Date("2026-08-03T12:00:05.000Z"),
      readingCreatedAt: "2026-08-03T11:59:30.000Z",
    }),
    { hourNumber: 14, planDate: "2026-08-03" },
    "uusi ankkuri lukitaan lukeman OMAAN aikaleimaan (tunti 14), ei elavaan nykyhetkeen (tunti 15) - kylmakaynnistys joka ylittaa tuntirajan haun aikana ei saa ankkuroitua vaaraan, jo alkaneeseen tuntiin",
  );
  assertEqual(
    computeNextUnknownHeatingAnchor({
      currentAnchor: null,
      heating: null,
      now: new Date("2026-08-03T12:00:05.000Z"),
      readingCreatedAt: null,
    }),
    { hourNumber: 15, planDate: "2026-08-03" },
    "ilman lukemaa (haku epaonnistui kokonaan) ankkuri lukitaan elavaan nykyhetkeen, koska rivin aikaleimaa ei ole",
  );

  // shouldDeferHeatingPlanPublicationForUnknownStatus (valmistumiskriteerin
  // kohta 1, PR #147): julkaisu pitaa lykata heating=null-tilassa kunnes
  // SEKA tamanpaivainen suunnitelma on ladattu ETTA ensimmainen
  // relelukuyritys on paattynyt - kumpikaan yksinaan ei riita.
  assertEqual(
    shouldDeferHeatingPlanPublicationForUnknownStatus({
      hasAttemptedTankReadingFetch: true,
      heating: true,
      isTodayPlanLoaded: false,
    }),
    false,
    "varmistettu heating=true ei koskaan lykkaydy vaikka mikaan muu ei olisi valmis",
  );
  assertEqual(
    shouldDeferHeatingPlanPublicationForUnknownStatus({
      hasAttemptedTankReadingFetch: true,
      heating: false,
      isTodayPlanLoaded: false,
    }),
    false,
    "varmistettu heating=false ei koskaan lykkaydy vaikka mikaan muu ei olisi valmis",
  );
  assertEqual(
    shouldDeferHeatingPlanPublicationForUnknownStatus({
      hasAttemptedTankReadingFetch: true,
      heating: null,
      isTodayPlanLoaded: false,
    }),
    true,
    "heating=null lykkaytyy jos suunnitelmaa ei ole viela ladattu, vaikka relelukema on jo yritetty",
  );
  assertEqual(
    shouldDeferHeatingPlanPublicationForUnknownStatus({
      hasAttemptedTankReadingFetch: false,
      heating: null,
      isTodayPlanLoaded: true,
    }),
    true,
    "heating=null lykkaytyy jos relelukemaa ei ole viela yritetty, vaikka suunnitelma on jo ladattu (kiintea tila ei odota optimoijaa)",
  );
  assertEqual(
    shouldDeferHeatingPlanPublicationForUnknownStatus({
      hasAttemptedTankReadingFetch: true,
      heating: null,
      isTodayPlanLoaded: true,
    }),
    false,
    "heating=null julkaistaan normaalisti (guard soveltuu) kun molemmat ehdot on tayttyneet",
  );
}
