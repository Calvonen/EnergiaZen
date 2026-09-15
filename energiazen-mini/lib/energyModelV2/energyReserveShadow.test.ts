import { compareEnergyReserveShadow } from "./energyReserveShadow";
import type { EnergyReserveDecision } from "./energyReservePolicy";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function decision(
  needsEnergyRecovery: boolean | null,
  band: EnergyReserveDecision["band"],
): EnergyReserveDecision {
  return {
    band,
    conservativeEnergyKwh: band === "target_met" ? 6.5 : band === "recovery" ? 4.5 : 2.5,
    needsEnergyRecovery,
    safetySatisfied: needsEnergyRecovery === null ? null : band !== "below_safety",
    targetSatisfied: needsEnergyRecovery === null ? null : band === "target_met",
    thresholds: { safetyEnergyKwh: 3, targetEnergyKwh: 6 },
  };
}

export function runEnergyReserveShadowUnitTests() {
  const agreeRecovery = compareEnergyReserveShadow({
    v1NeedsEnergyRecovery: true,
    v2Decision: decision(true, "recovery"),
  });
  assert(agreeRecovery.classification === "agree", "matching recovery decisions agree");

  const moreConservative = compareEnergyReserveShadow({
    v1NeedsEnergyRecovery: false,
    v2Decision: decision(true, "below_safety"),
  });
  assert(
    moreConservative.classification === "v2_more_conservative",
    "V2 requesting energy when V1 does not is classified as more conservative",
  );

  const lessConservative = compareEnergyReserveShadow({
    v1NeedsEnergyRecovery: true,
    v2Decision: decision(false, "target_met"),
  });
  assert(
    lessConservative.classification === "v2_less_conservative",
    "V2 declining recovery when V1 requests it is visible for review",
  );

  const unavailable = compareEnergyReserveShadow({
    v1NeedsEnergyRecovery: true,
    v2Decision: decision(null, "invalid"),
  });
  assert(unavailable.classification === "v2_unavailable", "invalid V2 state never pretends to agree");
}
