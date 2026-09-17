export const defaultHeatingTariffSettings = {
  gridAndTaxCentsPerKwh: 8.22,
  spotMarginCentsPerKwh: 0.4,
} as const;

export type HeatingTariffSettings = {
  gridAndTaxCentsPerKwh: number;
  spotMarginCentsPerKwh: number;
};

export function calculateBilledElectricityPriceCentsPerKwh(
  spotPriceCentsPerKwh: number | null | undefined,
  settings: HeatingTariffSettings = defaultHeatingTariffSettings,
) {
  if (
    typeof spotPriceCentsPerKwh !== "number" ||
    !Number.isFinite(spotPriceCentsPerKwh) ||
    !Number.isFinite(settings.spotMarginCentsPerKwh) ||
    !Number.isFinite(settings.gridAndTaxCentsPerKwh)
  ) {
    return null;
  }

  return Math.round(
    (spotPriceCentsPerKwh +
      settings.spotMarginCentsPerKwh +
      settings.gridAndTaxCentsPerKwh) *
      10_000,
  ) / 10_000;
}
