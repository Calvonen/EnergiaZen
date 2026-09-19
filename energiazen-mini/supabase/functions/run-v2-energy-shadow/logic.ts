import { sensorGeometryV2 } from "../_shared/energyModelV2/sensorGeometry.ts";
import {
  defaultEnergyReserveThresholds,
  evaluateEnergyReserve,
} from "../_shared/energyModelV2/energyReservePolicy.ts";
import { compareEnergyReserveShadow } from "../_shared/energyModelV2/energyReserveShadow.ts";
import { isTankReadingFreshForCalculation } from "../_shared/tankReadingFreshness.ts";
import { resolveLiveDrawReanchors } from "./liveWaterDrawReanchor.ts";

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
  heaterDeliveryUncertaintyKwh: number;
  heaterCreditGuardTopTempC: number | null;
  conservativeEnergyKwh: number | null;
  safetyEnergyKwh: number;
  targetEnergyKwh: number;
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
  ambientTempC: 21,
  topHeatLossTimeConstantHours: 96,
  bottomHeatLossTimeConstantHours: 120,
  specificHeatKwhPerKgC: 0.001163,
  baselineBalanceUncertaintyKwh: 0.25,
  maxReadingGapMinutes: 15,
  heaterGuardMarginC: 2,
} as const;

export function deriveUsableReadingInletBaselineC(readings: ShadowTankReading[]) {
  const usableReadings = readings.filter(isUsableReading);
  return usableReadings.length > 0
    ? Math.min(...usableReadings.map((reading) => reading.inlet_temp as number))
    : null;
}

export function applyReserveThresholds(
  baseResult: LiveReserveShadowResult,
  safetyEnergyKwh: number | null,
  targetEnergyKwh: number | null,
): LiveReserveShadowResult {
  if (safetyEnergyKwh === null || targetEnergyKwh === null) {
    return {
      ...baseResult,
      available: false,
      reason: "v2_percent_thresholds_unavailable",
      safetyEnergyKwh: safetyEnergyKwh ?? baseResult.safetyEnergyKwh,
      targetEnergyKwh: targetEnergyKwh ?? baseResult.targetEnergyKwh,
      v2Band: "invalid",
      v2NeedsEnergyRecovery: null,
    };
  }

  if (!baseResult.available || baseResult.remainingEnergyKwh === null) {
    return { ...baseResult, safetyEnergyKwh, targetEnergyKwh };
  }

  const decision = evaluateEnergyReserve(
    {
      quality: "valid",
      remainingEnergyKwh: baseResult.remainingEnergyKwh,
      uncertaintyKwh: baseResult.balanceUncertaintyKwh,
    },
    { safetyEnergyKwh, targetEnergyKwh },
  );

  return {
    ...baseResult,
    conservativeEnergyKwh: decision.conservativeEnergyKwh,
    safetyEnergyKwh: decision.thresholds.safetyEnergyKwh,
    targetEnergyKwh: decision.thresholds.targetEnergyKwh,
    v2Band: decision.band,
    v2NeedsEnergyRecovery: decision.needsEnergyRecovery,
  };
}

