import { detectsWaterDraw } from "../_shared/waterDrawDetection.ts";
import { sensorGeometryV2 } from "../_shared/energyModelV2/sensorGeometry.ts";

export type ShadowTankReading = {
  created_at: string;
  top_temp: number | null;
  bottom_temp: number | null;
  inlet_temp: number | null;
  heating: boolean | null;
};

export type ReliableWaterDraw = {
  event_started_at: string;
  event_ended_at: string;
  estimated_water_draw_net_energy_kwh: number | null;
  energy_reliable: boolean | null;
  energy_quality_reason: string | null;
};

export type V1ShadowSnapshot = {
  id: string;
  run_at: string;
  target_hours: number | null;
};

export type LiveReserveShadowResult = {
  available: boolean;
  reason: string | null;
  readingCount: number;
  reliableDrawCount: number;
  unresolvedDrawDetected: boolean;
  remainingEnergyKwh: number | null;
  observedEnergyKwh: number | null;
  sensorGapKwh: number | null;
  balanceUncertaintyKwh: number;
  conservativeEnergyKwh: number | null;
  v2Band: "below_safety" | "recovery" | "target_met" | "invalid";
  v2NeedsEnergyRecovery: boolean | null;
  v1NeedsEnergyRecovery: boolean | null;
  comparison:
    | "agree"
    | "v2_more_conservative"
    | "v2_less_conservative"
    | "v1_unavailable"
    | "v2_unavailable";
};

export const liveReserveShadowConfig = {
  heaterPowerKw: 3,
  safetyEnergyKwh: 3,
  targetEnergyKwh: 6,
  ambientTempC: 21,
  topHeatLossTimeConstantHours: 96,
  bottomHeatLossTimeConstantHours: 120,
  specificHeatKwhPerKgC: 0.001163,
  baselineBalanceUncertaintyKwh: 0.25,
  maxReadingGapMinutes: 15,
} as const;

export function runLiveReserveShadow({
  readings,
  reliableDraws,
  v1Shadow,
}: {
  readings: ShadowTankReading[];
  reliableDraws: ReliableWaterDraw[];
  v1Shadow: V1ShadowSnapshot | null;
}): LiveReserveShadowResult {
  const ordered = readings
    .filter(isUsableReading)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const v1NeedsEnergyRecovery =
    v1Shadow === null ? null : Math.max(v1Shadow.target_hours ?? 0, 0) > 0;

  if (ordered.length < 2) {
    return unavailable("insufficient_tank_readings", ordered.length, 0, false, v1NeedsEnergyRecovery);
  }

  const inletBaseline = Math.min(...ordered.map((r) => r.inlet_temp as number));
  const draws = reliableDraws.filter(isReliableDraw);
  const unresolvedDrawDetected = hasUnresolvedDetectedDraw(ordered, draws);
  if (unresolvedDrawDetected) {
    return unavailable(
      "unresolved_water_draw_detected",
      ordered.length,
      draws.length,
      true,
      v1NeedsEnergyRecovery,
    );
  }

  let remainingEnergyKwh = observedStoredEnergyKwh(ordered[0], inletBaseline);
  let maxGapMinutes = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const previousMs = Date.parse(previous.created_at);
    const currentMs = Date.parse(current.created_at);
    const deltaHours = Math.max((currentMs - previousMs) / 3_600_000, 0);
    const gapMinutes = deltaHours * 60;
    maxGapMinutes = Math.max(maxGapMinutes, gapMinutes);

    if (gapMinutes > liveReserveShadowConfig.maxReadingGapMinutes) {
      return unavailable(
        "tank_reading_gap_too_long",
        ordered.length,
        draws.length,
        false,
        v1NeedsEnergyRecovery,
      );
    }

    const deliveredEnergyKwh = previous.heating === true
      ? liveReserveShadowConfig.heaterPowerKw * deltaHours
      : 0;
    const modeledHeatLossKwh = estimateHeatLossKwh(previous, inletBaseline, deltaHours);
    const acceptedRemovalKwh = draws.reduce((sum, draw) => {
      const endedAt = Date.parse(draw.event_ended_at);
      if (endedAt > previousMs && endedAt <= currentMs) {
        return sum + (draw.estimated_water_draw_net_energy_kwh as number);
      }
      return sum;
    }, 0);

    const predicted = Math.max(
      remainingEnergyKwh + deliveredEnergyKwh - modeledHeatLossKwh - acceptedRemovalKwh,
      0,
    );
    const observed = observedStoredEnergyKwh(current, inletBaseline);

    // Known heater input is conserved. A warmer sensor observation may reveal
    // energy the ledger underestimated, but a colder observation cannot erase
    // energy unless an explicit reliable removal above accounts for it.
    remainingEnergyKwh = Math.max(predicted, observed);
  }

  const latest = ordered[ordered.length - 1];
  const observedEnergyKwh = observedStoredEnergyKwh(latest, inletBaseline);
  const sensorGapKwh = Math.max(remainingEnergyKwh - observedEnergyKwh, 0);

  // Sensor lag/stratification is diagnostic, not uncertainty about known
  // electrical input. Only balance/model uncertainty is subtracted from the
  // total remaining-energy reserve decision.
  const balanceUncertaintyKwh = liveReserveShadowConfig.baselineBalanceUncertaintyKwh;
  const conservativeEnergyKwh = Math.max(remainingEnergyKwh - balanceUncertaintyKwh, 0);
  const v2Band = conservativeEnergyKwh < liveReserveShadowConfig.safetyEnergyKwh
    ? "below_safety"
    : conservativeEnergyKwh < liveReserveShadowConfig.targetEnergyKwh
      ? "recovery"
      : "target_met";
  const v2NeedsEnergyRecovery = v2Band !== "target_met";

  return {
    available: true,
    reason: null,
    readingCount: ordered.length,
    reliableDrawCount: draws.length,
    unresolvedDrawDetected: false,
    remainingEnergyKwh: round(remainingEnergyKwh),
    observedEnergyKwh: round(observedEnergyKwh),
    sensorGapKwh: round(sensorGapKwh),
    balanceUncertaintyKwh,
    conservativeEnergyKwh: round(conservativeEnergyKwh),
    v2Band,
    v2NeedsEnergyRecovery,
    v1NeedsEnergyRecovery,
    comparison: compare(v1NeedsEnergyRecovery, v2NeedsEnergyRecovery),
  };
}

