import { calculateBilledElectricityPriceCentsPerKwh } from "../_shared/heatingTariff.ts";

export type V2PriceCeilingDecision = {
  allowed: boolean | null;
  available: boolean;
  billedPriceCentsPerKwh: number | null;
  emergencySafetyOverride: boolean;
  maxBilledPriceCentsPerKwh: number | null;
  reason:
    | "within_price_ceiling"
    | "blocked_above_price_ceiling"
    | "safety_override_above_price_ceiling"
    | "invalid_spot_price"
    | "invalid_price_ceiling";
};

export function evaluateV2PriceCeilingPolicy({
  maxBilledPriceCentsPerKwh,
  safetyHeatingRequired,
  spotPriceCentsPerKwh,
}: {
  maxBilledPriceCentsPerKwh: number;
  safetyHeatingRequired: boolean;
  spotPriceCentsPerKwh: number;
}): V2PriceCeilingDecision {
  if (!Number.isFinite(maxBilledPriceCentsPerKwh)) {
    return unavailable("invalid_price_ceiling");
  }

  const billedPriceCentsPerKwh = calculateBilledElectricityPriceCentsPerKwh(
    spotPriceCentsPerKwh,
  );
  if (billedPriceCentsPerKwh === null) {
    return unavailable("invalid_spot_price", maxBilledPriceCentsPerKwh);
  }

  if (billedPriceCentsPerKwh <= maxBilledPriceCentsPerKwh) {
    return {
      allowed: true,
      available: true,
      billedPriceCentsPerKwh,
      emergencySafetyOverride: false,
      maxBilledPriceCentsPerKwh,
      reason: "within_price_ceiling",
    };
  }

  if (safetyHeatingRequired) {
    return {
      allowed: true,
      available: true,
      billedPriceCentsPerKwh,
      emergencySafetyOverride: true,
      maxBilledPriceCentsPerKwh,
      reason: "safety_override_above_price_ceiling",
    };
  }

  return {
    allowed: false,
    available: true,
    billedPriceCentsPerKwh,
    emergencySafetyOverride: false,
    maxBilledPriceCentsPerKwh,
    reason: "blocked_above_price_ceiling",
  };
}

function unavailable(
  reason: "invalid_spot_price" | "invalid_price_ceiling",
  maxBilledPriceCentsPerKwh: number | null = null,
): V2PriceCeilingDecision {
  return {
    allowed: null,
    available: false,
    billedPriceCentsPerKwh: null,
    emergencySafetyOverride: false,
    maxBilledPriceCentsPerKwh,
    reason,
  };
}
