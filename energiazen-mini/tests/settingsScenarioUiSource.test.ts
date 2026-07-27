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
  assertSource(
    homeSource.includes("Heating plan publication skipped for scenario settings") &&
      homeSource.includes("canPublishActiveHeatingPlan({"),
    "skenaariosuunnitelma ei paase heating_plans-julkaisupolkuun",
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
