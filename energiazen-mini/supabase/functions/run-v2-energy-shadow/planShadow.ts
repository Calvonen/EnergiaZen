import { sensorGeometryV2 } from "../_shared/energyModelV2/sensorGeometry.ts";
import { optimizeEnergyPlan } from "../_shared/energyModelV2/energyPlanOptimizer.ts";
import { liveReserveShadowConfig, type LiveReserveShadowResult } from "./logic.ts";
import type { V2HeatingConstraints } from "./productionConstraints.ts";
import {
  isLearnedTemperatureDropProfileFresh,
  learnedTemperatureDropProfileAgeDays,
  type LearnedTemperatureDropProfile,
} from "./learnedDropProfile.ts";

export type ShadowElectricityPrice = {
  ends_at: string;
  resolution_minutes: number;
  spot_price_cents_kwh: number;
  starts_at: string;
};

export type LiveEnergyPlanShadowResult = {
  available: boolean;
  assumption: "standing_loss_only_no_future_draws";
  candidateCount: number;
  evaluatedCombinationCount: number;
  firstSafetyViolationAt: string | null;
  firstTargetMissAt: string | null;
  forecastHorizonEndAt: string | null;
  finalConservativeEnergyKwh: number | null;
  minimumConservativeEnergyKwh: number | null;
  reason: string | null;
  selectedHeatingEnergyKwh: number | null;
  selectedHeatingHourIds: string[];
  standingLossKwhPerHour: number | null;
  totalCostCents: number | null;
  valid: boolean | null;
  learnedDropProfileUsed: boolean;
  learnedDropProfileDate: string | null;
  learnedDropProfileAgeDays: number | null;
  maximumModeledLossKwhPerHour: number | null;
  effectiveConstraints?: V2HeatingConstraints | null;
};

const assumption = "standing_loss_only_no_future_draws" as const;
const maxShadowHeatingHours = 4;
const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

