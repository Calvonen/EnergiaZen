import {
  buildV2HomeReservePresentation,
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
  };

  const current = buildV2HomeReservePresentation(base, now);
  if (!current.available || current.percent === null || Math.abs(current.percent - 63.28) >= 0.05) {
    throw new Error(`expected production reserve presentation near 63.28%, got ${current.percent}`);
  }

  const stale = buildV2HomeReservePresentation(
    { ...base, run_at: "2026-09-16T08:47:00Z" },
    now,
  );
  if (stale.available || stale.percent !== null || stale.fillPercent !== 0) {
    throw new Error("expected a 13-minute-old production snapshot to fail closed");
  }

  const future = buildV2HomeReservePresentation(
    { ...base, run_at: "2026-09-16T09:01:00Z" },
    now,
  );
  if (future.available) {
    throw new Error("expected a future-dated production snapshot to fail closed");
  }

  const unavailable = buildV2HomeReservePresentation(
    { ...base, available: false },
    now,
  );
  if (unavailable.available || unavailable.percent !== null) {
    throw new Error("expected an unavailable V2 snapshot to fail closed");
  }

  const invalidCapacity = buildV2HomeReservePresentation(
    { ...base, energy_capacity_kwh: 0 },
    now,
  );
  if (invalidCapacity.available) {
    throw new Error("expected zero capacity to fail closed");
  }
}