export function runLiveReserveShadow({
  coldInletDrawBaselineC,
  maxTankTemperatureC,
  now,
  readings,
  reliableDraws,
  v1Shadow,
}: {
  coldInletDrawBaselineC?: number | null;
  maxTankTemperatureC: number;
  now: Date;
  readings: ShadowTankReading[];
  reliableDraws: ReliableWaterDraw[];
  v1Shadow: V1ShadowSnapshot | null;
}): LiveReserveShadowResult {
  const ordered = readings
    .filter(isUsableReading)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  // This optional comparison remains useful for isolated unit-level experiments
  // where the caller can supply a semantically equivalent current-state V1
  // boolean. Production live-shadow deliberately passes null because V1's
  // persisted target_hours is a planning-horizon output, not such a boolean.
  const v1NeedsEnergyRecovery =
    v1Shadow === null ? null : Math.max(v1Shadow.target_hours ?? 0, 0) > 0;

  const heaterCreditGuardTopTempC =
    Number.isFinite(maxTankTemperatureC) && maxTankTemperatureC > liveReserveShadowConfig.heaterGuardMarginC
      ? maxTankTemperatureC - liveReserveShadowConfig.heaterGuardMarginC
      : null;

  if (heaterCreditGuardTopTempC === null) {
    return unavailable(
      "invalid_max_tank_temperature",
      ordered.length,
      0,
      false,
      v1NeedsEnergyRecovery,
      null,
    );
  }

  if (ordered.length < 2) {
    return unavailable(
      "insufficient_tank_readings",
      ordered.length,
      0,
      false,
      v1NeedsEnergyRecovery,
      heaterCreditGuardTopTempC,
    );
  }

  const latest = ordered[ordered.length - 1];
  if (!isTankReadingFreshForCalculation(latest.created_at, now)) {
    return unavailable(
      "latest_tank_reading_stale",
      ordered.length,
      0,
      false,
      v1NeedsEnergyRecovery,
      heaterCreditGuardTopTempC,
    );
  }

  // `ordered` is the authoritative replay input. Derive the baseline from it so
  // reserve energy and percentage capacity always use identical observations.
  const inletBaseline = deriveUsableReadingInletBaselineC(ordered) as number;
  const hasIndependentDrawBaseline =
    typeof coldInletDrawBaselineC === "number" &&
    Number.isFinite(coldInletDrawBaselineC);
  const draws = reliableDraws.filter(isReliableDraw);
  const drawResolution = hasIndependentDrawBaseline
    ? resolveLiveDrawReanchors({
        coldInletBaselineC: coldInletDrawBaselineC,
        readings: ordered,
        reliableDraws: draws,
      })
    : {
        detectedUnlabeledDrawCount: 0,
        reanchorIndexes: [],
        unresolved: false,
      };

  if (drawResolution.unresolved) {
    return unavailable(
      "unresolved_water_draw_detected",
      ordered.length,
      draws.length,
      true,
      v1NeedsEnergyRecovery,
      heaterCreditGuardTopTempC,
    );
  }

  const reanchorIndexes = new Set(drawResolution.reanchorIndexes);

  // The first observation anchors this finite replay window. After that point,
  // sensors are diagnostic except when we explicitly re-anchor. A recovered
  // water draw creates one kind of conservative physical anchor. A telemetry
  // gap longer than maxReadingGapMinutes creates another: the post-gap measured
  // state is safer than either guessing relay/draw activity inside the blind
  // interval or poisoning the complete six-hour replay until that gap ages out.
  let remainingEnergyKwh = observedStoredEnergyKwh(ordered[0], inletBaseline);
  let heaterDeliveryUncertaintyKwh = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const previousMs = Date.parse(previous.created_at);
    const currentMs = Date.parse(current.created_at);
    const deltaHours = Math.max((currentMs - previousMs) / 3_600_000, 0);
    const gapMinutes = deltaHours * 60;

    if (gapMinutes > liveReserveShadowConfig.maxReadingGapMinutes) {
      remainingEnergyKwh = observedStoredEnergyKwh(current, inletBaseline);
      // Nothing inside the blind interval is credited. The first trustworthy
      // post-gap sensor observation becomes a fresh physical anchor, so any
      // pre-gap heater-delivery uncertainty no longer propagates forward.
      heaterDeliveryUncertaintyKwh = 0;
      continue;
    }

    const deliveredEnergyKwh = previous.heating === true
      ? liveReserveShadowConfig.heaterPowerKw * deltaHours
      : 0;

    // tank_readings.heating is a boolean state, not power telemetry. A true->
    // false transition means the exact switch-off instant inside the sampling
    // interval is unknown. Likewise, close to the configured upper tank limit
    // the mechanical thermostat may interrupt the element even if the relay
    // state still looks on. Keep nominal energy in the ledger, but subtract the
    // whole potentially unconfirmed interval from safety via uncertainty.
    if (
      deliveredEnergyKwh > 0 &&
      (
        current.heating !== true ||
        Math.max(previous.top_temp as number, current.top_temp as number) >=
          heaterCreditGuardTopTempC
      )
    ) {
      heaterDeliveryUncertaintyKwh += deliveredEnergyKwh;
    }

    const modeledHeatLossKwh = estimateHeatLossKwh(previous, inletBaseline, deltaHours);
    const acceptedRemovalKwh = draws.reduce((sum, draw) => {
      const endedAt = Date.parse(draw.event_ended_at);
      if (endedAt > previousMs && endedAt <= currentMs) {
        return sum + (draw.estimated_water_draw_net_energy_kwh as number);
      }
      return sum;
    }, 0);

    remainingEnergyKwh = Math.max(
      remainingEnergyKwh + deliveredEnergyKwh - modeledHeatLossKwh - acceptedRemovalKwh,
      0,
    );

    if (reanchorIndexes.has(index)) {
      remainingEnergyKwh = observedStoredEnergyKwh(current, inletBaseline);
      // The measured post-draw state becomes a new conservative physical
      // anchor, so uncertainty about heater delivery before that anchor no
      // longer affects the forward balance.
      heaterDeliveryUncertaintyKwh = 0;
    }
  }

  const observedEnergyKwh = observedStoredEnergyKwh(latest, inletBaseline);
  const sensorGapKwh = remainingEnergyKwh - observedEnergyKwh;

  // Positive model-vs-sensor disagreement is not proven usable energy. Treat
  // it as uncertainty for safety decisions so nominal heater credits cannot
  // inflate conservative reserve above what the sensors physically support.
  // Heater-delivery uncertainty and sensor-gap uncertainty can describe the
  // same missing proof, so use the larger of the two instead of double-counting.
  const sensorGapUncertaintyKwh = Math.max(sensorGapKwh, 0);
  const balanceUncertaintyKwh =
    liveReserveShadowConfig.baselineBalanceUncertaintyKwh +
    Math.max(sensorGapUncertaintyKwh, heaterDeliveryUncertaintyKwh);
  const v2Decision = evaluateEnergyReserve({
    quality: "valid",
    remainingEnergyKwh,
    uncertaintyKwh: balanceUncertaintyKwh,
  });
  const v2NeedsEnergyRecovery = v2Decision.needsEnergyRecovery;
  const comparison = v1NeedsEnergyRecovery === null
    ? "v1_unavailable"
    : compareEnergyReserveShadow({
        v1NeedsEnergyRecovery,
        v2Decision,
      }).classification;

  return {
    available: v2NeedsEnergyRecovery !== null,
    reason: v2NeedsEnergyRecovery === null ? "reserve_policy_unavailable" : null,
    readingCount: ordered.length,
    reliableDrawCount: draws.length,
    unresolvedDrawDetected: false,
    remainingEnergyKwh: round(remainingEnergyKwh),
    observedEnergyKwh: round(observedEnergyKwh),
    sensorGapKwh: round(sensorGapKwh),
    balanceUncertaintyKwh: round(balanceUncertaintyKwh),
    heaterDeliveryUncertaintyKwh: round(heaterDeliveryUncertaintyKwh),
    heaterCreditGuardTopTempC,
    conservativeEnergyKwh: round(v2Decision.conservativeEnergyKwh),
    safetyEnergyKwh: v2Decision.thresholds.safetyEnergyKwh,
    targetEnergyKwh: v2Decision.thresholds.targetEnergyKwh,
    v2Band: v2Decision.band,
    v2NeedsEnergyRecovery,
    v1NeedsEnergyRecovery,
    comparison,
  };
}

function unavailable(
  reason: string,
  readingCount: number,
  reliableDrawCount: number,
  unresolvedDrawDetected: boolean,
  v1NeedsEnergyRecovery: boolean | null,
  heaterCreditGuardTopTempC: number | null,
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
    heaterDeliveryUncertaintyKwh: 0,
    heaterCreditGuardTopTempC,
    conservativeEnergyKwh: null,
    safetyEnergyKwh: defaultEnergyReserveThresholds.safetyEnergyKwh,
    targetEnergyKwh: defaultEnergyReserveThresholds.targetEnergyKwh,
    v2Band: "invalid",
    v2NeedsEnergyRecovery: null,
    v1NeedsEnergyRecovery,
    comparison: v1NeedsEnergyRecovery === null ? "v1_unavailable" : "v2_unavailable",
  };
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