export function runLiveEnergyPlanShadow({
  automaticMaxHeatingHours,
  constraints = { forbiddenHeatingHourIds: [], requiredHeatingHourIds: [] },
  constraintsAreExactIntervals = false,
  energyCapacityKwh,
  inletBaselineC,
  maxTankTemperatureC,
  now,
  prices,
  reserve,
  learnedDropProfile = null,
}: {
  automaticMaxHeatingHours: number;
  constraints?: V2HeatingConstraints;
  constraintsAreExactIntervals?: boolean;
  energyCapacityKwh: number;
  inletBaselineC: number;
  maxTankTemperatureC: number;
  now: Date;
  prices: ShadowElectricityPrice[];
  reserve: LiveReserveShadowResult;
  learnedDropProfile?: LearnedTemperatureDropProfile | null;
}): LiveEnergyPlanShadowResult {
  if (!reserve.available || reserve.remainingEnergyKwh === null || !Number.isFinite(reserve.remainingEnergyKwh)) {
    return unavailable("reserve_state_unavailable");
  }
  if (!Number.isFinite(automaticMaxHeatingHours) || automaticMaxHeatingHours < 0) {
    return unavailable("invalid_max_heating_hours");
  }
  if (automaticMaxHeatingHours > maxShadowHeatingHours) {
    return unavailable("max_heating_hours_above_shadow_limit");
  }
  if (!Number.isFinite(maxTankTemperatureC) || !Number.isFinite(inletBaselineC) || !Number.isFinite(energyCapacityKwh) || energyCapacityKwh <= 0) {
    return unavailable("invalid_thermal_inputs");
  }

  const standingLossKwhPerHour = worstCaseStandingLossKwhPerHour({ inletBaselineC, maxTankTemperatureC });
  const learnedDropProfileUsed =
    learnedDropProfile !== null &&
    isLearnedTemperatureDropProfileFresh(learnedDropProfile, now);
  const learnedDropProfileAgeDays =
    learnedDropProfile === null
      ? null
      : learnedTemperatureDropProfileAgeDays(learnedDropProfile, now);
  const horizon = buildPriceHorizon({
    now,
    prices,
    standingLossKwhPerHour,
    learnedDropProfile: learnedDropProfileUsed ? learnedDropProfile : null,
  });
  if (!horizon.ok) return unavailable(horizon.reason, standingLossKwhPerHour);

  // Production constraints are still hour-based. When shadowing quarter-hour
  // prices, expand each locked/forbidden production hour to the quarter-hour
  // candidates that fall inside it. This preserves the authoritative active
  // block without changing the stored production contract.
  const shadowConstraints = constraintsAreExactIntervals
    ? validateExactIntervalConstraints(
        constraints,
        horizon.segments.map((segment) => segment.id),
      )
    : expandHourlyConstraints(
        constraints,
        horizon.segments.map((segment) => segment.id),
        now,
      );
  if (!shadowConstraints.ok) {
    return unavailable(shadowConstraints.reason, standingLossKwhPerHour);
  }
  const requiredHeatingHours = horizon.segments
    .filter((segment) => shadowConstraints.requiredHeatingHourIds.includes(segment.id))
    .reduce((sum, segment) => sum + segment.segmentHours, 0);
  const effectiveMaxHeatingHours = Math.max(
    automaticMaxHeatingHours,
    requiredHeatingHours,
  );

  const plan = optimizeEnergyPlan({
    energyCapacityKwh,
    forbiddenHeatingHourIds: shadowConstraints.forbiddenHeatingHourIds,
    heaterPowerKw: liveReserveShadowConfig.heaterPowerKw,
    initialRemainingEnergyKwh: reserve.remainingEnergyKwh,
    initialUncertaintyKwh: reserve.balanceUncertaintyKwh,
    maxHeatingHours: effectiveMaxHeatingHours,
    requiredHeatingHourIds: shadowConstraints.requiredHeatingHourIds,
    segments: horizon.segments,
    thresholds: {
      safetyEnergyKwh: reserve.safetyEnergyKwh,
      targetEnergyKwh: reserve.targetEnergyKwh,
    },
  });

  return {
    available: true,
    assumption,
    candidateCount: plan.candidateCount,
    evaluatedCombinationCount: plan.evaluatedCombinationCount,
    firstSafetyViolationAt: plan.forecast.firstSafetyViolationAt,
    firstTargetMissAt: plan.forecast.firstTargetMissAt,
    forecastHorizonEndAt: horizon.horizonEndAt,
    finalConservativeEnergyKwh: plan.forecast.finalConservativeEnergyKwh,
    minimumConservativeEnergyKwh: plan.forecast.minimumConservativeEnergyKwh,
    reason: plan.violationReason,
    selectedHeatingEnergyKwh: plan.selectedHeatingEnergyKwh,
    selectedHeatingHourIds: plan.selectedHeatingHourIds,
    standingLossKwhPerHour: round(standingLossKwhPerHour),
    totalCostCents: plan.totalCostCents,
    valid: plan.valid,
    learnedDropProfileUsed,
    learnedDropProfileDate: learnedDropProfileUsed ? learnedDropProfile?.profile_date ?? null : null,
    learnedDropProfileAgeDays,
    maximumModeledLossKwhPerHour: horizon.maximumModeledLossKwhPerHour,
    effectiveConstraints: {
      requiredHeatingHourIds: shadowConstraints.requiredHeatingHourIds,
      forbiddenHeatingHourIds: shadowConstraints.forbiddenHeatingHourIds,
    },
  };
}

