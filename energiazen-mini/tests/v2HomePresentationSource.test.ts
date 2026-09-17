import { readFileSync } from "node:fs";
import { join } from "node:path";

export function runV2HomePresentationSourceTests() {
  const presentationSource = readFileSync(
    join(process.cwd(), "lib/heatingPlanPresentation.ts"),
    "utf8",
  );
  const settingsSource = readFileSync(
    join(process.cwd(), "app/settings.tsx"),
    "utf8",
  );

  const storedPresentationStart = presentationSource.indexOf(
    "export function buildStoredHeatingPlanPresentation",
  );
  if (storedPresentationStart < 0) {
    throw new Error("buildStoredHeatingPlanPresentation not found");
  }
  const storedPresentationSource = presentationSource.slice(storedPresentationStart);
  if (storedPresentationSource.includes('forecastSectionLabel: "Ennuste"')) {
    throw new Error("stored-plan presentation must not fall back to the legacy shower forecast section");
  }
  if (storedPresentationSource.includes("currentOptimizerPresentation.limitsSummary")) {
    throw new Error("stored-plan presentation must not reuse legacy shower reserve limits");
  }
  if (storedPresentationSource.includes("currentOptimizerPresentation.priceToleranceSummary")) {
    throw new Error("stored-plan presentation must not reuse legacy shower optimizer price tolerance");
  }

  if (!settingsSource.includes('label: "Esilämmityssuositus"')) {
    throw new Error("settings must present the V2 soft preheat recommendation");
  }
  if (!settingsSource.includes("V2_RECOMMENDED_PREHEAT_PERCENT")) {
    throw new Error("settings must use the shared V2 soft preheat recommendation constant");
  }
  if (settingsSource.includes('label: "Tavoitevaraus",\n                  secondaryValue: formatV2ReserveKwh(settings.v2TargetReservePercent)')) {
    throw new Error("settings must not expose the legacy 75% V2 target as the user-facing target");
  }
}
