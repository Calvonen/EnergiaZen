export const HOME_RESERVE_MAX_AGE_MS = 12 * 60_000;

export type V2HomeReserveSnapshot = {
  run_at: string | null;
  available: boolean | null;
  conservative_energy_kwh: number | null;
  energy_capacity_kwh: number | null;
  safety_reserve_percent: number | null;
  target_reserve_percent: number | null;
};

export type V2HomeReservePresentation = {
  available: boolean;
  fillPercent: number;
  percent: number | null;
  energyKwh: number | null;
  capacityKwh: number | null;
  safetyReservePercent: number | null;
  targetReservePercent: number | null;
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
    typeof targetReservePercent === "number" &&
    Number.isFinite(targetReservePercent) &&
    targetReservePercent >= 0 &&
    targetReservePercent <= 100;

  if (!valid) {
    return {
      available: false,
      fillPercent: 0,
      percent: null,
      energyKwh: null,
      capacityKwh: null,
      safetyReservePercent: null,
      targetReservePercent: null,
    };
  }

  const percent = clamp((energy / capacity) * 100, 0, 100);
  return {
    available: true,
    fillPercent: percent,
    percent,
    energyKwh: energy,
    capacityKwh: capacity,
    safetyReservePercent,
    targetReservePercent,
  };
}