function buildPriceHorizon({ now, prices, standingLossKwhPerHour, learnedDropProfile }: {
  now: Date;
  prices: ShadowElectricityPrice[];
  standingLossKwhPerHour: number;
  learnedDropProfile: LearnedTemperatureDropProfile | null;
}):
  | { ok: true; horizonEndAt: string; maximumModeledLossKwhPerHour: number; segments: Array<{ id: string; frontLoadedDemandKwh: number; modeledHeatLossKwh: number; priceCentsPerKwh: number; segmentHours: number; startDate: string }> }
  | { ok: false; reason: string } {
  const today = helsinkiDateKey(now);
  const tomorrow = helsinkiDateKeyOffset(now, 1);
  const nowMs = now.getTime();
  const relevant = prices.filter((price) =>
    (price.resolution_minutes === 15 || price.resolution_minutes === 60) &&
    Number.isFinite(price.spot_price_cents_kwh) &&
    Number.isFinite(Date.parse(price.starts_at)) &&
    Number.isFinite(Date.parse(price.ends_at)) &&
    Date.parse(price.ends_at) > nowMs &&
    [today, tomorrow].includes(helsinkiDateKey(new Date(price.starts_at))));

  const horizonForResolution = (resolutionMinutes: 15 | 60) => {
    const rows = relevant
      .filter((price) =>
        price.resolution_minutes === resolutionMinutes &&
        Date.parse(price.ends_at) - Date.parse(price.starts_at) === resolutionMinutes * 60_000)
      .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at));
    if (!rows.length) return { rows, hasCurrent: false, hasGap: false };
    const firstStart = Date.parse(rows[0].starts_at);
    const firstEnd = Date.parse(rows[0].ends_at);
    if (!(firstStart <= nowMs && firstEnd > nowMs)) return { rows, hasCurrent: false, hasGap: false };
    for (let index = 1; index < rows.length; index += 1) {
      if (Date.parse(rows[index - 1].ends_at) !== Date.parse(rows[index].starts_at)) {
        return { rows, hasCurrent: true, hasGap: true };
      }
    }
    return { rows, hasCurrent: true, hasGap: false };
  };

  const quarterHorizon = horizonForResolution(15);
  const hourlyHorizon = horizonForResolution(60);
  // During rollout, only prefer quarters when they cover at least as far as the
  // complete hourly fallback. A partial quarter feed must not shorten safety
  // forecasting simply because one 15-minute row has arrived.
  const quarterRows = quarterHorizon?.hasCurrent && !quarterHorizon.hasGap ? quarterHorizon.rows : null;
  const hourlyRows = hourlyHorizon?.hasCurrent && !hourlyHorizon.hasGap ? hourlyHorizon.rows : null;
  const ordered =
    quarterRows &&
      (!hourlyRows ||
        Date.parse(quarterRows[quarterRows.length - 1].ends_at) >=
          Date.parse(hourlyRows[hourlyRows.length - 1].ends_at))
      ? quarterRows
      : hourlyRows ?? quarterRows;

  if (!ordered?.length) {
    const hasGap = Boolean(quarterHorizon?.hasGap || hourlyHorizon?.hasGap);
    if (hasGap) return { ok: false, reason: "price_horizon_gap" };
    const hasUsableRows = Boolean(quarterHorizon?.rows.length || hourlyHorizon?.rows.length);
    return { ok: false, reason: hasUsableRows ? "current_price_hour_missing" : "no_price_hours_available" };
  }
  const firstStart = Date.parse(ordered[0].starts_at);
  const firstEnd = Date.parse(ordered[0].ends_at);
  if (!(firstStart <= nowMs && firstEnd > nowMs)) return { ok: false, reason: "current_price_hour_missing" };
  for (let index = 1; index < ordered.length; index += 1) {
    if (Date.parse(ordered[index - 1].ends_at) !== Date.parse(ordered[index].starts_at)) {
      return { ok: false, reason: "price_horizon_gap" };
    }
  }

  let maximumModeledLossKwhPerHour = standingLossKwhPerHour;
  const learnedDemandAppliedHours = new Set<string>();
  const segments = ordered.map((price) => {
    const startMs = Math.max(Date.parse(price.starts_at), nowMs);
    const endMs = Date.parse(price.ends_at);
    const segmentHours = Math.max(0, Math.min((endMs - startMs) / 3_600_000, 1));
    const learnedLossKwhPerHour = learnedDropProfile
      ? learnedDropProfile.hourlyEnergyLossesKwh[
          helsinkiHour(new Date(price.starts_at))
        ] ?? 0
      : 0;
    const absoluteHourStartMs =
      Math.floor(Date.parse(price.starts_at) / 3_600_000) * 3_600_000;
    const learnedHourKey = String(absoluteHourStartMs);
    const learnedDemandKwh = learnedDemandAppliedHours.has(learnedHourKey)
      ? 0
      : Math.max(learnedLossKwhPerHour - standingLossKwhPerHour, 0);
    learnedDemandAppliedHours.add(learnedHourKey);
    maximumModeledLossKwhPerHour = Math.max(
      maximumModeledLossKwhPerHour,
      standingLossKwhPerHour + learnedDemandKwh,
    );
    return {
      id: price.starts_at,
      // Passive loss is continuous and may be prorated. Learned excess demand
      // is a whole-hour bucket that can contain discrete draws, so keep the full
      // bucket and let the forecast apply it before any same-hour heater credit.
      frontLoadedDemandKwh: learnedDemandKwh,
      modeledHeatLossKwh: standingLossKwhPerHour * segmentHours,
      priceCentsPerKwh: price.spot_price_cents_kwh,
      segmentHours,
      startDate: new Date(startMs).toISOString(),
    };
  });
  return {
    ok: true,
    horizonEndAt: ordered[ordered.length - 1].ends_at,
    maximumModeledLossKwhPerHour: round(maximumModeledLossKwhPerHour),
    segments,
  };
}

