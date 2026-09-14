import type { EnergyReserveDecision } from "./energyReservePolicy.ts";

export type EnergyReserveShadowClassification =
  | "agree"
  | "v2_more_conservative"
  | "v2_less_conservative"
  | "v2_unavailable";

export type EnergyReserveShadowComparison = {
  classification: EnergyReserveShadowClassification;
  v1NeedsEnergyRecovery: boolean;
  v2NeedsEnergyRecovery: boolean | null;
  v2Band: EnergyReserveDecision["band"];
  conservativeEnergyKwh: number;
};

/**
 * Compares V2's kWh-only reserve decision with the existing V1 energy-need
 * outcome. The caller supplies the V1 boolean explicitly so this module does
 * not import or perpetuate shower-count arithmetic.
 */
export function compareEnergyReserveShadow({
  v1NeedsEnergyRecovery,
  v2Decision,
}: {
  v1NeedsEnergyRecovery: boolean;
  v2Decision: EnergyReserveDecision;
}): EnergyReserveShadowComparison {
  const v2NeedsEnergyRecovery = v2Decision.needsEnergyRecovery;
  let classification: EnergyReserveShadowClassification;

  if (v2NeedsEnergyRecovery === null) {
    classification = "v2_unavailable";
  } else if (v2NeedsEnergyRecovery === v1NeedsEnergyRecovery) {
    classification = "agree";
  } else if (v2NeedsEnergyRecovery) {
    classification = "v2_more_conservative";
  } else {
    classification = "v2_less_conservative";
  }

  return {
    classification,
    conservativeEnergyKwh: v2Decision.conservativeEnergyKwh,
    v1NeedsEnergyRecovery,
    v2Band: v2Decision.band,
    v2NeedsEnergyRecovery,
  };
}
