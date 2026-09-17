export const HOME_RESERVE_MAX_AGE_MS = 30 * 60_000;
export const V2_RECOMMENDED_PREHEAT_PERCENT = 90;

export type V2HomeReserveSnapshot = {
  run_at: string | null;
  available: boolean | null;
  conservative_energy_kwh: number | null;
  energy_capacity_kwh: number | null;
  safety_reserve_percent: number | null;
  target_reserve_percent: number | null;
  forecast_min_conservative_energy_kwh: number | null;
  forecast_final_conservative_energy_kwh: number | null;
  forecast_horizon_end_at: string | null;
  latest_run_at: string | null;
  latest_run_available: boolean | null;
  latest_unavailable_reason: string | null;
};

export type V2HomeReservePresentation = {
  available: boolean;
  fillPercent: number;
  percent: number | null;
  energyKwh: number | null;
  capacityKwh: number | null;
  safetyReservePercent: number | null;
  targetReservePercent: number | null;
  recommendedPreheatPercent: number;
  forecastMinimumEnergyKwh: number | null;
  forecastMinimumPercent: number | null;
  forecastFinalEnergyKwh: number | null;
  forecastFinalPercent: number | null;
  forecastHorizonEndAt: string | null;
  isFallback: boolean;
  sourceAgeMinutes: number | null;
  latestUnavailableReason: string | null;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function isV2HomeReserveSnapshotFresh(
  runAt: string | null | undefined,
  nowMs: number,
) {
  if (typeof runAt !== "string" || runAt.length === 0) return false;
  const runAtMs = Date.parse(runAt);
  if (!Number.isFinite(runAtMs)) return false;
  const ageMs = nowMs - runAtMs;
  return ageMs >= 0 && ageMs <= HOME_RESERVE_MAX_AGE_MS;
}

export function buildV2HomeReservePresentation(
  reserve: V2HomeReserveSnapshot | null,
  nowMs: number,
): V2HomeReservePresentation {
  const capacity = reserve?.energy_capacity_kwh;
  const energy = reserve?.conservative_energy_kwh;
  const safetyReservePercent = reserve?.safety_reserve_percent;
  const targetReservePercent = reserve?.target_reserve_percent;
  const forecastMinimumEnergy = reserve?.forecast_min_conservative_energy_kwh;
  const forecastFinalEnergy = reserve?.forecast_final_conservative_energy_kwh;
  const forecastHorizonEndAt = reserve?.forecast_horizon_end_at;
  const valid =
    reserve?.available === true &&
    isV2HomeReserveSnapshotFresh(reserve.run_at, nowMs) &&
    typeof capacity === "number" &&
    Number.isFinite(capacity) &&
    capacity > 0 &&
    typeof energy === "number" &&
    Number.isFinite(energy) &&
    typeof safetyReservePercent === "number" &&
    Number.isFinite(safetyReservePercent) &&
    safetyReservePercent >= 0 &&
    safetyReservePercent <= 100 &&
    typeof forecastMinimumEnergy === "number" &&
    Number.isFinite(forecastMinimumEnergy) &&
    forecastMinimumEnergy >= 0 &&
    typeof forecastFinalEnergy === "number" &&
    Number.isFinite(forecastFinalEnergy) &&
    forecastFinalEnergy >= 0 &&
    typeof forecastHorizonEndAt === "string" &&
    Number.isFinite(Date.parse(forecastHorizonEndAt));

  if (!valid) {
    return {
      available: false,
      fillPercent: 0,
      percent: null,
      energyKwh: null,
      capacityKwh: null,
      safetyReservePercent: null,
      targetReservePercent: null,
      recommendedPreheatPercent: V2_RECOMMENDED_PREHEAT_PERCENT,
      forecastMinimumEnergyKwh: null,
      forecastMinimumPercent: null,
      forecastFinalEnergyKwh: null,
      forecastFinalPercent: null,
      forecastHorizonEndAt: null,
      isFallback: false,
      sourceAgeMinutes: null,
      latestUnavailableReason: null,
    };
  }

  const percent = clamp((energy / capacity) * 100, 0, 100);
  const forecastMinimumPercent = clamp((forecastMinimumEnergy / capacity) * 100, 0, 100);
  const forecastFinalPercent = clamp((forecastFinalEnergy / capacity) * 100, 0, 100);
  const runAtMs = Date.parse(reserve?.run_at ?? "");
  const latestRunAtMs = Date.parse(reserve?.latest_run_at ?? "");
  const sourceAgeMinutes = Number.isFinite(runAtMs) ? Math.max(0, (nowMs - runAtMs) / 60_000) : null;
  const isFallback = reserve?.latest_run_available === false ||
    (Number.isFinite(latestRunAtMs) && Number.isFinite(runAtMs) && latestRunAtMs > runAtMs);
  return {
    available: true,
    fillPercent: percent,
    percent,
    energyKwh: energy,
    capacityKwh: capacity,
    safetyReservePercent,
    targetReservePercent:
      typeof targetReservePercent === "number" && Number.isFinite(targetReservePercent)
        ? targetReservePercent
        : null,
    recommendedPreheatPercent: V2_RECOMMENDED_PREHEAT_PERCENT,
    forecastMinimumEnergyKwh: forecastMinimumEnergy,
    forecastMinimumPercent,
    forecastFinalEnergyKwh: forecastFinalEnergy,
    forecastFinalPercent,
    forecastHorizonEndAt,
    isFallback,
    sourceAgeMinutes,
    latestUnavailableReason: reserve?.latest_unavailable_reason ?? null,
  };
}
