export type V2PriceCeilingSettingTelemetry = {
  available: boolean;
  enabled: boolean;
  maxBilledPriceCentsPerKwh: number | null;
  reason: "configured" | "disabled" | "invalid_setting";
};

export function buildV2PriceCeilingSettingTelemetry(
  rawValue: unknown,
): V2PriceCeilingSettingTelemetry {
  if (rawValue === null || rawValue === undefined) {
    return {
      available: true,
      enabled: false,
      maxBilledPriceCentsPerKwh: null,
      reason: "disabled",
    };
  }

  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return {
      available: false,
      enabled: false,
      maxBilledPriceCentsPerKwh: null,
      reason: "invalid_setting",
    };
  }

  return {
    available: true,
    enabled: true,
    maxBilledPriceCentsPerKwh: rawValue,
    reason: "configured",
  };
}
