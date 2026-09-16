from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)


index_path = Path("energiazen-mini/app/(tabs)/index.tsx")
text = index_path.read_text()
text = replace_once(
    text,
    'import { useSettingsScenario } from "@/lib/settingsScenarioContext";\nimport { supabase } from "@/lib/supabase";',
    'import { useSettingsScenario } from "@/lib/settingsScenarioContext";\nimport { useV2HomeReserve } from "@/lib/useV2HomeReserve";\nimport { supabase } from "@/lib/supabase";',
    "settings import",
)
text = replace_once(
    text,
    'export default function HomeScreen() {\n  const homeRenderStartedAt = Date.now();\n  logHomeDayTabPerformance("HomeScreen render start");\n  const router = useRouter();',
    'export default function HomeScreen() {\n  const homeRenderStartedAt = Date.now();\n  logHomeDayTabPerformance("HomeScreen render start");\n  const router = useRouter();\n  const v2HomeReserve = useV2HomeReserve();',
    "HomeScreen",
)
text = replace_once(
    text,
    '''    const storedPlans = [
      storedHeatingPlans[todayPlanDate],
      storedHeatingPlans[tomorrowPlanDate],
    ].filter((plan): plan is StoredHeatingPlan => Boolean(plan));

    if (hasAmbiguousStoredHeatingPlanHour({ hourlyPrices, storedPlans })) {
      return null;
    }
''',
    '''    const storedPlans = [
      storedHeatingPlans[todayPlanDate],
      storedHeatingPlans[tomorrowPlanDate],
    ].filter((plan): plan is StoredHeatingPlan => Boolean(plan));
    const isV2EnergyPlan = storedPlans.some(
      (plan) => plan.reason === "V2 energy plan",
    );

    if (hasAmbiguousStoredHeatingPlanHour({ hourlyPrices, storedPlans })) {
      return null;
    }
''',
    "storedPlans",
)
text = replace_once(
    text,
    '''    const forecast =
      storedSelectedHeatingHourIds.length === storedPlannedHourCount
        ? buildStoredHeatingPlanForecastFields({
            currentBottomTemperature: bottomTemp,
            currentTopTemperature: topTemp,
            currentWeightedTemperature,
            hourlyDrops: hourlyTemperatureDropProfile,
            isCurrentlyHeating: isCurrentlyHeatingConfirmed,
            optimizationResult: activeOptimizationRun.result,
            optimizerHours: activeOptimizationRun.hours,
            recoveryReadings: tankTemperatureHistory,
            runSettings: activeOptimizationRun.appSettings,
            storedSelectedHeatingHourIds,
            todayPlanDate,
            tomorrowPlanDate,
          })
        : null;

    return buildStoredHeatingPlanPresentation({
      currentOptimizerPresentation: activeOptimizerPresentation,
      forecast,
      selectedHours,
    });
''',
    '''    const forecast =
      !isV2EnergyPlan &&
      storedSelectedHeatingHourIds.length === storedPlannedHourCount
        ? buildStoredHeatingPlanForecastFields({
            currentBottomTemperature: bottomTemp,
            currentTopTemperature: topTemp,
            currentWeightedTemperature,
            hourlyDrops: hourlyTemperatureDropProfile,
            isCurrentlyHeating: isCurrentlyHeatingConfirmed,
            optimizationResult: activeOptimizationRun.result,
            optimizerHours: activeOptimizationRun.hours,
            recoveryReadings: tankTemperatureHistory,
            runSettings: activeOptimizationRun.appSettings,
            storedSelectedHeatingHourIds,
            todayPlanDate,
            tomorrowPlanDate,
          })
        : null;

    return buildStoredHeatingPlanPresentation({
      currentOptimizerPresentation: isV2EnergyPlan
        ? null
        : activeOptimizerPresentation,
      forecast,
      selectedHours,
      v2EnergyReserve: isV2EnergyPlan ? v2HomeReserve : null,
    });
''',
    "stored forecast",
)
text = replace_once(
    text,
    '''    todayPlanDate,
    tomorrowPlanDate,
    topTemp,
  ]);''',
    '''    todayPlanDate,
    tomorrowPlanDate,
    topTemp,
    v2HomeReserve,
  ]);''',
    "stored presentation dependency",
)
index_path.write_text(text)

