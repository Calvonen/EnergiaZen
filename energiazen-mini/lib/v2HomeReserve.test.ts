import { getV2HomeReservePercent } from "./v2HomeReserve";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runV2HomeReserveUnitTests() {
  const percent = getV2HomeReservePercent({
    available: true,
    conservative_energy_kwh: 11.183,
    energy_capacity_kwh: 17.673,
    safety_reserve_percent: 30,
    target_reserve_percent: 75,
  });
  assert(percent !== null && Math.abs(percent - 63.28) < 0.05, "uses conservative V2 energy for reserve percent");

  assert(getV2HomeReservePercent({
    available: false,
    conservative_energy_kwh: 11,
    energy_capacity_kwh: 17,
    safety_reserve_percent: 30,
    target_reserve_percent: 75,
  }) === null, "unavailable shadow does not expose a reserve percent");

  assert(getV2HomeReservePercent({
    available: true,
    conservative_energy_kwh: 20,
    energy_capacity_kwh: 17,
    safety_reserve_percent: 30,
    target_reserve_percent: 75,
  }) === 100, "presentation percent is capped at 100");
}
