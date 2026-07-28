import fs from "node:fs";
import path from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runSettingsScenarioUiSourceTests() {
  const rootSource = fs.readFileSync(
    path.resolve(process.cwd(), "app/_layout.tsx"),
    "utf8",
  );
  const homeSource = fs.readFileSync(
    path.resolve(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );

  assertSource(
    rootSource.includes("<SettingsScenarioProvider>"),
    "asetusskenaario sailyy ruutujen valilla sovellustason providerissa",
  );
  assertSource(
    homeSource.includes("draftSettings: scenarioSettings") &&
      homeSource.includes("persistedSettings: activeSettings") &&
      homeSource.includes("hasUnsavedChanges"),
    "etusivu erottaa skenaario- ja aktiiviset asetukset",
  );

  const runCallCount = (
    homeSource.match(/useHeatingOptimizationRun\(\{/g) ?? []
  ).length;
  assertSource(
    runCallCount === 2 &&
      homeSource.includes("const activeOptimizationRun = useHeatingOptimizationRun({") &&
      homeSource.includes("const scenarioOptimizationRun = useHeatingOptimizationRun({") &&
      homeSource.includes("appSettings: activeSettings") &&
      homeSource.includes("appSettings: scenarioSettings") &&
      homeSource.includes("mode: activeSettings.heatingNeedMode") &&
      homeSource.includes("mode: scenarioSettings.heatingNeedMode") &&
      homeSource.includes("isEnabled: true") &&
      homeSource.includes(
        "isEnabled: hasUnsavedChanges && scenarioValidation.errors.length === 0",
      ),
    "active- ja scenario-optimointi ovat kaksi erillista putkea, active aina paalla ja scenario vain kelvollisella luonnoksella",
  );

  const publishEffectStart = homeSource.indexOf(
    "This effect only ever reads activeOptimizationRun",
  );
  const publishEffectEnd = homeSource.indexOf(
    "\n  const selectedHeatingHoursCount",
    publishEffectStart,
  );
  const publishEffectSource =
    publishEffectStart !== -1 && publishEffectEnd !== -1
      ? homeSource.slice(publishEffectStart, publishEffectEnd)
      : "";
  assertSource(
    publishEffectStart !== -1 &&
      publishEffectEnd !== -1 &&
      publishEffectSource.includes("canPublishActiveHeatingPlan({") &&
      publishEffectSource.includes('source: "active"') &&
      !publishEffectSource.includes("scenarioOptimizationRun") &&
      !publishEffectSource.includes("scenarioOptimizerPresentation") &&
      !publishEffectSource.includes("hasUnsavedChanges"),
    "julkaisu-useEffect julkaisee vain aktiivisen persistedSettings-tuloksen eika viittaa skenaarioon tai hasUnsavedChanges-lippuun",
  );

  assertSource(
    homeSource.includes(
      "optimizationResult: activeOptimizationRun.result",
    ) &&
      homeSource.includes(
        "optimizationResult: scenarioOptimizationRun.result",
      ) &&
      homeSource.includes(
        "selectActiveHeatingPlanPresentation(\n    activeOptimizerPresentation,\n    storedHeatingPlanPresentation,\n  )",
      ) &&
      homeSource.includes(
        "hasUnsavedChanges && scenarioValidation.errors.length === 0",
      ) &&
      homeSource.includes("? scenarioOptimizerPresentation"),
    "etusivu valitsee aktiivisen esityksen selectActiveHeatingPlanPresentation-funktiolla ja skenaarionakyma kayttaa draft-tulosta; itse valintasaanto (tuore voittaa tallennetun) on testattu erikseen heatingPlanPresentation.test.ts:ssa",
  );

  assertSource(
    homeSource.includes("Skenaariotila käytössä") &&
      homeSource.includes("Skenaariota ei voida laskea") &&
      homeSource.includes("Käytössä oleva"),
    "etusivulla on skenaariobanneri, virhetila ja suunnitelman valinta",
  );
  assertSource(
    !homeSource.includes("loadSettings().then"),
    "etusivu ei lataa asetuksia rinnakkaisena paikallisena tilana",
  );
}