function unavailable(
  reason: string,
  readingCount: number,
  reliableDrawCount: number,
  unresolvedDrawDetected: boolean,
  v1NeedsEnergyRecovery: boolean | null,
): LiveReserveShadowResult {
  return {
    available: false,
    reason,
    readingCount,
    reliableDrawCount,
    unresolvedDrawDetected,
    remainingEnergyKwh: null,
    observedEnergyKwh: null,
    sensorGapKwh: null,
    balanceUncertaintyKwh: liveReserveShadowConfig.baselineBalanceUncertaintyKwh,
    conservativeEnergyKwh: null,
    v2Band: "invalid",
    v2NeedsEnergyRecovery: null,
    v1NeedsEnergyRecovery,
    comparison: v1NeedsEnergyRecovery === null ? "v1_unavailable" : "v2_unavailable",
  };
}

function compare(v1: boolean | null, v2: boolean | null): LiveReserveShadowResult["comparison"] {
  if (v1 === null) return "v1_unavailable";
  if (v2 === null) return "v2_unavailable";
  if (v1 === v2) return "agree";
  return v2 ? "v2_more_conservative" : "v2_less_conservative";
}

function isUsableReading(reading: ShadowTankReading) {
  return Number.isFinite(reading.top_temp) &&
    Number.isFinite(reading.bottom_temp) &&
    Number.isFinite(reading.inlet_temp) &&
    Number.isFinite(Date.parse(reading.created_at));
}

function isReliableDraw(draw: ReliableWaterDraw) {
  return draw.energy_reliable === true &&
    draw.energy_quality_reason === null &&
    typeof draw.estimated_water_draw_net_energy_kwh === "number" &&
    Number.isFinite(draw.estimated_water_draw_net_energy_kwh) &&
    draw.estimated_water_draw_net_energy_kwh > 0;
}

function hasUnresolvedDetectedDraw(readings: ShadowTankReading[], draws: ReliableWaterDraw[]) {
  for (let index = 1; index < readings.length; index += 1) {
    const windowStart = Math.max(0, index - 6);
    const window = readings.slice(windowStart, index + 1).map((reading) => ({
      inletTemperatureC: reading.inlet_temp,
      time: Date.parse(reading.created_at),
    }));
    if (!detectsWaterDraw(window)) continue;

    const currentMs = Date.parse(readings[index].created_at);
    const matched = draws.some((draw) => {
      const start = Date.parse(draw.event_started_at) - 5 * 60_000;
      const end = Date.parse(draw.event_ended_at) + 5 * 60_000;
      return currentMs >= start && currentMs <= end;
    });
    if (!matched) return true;
  }
  return false;
}

function observedStoredEnergyKwh(reading: ShadowTankReading, inletTempC: number) {
  const tank = sensorGeometryV2.tank;
  const topHeight = tank.heightCm - sensorGeometryV2.topSensorDistanceFromTopCm;
  const boundary = (topHeight + sensorGeometryV2.bottomSensorHeightFromBottomCm) / 2;
  const bottomMassKg = tank.nominalVolumeLiters * Math.max(0, Math.min(boundary / tank.heightCm, 1));
  const topMassKg = tank.nominalVolumeLiters - bottomMassKg;
  const bottomEnergy = layerEnergy(bottomMassKg, reading.bottom_temp as number, inletTempC);
  const topEnergy = layerEnergy(topMassKg, reading.top_temp as number, inletTempC);
  return bottomEnergy + topEnergy;
}

function estimateHeatLossKwh(reading: ShadowTankReading, inletTempC: number, deltaHours: number) {
  if (deltaHours <= 0) return 0;
  const cooledTop = applyNewtonCooling(
    reading.top_temp as number,
    liveReserveShadowConfig.topHeatLossTimeConstantHours,
    deltaHours,
  );
  const cooledBottom = applyNewtonCooling(
    reading.bottom_temp as number,
    liveReserveShadowConfig.bottomHeatLossTimeConstantHours,
    deltaHours,
  );
  const before = observedStoredEnergyKwh(reading, inletTempC);
  const after = observedStoredEnergyKwh(
    { ...reading, top_temp: cooledTop, bottom_temp: cooledBottom },
    inletTempC,
  );
  return Math.max(before - after, 0);
}

function applyNewtonCooling(temperatureC: number, timeConstantHours: number, deltaHours: number) {
  return liveReserveShadowConfig.ambientTempC +
    (temperatureC - liveReserveShadowConfig.ambientTempC) * Math.exp(-deltaHours / timeConstantHours);
}

function layerEnergy(massKg: number, temperatureC: number, inletTempC: number) {
  return Math.max(
    massKg * liveReserveShadowConfig.specificHeatKwhPerKgC * (temperatureC - inletTempC),
    0,
  );
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
