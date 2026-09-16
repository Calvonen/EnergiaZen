export type V2HomeReserveSnapshot = {
  available: boolean | null;
  conservative_energy_kwh: number | null;
  energy_capacity_kwh: number | null;
  safety_reserve_percent: number | null;
  target_reserve_percent: number | null;
};

export function getV2HomeReservePercent(snapshot: V2HomeReserveSnapshot | null) {
  if (
    snapshot?.available !== true ||
    typeof snapshot.conservative_energy_kwh !== "number" ||
    !Number.isFinite(snapshot.conservative_energy_kwh) ||
    typeof snapshot.energy_capacity_kwh !== "number" ||
    !Number.isFinite(snapshot.energy_capacity_kwh) ||
    snapshot.energy_capacity_kwh <= 0
  ) {
    return null;
  }

  return Math.min(
    100,
    Math.max(0, (snapshot.conservative_energy_kwh / snapshot.energy_capacity_kwh) * 100),
  );
}