function validateExactIntervalConstraints(
  constraints: V2HeatingConstraints,
  candidateIds: string[],
):
  | ({ ok: true } & V2HeatingConstraints)
  | { ok: false; reason: "required_hour_missing" } {
  const candidates = new Set(candidateIds);
  if (constraints.requiredHeatingHourIds.some((id) => !candidates.has(id))) {
    return { ok: false, reason: "required_hour_missing" };
  }
  return {
    ok: true,
    requiredHeatingHourIds: [...new Set(constraints.requiredHeatingHourIds)],
    forbiddenHeatingHourIds: [...new Set(constraints.forbiddenHeatingHourIds)]
      .filter((id) => candidates.has(id)),
  };
}

function expandHourlyConstraints(
  constraints: V2HeatingConstraints,
  candidates: Array<{ id: string; durationMs: number }>,
  now: Date,
):
  | ({ ok: true } & V2HeatingConstraints)
  | { ok: false; reason: "required_hour_missing" } {
  const candidateDurationById = new Map(
    candidates
      .filter((candidate) => Number.isFinite(Date.parse(candidate.id)) && candidate.durationMs > 0)
      .map((candidate) => [candidate.id, candidate.durationMs]),
  );
  const orderedCandidates = [...candidateDurationById.keys()]
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const expand = (hourIds: string[]) => {
    const starts = hourIds
      .map((id) => Date.parse(id))
      .filter((value) => Number.isFinite(value));
    return orderedCandidates.filter((candidateId) => {
      const candidateStart = Date.parse(candidateId);
      return starts.some(
        (hourStart) => candidateStart >= hourStart && candidateStart < hourStart + 60 * 60 * 1000,
      );
    });
  };
  const requiredHeatingHourIds = expand(constraints.requiredHeatingHourIds);
  for (const requiredId of constraints.requiredHeatingHourIds) {
    const requiredStart = Date.parse(requiredId);
    if (!Number.isFinite(requiredStart)) return { ok: false, reason: "required_hour_missing" };
    const covered = requiredHeatingHourIds
      .filter((candidateId) => {
        const start = Date.parse(candidateId);
        return start >= requiredStart && start < requiredStart + 60 * 60 * 1000;
      })
      .reduce((sum, candidateId) => sum + (candidateDurationById.get(candidateId) ?? 0), 0);
    const hourEnd = requiredStart + 60 * 60 * 1000;
    const expectedCoverageStart = Math.max(requiredStart, now.getTime());
    const expectedCoverageMs = Math.max(hourEnd - expectedCoverageStart, 0);
    if (covered < expectedCoverageMs) return { ok: false, reason: "required_hour_missing" };
  }
  return {
    ok: true,
    forbiddenHeatingHourIds: expand(constraints.forbiddenHeatingHourIds),
    requiredHeatingHourIds,
  };
}

