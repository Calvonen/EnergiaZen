import type { WaterDrawEventSnapshot } from "./waterDrawLabelDomain";

export type AcceptedEnergyRemovalDecision =
  | {
      accepted: true;
      energyKwh: number;
      reason: "reliable-water-draw-energy";
    }
  | {
      accepted: false;
      energyKwh: 0;
      reason:
        | "unreliable-water-draw-energy"
        | "water-draw-energy-quality-issue"
        | "missing-or-non-positive-water-draw-energy";
    };

/**
 * Converts a validated V2 water-draw energy diagnostic into an explicit
 * physical-energy removal event.
 *
 * This boundary is deliberately fail-closed. Sensor drops are not allowed to
 * reduce the physical ledger by themselves: the diagnostic must explicitly
 * mark the estimate reliable, have no quality reason, and provide a finite
 * positive net-energy estimate.
 */
export function resolveAcceptedWaterDrawRemoval(
  event: WaterDrawEventSnapshot,
): AcceptedEnergyRemovalDecision {
  if (event.energyReliable !== true) {
    return {
      accepted: false,
      energyKwh: 0,
      reason: "unreliable-water-draw-energy",
    };
  }

  if (event.energyQualityReason !== null) {
    return {
      accepted: false,
      energyKwh: 0,
      reason: "water-draw-energy-quality-issue",
    };
  }

  const energyKwh = event.estimatedWaterDrawNetEnergyKwh;
  if (
    typeof energyKwh !== "number" ||
    !Number.isFinite(energyKwh) ||
    energyKwh <= 0
  ) {
    return {
      accepted: false,
      energyKwh: 0,
      reason: "missing-or-non-positive-water-draw-energy",
    };
  }

  return {
    accepted: true,
    energyKwh,
    reason: "reliable-water-draw-energy",
  };
}