presentation_path = Path("energiazen-mini/lib/heatingPlanPresentation.ts")
p = presentation_path.read_text()
p = replace_once(
    p,
    '''export function buildStoredHeatingPlanPresentation({
  currentOptimizerPresentation = null,
  forecast = null,
  selectedHours,
}: {
''',
    '''export function buildStoredHeatingPlanPresentation({
  currentOptimizerPresentation = null,
  forecast = null,
  selectedHours,
  v2EnergyReserve = null,
}: {
''',
    "presentation signature",
)
p = replace_once(
    p,
    '''  forecast?: {
    forecastDetails: HeatingPlanForecastDetails;
    forecastSummary: string;
  } | null;
  selectedHours: HeatingPlanPresentation["selectedHours"];
}): HeatingPlanPresentation {
  return {
''',
    '''  forecast?: {
    forecastDetails: HeatingPlanForecastDetails;
    forecastSummary: string;
  } | null;
  selectedHours: HeatingPlanPresentation["selectedHours"];
  v2EnergyReserve?: {
    available: boolean;
    capacityKwh: number | null;
    energyKwh: number | null;
    forecastMinimumEnergyKwh: number | null;
    forecastMinimumPercent: number | null;
    percent: number | null;
    safetyReservePercent: number | null;
    targetReservePercent: number | null;
  } | null;
}): HeatingPlanPresentation {
  const v2ForecastAvailable =
    v2EnergyReserve?.available === true &&
    v2EnergyReserve.percent !== null &&
    v2EnergyReserve.energyKwh !== null &&
    v2EnergyReserve.capacityKwh !== null &&
    v2EnergyReserve.forecastMinimumPercent !== null &&
    v2EnergyReserve.targetReservePercent !== null &&
    v2EnergyReserve.safetyReservePercent !== null;
  const v2ForecastSummary = v2ForecastAvailable
    ? `Nyt ${formatFinnishDecimal(v2EnergyReserve.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve.energyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve.forecastMinimumPercent as number)} % · tavoite ${formatFinnishDecimal(v2EnergyReserve.targetReservePercent as number)} % · turvaraja ${formatFinnishDecimal(v2EnergyReserve.safetyReservePercent as number)} %`
    : "V2-energiavaraennuste ei ole juuri nyt saatavilla.";

  return {
''',
    "presentation type",
)
p = replace_once(
    p,
    '''    forecastDetails: forecast?.forecastDetails ?? null,
    forecastSectionLabel: "Ennuste",
    forecastSummary:
      forecast?.forecastSummary ??
      "Tallennetulle suunnitelmalle ei ole saatavilla luotettavaa ennustetta.",''',
    '''    forecastDetails: v2EnergyReserve ? null : forecast?.forecastDetails ?? null,
    forecastSectionLabel: v2EnergyReserve ? "V2-energiavara" : "Ennuste",
    forecastSummary: v2EnergyReserve
      ? v2ForecastSummary
      : forecast?.forecastSummary ??
        "Tallennetulle suunnitelmalle ei ole saatavilla luotettavaa ennustetta.",''',
    "forecast presentation",
)
p = replace_once(
    p,
    '''    limitsSectionLabel: currentOptimizerPresentation
      ? "Nykyiset rajat"
      : "Käytetyt rajat",
    limitsSummary: currentOptimizerPresentation
      ? currentOptimizerPresentation.limitsSummary
      : "Tavoite- ja turvarajat eivät sisälly tallennettuun suunnitelmaan.",
    priceToleranceSummary: currentOptimizerPresentation
      ? currentOptimizerPresentation.priceToleranceSummary
      : null,
    reason: "Näytetään viimeksi tallennetut lämmitystunnit.",''',
    '''    limitsSectionLabel: v2EnergyReserve
      ? "V2-rajat"
      : currentOptimizerPresentation
        ? "Nykyiset rajat"
        : "Käytetyt rajat",
    limitsSummary:
      v2EnergyReserve &&
      v2EnergyReserve.targetReservePercent !== null &&
      v2EnergyReserve.safetyReservePercent !== null
        ? `Tavoite ${formatFinnishDecimal(v2EnergyReserve.targetReservePercent)} % · turvaraja ${formatFinnishDecimal(v2EnergyReserve.safetyReservePercent)} %`
        : currentOptimizerPresentation
          ? currentOptimizerPresentation.limitsSummary
          : "Tavoite- ja turvarajat eivät sisälly tallennettuun suunnitelmaan.",
    priceToleranceSummary: v2EnergyReserve
      ? null
      : currentOptimizerPresentation
        ? currentOptimizerPresentation.priceToleranceSummary
        : null,
    reason: v2EnergyReserve
      ? "V2 optimoi lämmitystunnit energiavaran ja hinnan perusteella."
      : "Näytetään viimeksi tallennetut lämmitystunnit.",''',
    "V2 limits",
)
p = replace_once(
    p,
    '    statusSummary: "Viimeksi tallennettu suunnitelma",',
    '''    statusSummary: v2EnergyReserve
      ? v2ForecastAvailable
        ? "V2-suunnitelma käytössä"
        : "V2-suunnitelma käytössä · ennuste ei saatavilla"
      : "Viimeksi tallennettu suunnitelma",''',
    "status summary",
)
presentation_path.write_text(p)