function worstCaseStandingLossKwhPerHour({ inletBaselineC, maxTankTemperatureC }: { inletBaselineC: number; maxTankTemperatureC: number }) {
  const tank = sensorGeometryV2.tank;
  const topHeight = tank.heightCm - sensorGeometryV2.topSensorDistanceFromTopCm;
  const boundary = (topHeight + sensorGeometryV2.bottomSensorHeightFromBottomCm) / 2;
  const bottomMassKg = tank.nominalVolumeLiters * Math.max(0, Math.min(boundary / tank.heightCm, 1));
  const topMassKg = tank.nominalVolumeLiters - bottomMassKg;
  const topAfter = applyNewtonCooling(maxTankTemperatureC, liveReserveShadowConfig.topHeatLossTimeConstantHours);
  const bottomAfter = applyNewtonCooling(maxTankTemperatureC, liveReserveShadowConfig.bottomHeatLossTimeConstantHours);
  const before = layerEnergy(topMassKg, maxTankTemperatureC, inletBaselineC) + layerEnergy(bottomMassKg, maxTankTemperatureC, inletBaselineC);
  const after = layerEnergy(topMassKg, topAfter, inletBaselineC) + layerEnergy(bottomMassKg, bottomAfter, inletBaselineC);
  return Math.max(before - after, 0);
}

const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

function helsinkiHour(date: Date) {
  const hour = Number(
    helsinkiHourFormatter.formatToParts(date).find((part) => part.type === "hour")?.value,
  );
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0;
}

function applyNewtonCooling(temperatureC: number, timeConstantHours: number) {
  return liveReserveShadowConfig.ambientTempC + (temperatureC - liveReserveShadowConfig.ambientTempC) * Math.exp(-1 / timeConstantHours);
}

function layerEnergy(massKg: number, temperatureC: number, inletTempC: number) {
  return Math.max(massKg * liveReserveShadowConfig.specificHeatKwhPerKgC * (temperatureC - inletTempC), 0);
}

function helsinkiDateKey(date: Date) {
  const parts = helsinkiDateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function helsinkiDateKeyOffset(date: Date, dayOffset: number) {
  const key = helsinkiDateKey(date);
  const [year, month, day] = key.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return "";
  return helsinkiDateKey(new Date(Date.UTC(year, month - 1, day + dayOffset, 12)));
}

function unavailable(reason: string, standingLossKwhPerHour: number | null = null): LiveEnergyPlanShadowResult {
  return {
    available: false,
    assumption,
    candidateCount: 0,
    evaluatedCombinationCount: 0,
    firstSafetyViolationAt: null,
    firstTargetMissAt: null,
    forecastHorizonEndAt: null,
    finalConservativeEnergyKwh: null,
    minimumConservativeEnergyKwh: null,
    reason,
    selectedHeatingEnergyKwh: null,
    selectedHeatingHourIds: [],
    standingLossKwhPerHour: standingLossKwhPerHour === null ? null : round(standingLossKwhPerHour),
    totalCostCents: null,
    valid: null,
    learnedDropProfileUsed: false,
    learnedDropProfileDate: null,
    learnedDropProfileAgeDays: null,
    maximumModeledLossKwhPerHour: standingLossKwhPerHour === null ? null : round(standingLossKwhPerHour),
    effectiveConstraints: null,
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
