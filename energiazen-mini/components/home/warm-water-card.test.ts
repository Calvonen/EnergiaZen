import {
  buildV2HomeReservePresentation,
  V2_RECOMMENDED_PREHEAT_PERCENT,
  type V2HomeReserveSnapshot,
} from "../../lib/v2HomeReservePresentation";

export function runV2HomeReservePresentationUnitTests() {
  const now = Date.parse("2026-09-16T09:00:00Z");
  const base: V2HomeReserveSnapshot = {
    run_at: "2026-09-16T08:55:00Z",
    available: true,
    conservative_energy_kwh: 11.183,
    energy_capacity_kwh: 17.673,
    safety_reserve_percent: 30,
    target_reserve_percent: 75,
    forecast_min_conservative_energy_kwh: 10.6,
    forecast_final_conservative_energy_kwh: 13.3,
    forecast_horizon_end_at: "2026-09-17T21:00:00Z",
    latest_run_at: "2026-09-16T08:55:00Z",
    latest_run_available: true,
    latest_unavailable_reason: null,
  };

  const current = buildV2HomeReservePresentation(base, now);
  if (!current.available || current.percent === null || Math.abs(current.percent - 63.28) >= 0.05) {
    throw new Error(`expected production reserve presentation near 63.28%, got ${current.percent}`);
  }
  if (current.safetyReservePercent !== 30 || current.targetReservePercent !== 75) {
    throw new Error("expected current production reserve limits to remain available as telemetry");
  }
  if (current.recommendedPreheatPercent !== V2_RECOMMENDED_PREHEAT_PERCENT || current.recommendedPreheatPercent !== 90) {
    throw new Error("expected the home reserve presentation to use the 90% soft preheat recommendation");
  }
  if (current.forecastMinimumPercent === null || Math.abs(current.forecastMinimumPercent - 59.98) >= 0.05) {
    throw new Error(`expected V2 forecast minimum near 59.98%, got ${current.forecastMinimumPercent}`);
  }
  if (current.forecastFinalPercent === null || Math.abs(current.forecastFinalPercent - 75.26) >= 0.05) {
    throw new Error(`expected V2 horizon-end reserve near 75.26%, got ${current.forecastFinalPercent}`);
  }

  const withoutLegacyTarget = buildV2HomeReservePresentation(
    { ...base, target_reserve_percent: null },
    now,
  );
  if (!withoutLegacyTarget.available || withoutLegacyTarget.targetReservePercent !== null || withoutLegacyTarget.recommendedPreheatPercent !== 90) {
    throw new Error("expected the V2 home reserve to stay available without the legacy 75% target");
  }

  const fallback = buildV2HomeReservePresentation(
    {
      ...base,
      run_at: "2026-09-16T08:50:00Z",
      latest_run_at: "2026-09-16T08:59:00Z",
      latest_run_available: false,
      latest_unavailable_reason: "unresolved_water_draw_detected",
    },
    now,
  );
  if (!fallback.available || !fallback.isFallback || fallback.percent === null) {
    throw new Error("expected a recent last-good V2 snapshot to remain displayable as fallback");
  }

  const stale = buildV2HomeReservePresentation(
    { ...base, run_at: "2026-09-16T08:29:00Z" },
    now,
  );
  if (stale.available || stale.percent !== null || stale.fillPercent !== 0 ||
      stale.safetyReservePercent !== null || stale.targetReservePercent !== null) {
    throw new Error("expected a 31-minute-old production snapshot and its limit markers to fail closed");
  }
  if (stale.recommendedPreheatPercent !== 90) {
    throw new Error("expected the static soft recommendation to remain known when telemetry is unavailable");
  }

  const future = buildV2HomeReservePresentation(
    { ...base, run_at: "2026-09-16T09:01:00Z" },
    now,
  );
  if (future.available || future.safetyReservePercent !== null || future.targetReservePercent !== null) {
    throw new Error("expected a future-dated production snapshot and its limit markers to fail closed");
  }

  const unavailable = buildV2HomeReservePresentation(
    { ...base, available: false },
    now,
  );
  if (unavailable.available || unavailable.percent !== null ||
      unavailable.safetyReservePercent !== null || unavailable.targetReservePercent !== null) {
    throw new Error("expected an unavailable V2 snapshot and its live limit markers to fail closed");
  }

  const invalidCapacity = buildV2HomeReservePresentation(
    { ...base, energy_capacity_kwh: 0 },
    now,
  );
  if (invalidCapacity.available || invalidCapacity.safetyReservePercent !== null || invalidCapacity.targetReservePercent !== null) {
    throw new Error("expected zero capacity and its live limit markers to fail closed");
  }

  const invalidLimits = buildV2HomeReservePresentation(
    { ...base, safety_reserve_percent: null },
    now,
  );
  if (invalidLimits.available || invalidLimits.safetyReservePercent !== null || invalidLimits.targetReservePercent !== null) {
    throw new Error("expected a missing hard safety reserve to fail the whole presentation closed");
  }
}