reserve_path = Path("energiazen-mini/lib/v2HomeReservePresentation.ts")
r = reserve_path.read_text()
r = replace_once(
    r,
    '  target_reserve_percent: number | null;\n};',
    '  target_reserve_percent: number | null;\n  forecast_min_conservative_energy_kwh: number | null;\n  forecast_horizon_end_at: string | null;\n};',
    "snapshot fields",
)
r = replace_once(
    r,
    '  targetReservePercent: number | null;\n};',
    '  targetReservePercent: number | null;\n  forecastMinimumEnergyKwh: number | null;\n  forecastMinimumPercent: number | null;\n  forecastHorizonEndAt: string | null;\n};',
    "presentation fields",
)
r = replace_once(
    r,
    '  const targetReservePercent = reserve?.target_reserve_percent;\n  const valid =',
    '  const targetReservePercent = reserve?.target_reserve_percent;\n  const forecastMinimumEnergy = reserve?.forecast_min_conservative_energy_kwh;\n  const forecastHorizonEndAt = reserve?.forecast_horizon_end_at;\n  const valid =',
    "forecast values",
)
r = replace_once(
    r,
    '    targetReservePercent >= 0 &&\n    targetReservePercent <= 100;',
    '    targetReservePercent >= 0 &&\n    targetReservePercent <= 100 &&\n    typeof forecastMinimumEnergy === "number" &&\n    Number.isFinite(forecastMinimumEnergy) &&\n    forecastMinimumEnergy >= 0 &&\n    typeof forecastHorizonEndAt === "string" &&\n    Number.isFinite(Date.parse(forecastHorizonEndAt));',
    "forecast validation",
)
r = replace_once(
    r,
    '      targetReservePercent: null,\n    };',
    '      targetReservePercent: null,\n      forecastMinimumEnergyKwh: null,\n      forecastMinimumPercent: null,\n      forecastHorizonEndAt: null,\n    };',
    "unavailable forecast fields",
)
r = replace_once(
    r,
    '  const percent = clamp((energy / capacity) * 100, 0, 100);\n  return {',
    '  const percent = clamp((energy / capacity) * 100, 0, 100);\n  const forecastMinimumPercent = clamp((forecastMinimumEnergy / capacity) * 100, 0, 100);\n  return {',
    "forecast percent",
)
r = replace_once(
    r,
    '    targetReservePercent,\n  };',
    '    targetReservePercent,\n    forecastMinimumEnergyKwh: forecastMinimumEnergy,\n    forecastMinimumPercent,\n    forecastHorizonEndAt,\n  };',
    "forecast result fields",
)
reserve_path.write_text(r)

