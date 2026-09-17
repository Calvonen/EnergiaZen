import {
  maxV2TargetReservePercent,
  minV2TargetReservePercent,
  recommendedV2PreheatPercent,
} from "./energyModelV2/energyReservePercent";

export const HOME_RESERVE_MAX_AGE_MS = 30 * 60_000;
export const V2_RECOMMENDED_PREHEAT_PERCENT = recommendedV2PreheatPercent;

export type V2HomeReserveSnapshot = {
  run_at: string | null;
  available: boolean | null;
  conservative_energy_kwh: number | null;
  energy_capacity_kwh: number | null;
  safety_reserve_percent: number | null;
  target_reserve_percent: number | null;
  recommended_preheat_percent?: number | null;
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

function isValidRecommendation(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minV2TargetReservePercent &&
    value <= maxV2TargetReservePercent
  );
}

function resolveRecommendedPreheatPercent(
  configuredRecommendation: number | null | undefined,
  telemetryRecommendation: number | null | undefined,
  preferConfiguredRecommendation: boolean,
) {
  // Normally a fresh shadow row is authoritative over this install's local
  // copy, which protects fresh installs/second devices from masking an older
  // intentional backend value with their local 90% default. Immediately after
  // a successful local Settings save, however, the last-good shadow row can
  // still carry the previous recommendation for up to its freshness window.
  // The hook marks only that known pending-save window so the just-saved local
  // value wins until shadow telemetry catches up.
  const ordered = preferConfiguredRecommendation
    ? [configuredRecommendation, telemetryRecommendation]
    : [telemetryRecommendation, configuredRecommendation];

  for (const value of ordered) {
    if (isValidRecommendation(value)) {
      return value;
    }
  }

  return V2_RECOMMENDED_PREHEAT_PERCENT;
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
  configuredRecommendation?: number | null,
  preferConfiguredRecommendation = false,
): V2HomeReservePresentation {
  const capacity = reserve?.energy_capacity_kwh;
  const energy = reserve?.conservative_energy_kwh;
  const safetyReservePercent = reserve?.safety_reserve_percent;
  const targetReservePercent = reserve?.target_reserve_percent;
  const recommendedPreheatPercent = resolveRecommendedPreheatPercent(
    configuredRecommendation,
    reserve?.recommended_preheat_percent,
    preferConfiguredRecommendation,
  );
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
      recommendedPreheatPercent,
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
    recommendedPreheatPercent,
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