Path("energiazen-mini/lib/useV2HomeReserve.ts").write_text(
    '''import { useCallback, useEffect, useState } from "react";

import { supabase } from "./supabase";
import {
  buildV2HomeReservePresentation,
  type V2HomeReservePresentation,
  type V2HomeReserveSnapshot,
} from "./v2HomeReservePresentation";

const refreshIntervalMs = 60_000;

const unavailablePresentation: V2HomeReservePresentation = {
  available: false,
  fillPercent: 0,
  percent: null,
  energyKwh: null,
  capacityKwh: null,
  safetyReservePercent: null,
  targetReservePercent: null,
  forecastMinimumEnergyKwh: null,
  forecastMinimumPercent: null,
  forecastHorizonEndAt: null,
};

export function useV2HomeReserve() {
  const [presentation, setPresentation] = useState<V2HomeReservePresentation>(
    unavailablePresentation,
  );

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_v2_energy_reserve_home");
    if (error) {
      setPresentation(unavailablePresentation);
      return;
    }

    const row = Array.isArray(data) ? data[0] ?? null : data;
    setPresentation(
      buildV2HomeReservePresentation(
        (row ?? null) as V2HomeReserveSnapshot | null,
        Date.now(),
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = setInterval(() => void refresh(), refreshIntervalMs);
    return () => clearInterval(intervalId);
  }, [refresh]);

  return presentation;
}
'''
)

Path("energiazen-mini/supabase/migrations/20260916153500_extend_v2_energy_reserve_home_forecast.sql").write_text(
    '''-- Extend the authenticated Home reserve RPC with the V2 plan forecast minimum.
-- The full shadow table remains service-role only.
drop function if exists public.get_v2_energy_reserve_home();

create function public.get_v2_energy_reserve_home()
returns table (
  run_at timestamptz,
  available boolean,
  conservative_energy_kwh double precision,
  energy_capacity_kwh double precision,
  safety_reserve_percent double precision,
  target_reserve_percent double precision,
  forecast_min_conservative_energy_kwh double precision,
  forecast_horizon_end_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    shadow.run_at,
    shadow.available,
    shadow.conservative_energy_kwh,
    shadow.energy_capacity_kwh,
    shadow.safety_reserve_percent,
    shadow.target_reserve_percent,
    shadow.forecast_min_conservative_energy_kwh,
    shadow.forecast_horizon_end_at
  from public.v2_energy_reserve_shadow_runs as shadow
  order by shadow.run_at desc
  limit 1;
$$;

revoke all on function public.get_v2_energy_reserve_home() from public, anon;
grant execute on function public.get_v2_energy_reserve_home() to authenticated;
'''
)

test_path = Path("energiazen-mini/components/home/warm-water-card.test.ts")
t = test_path.read_text()
t = replace_once(
    t,
    '    target_reserve_percent: 75,\n  };',
    '    target_reserve_percent: 75,\n    forecast_min_conservative_energy_kwh: 10.6,\n    forecast_horizon_end_at: "2026-09-17T21:00:00Z",\n  };',
    "reserve fixture",
)
marker = '''  if (current.safetyReservePercent !== 30 || current.targetReservePercent !== 75) {
    throw new Error("expected current production reserve limits to be presented from the validated snapshot");
  }
'''
addition = marker + '''  if (current.forecastMinimumPercent === null || Math.abs(current.forecastMinimumPercent - 59.98) >= 0.05) {
    throw new Error(`expected V2 forecast minimum near 59.98%, got ${current.forecastMinimumPercent}`);
  }
'''
t = replace_once(t, marker, addition, "reserve assertion")
test_path.write_text(t)
