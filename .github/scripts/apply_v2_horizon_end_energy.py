from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))

# planShadow: expose optimizer final conservative energy.
path = "energiazen-mini/supabase/functions/run-v2-energy-shadow/planShadow.ts"
replace_once(path,
"  forecastHorizonEndAt: string | null;\n  minimumConservativeEnergyKwh: number | null;",
"  forecastHorizonEndAt: string | null;\n  finalConservativeEnergyKwh: number | null;\n  minimumConservativeEnergyKwh: number | null;")
replace_once(path,
"    forecastHorizonEndAt: horizon.horizonEndAt,\n    minimumConservativeEnergyKwh: plan.forecast.minimumConservativeEnergyKwh,",
"    forecastHorizonEndAt: horizon.horizonEndAt,\n    finalConservativeEnergyKwh: plan.forecast.finalConservativeEnergyKwh,\n    minimumConservativeEnergyKwh: plan.forecast.minimumConservativeEnergyKwh,")
replace_once(path,
"    forecastHorizonEndAt: null,\n    minimumConservativeEnergyKwh: null,",
"    forecastHorizonEndAt: null,\n    finalConservativeEnergyKwh: null,\n    minimumConservativeEnergyKwh: null,")

# Persist and expose final forecast value from the V2 edge function.
path = "energiazen-mini/supabase/functions/run-v2-energy-shadow/index.ts"
replace_once(path,
"      forecast_standing_loss_kwh_per_hour: plan.standingLossKwhPerHour,\n      forecast_min_conservative_energy_kwh: plan.minimumConservativeEnergyKwh,",
"      forecast_standing_loss_kwh_per_hour: plan.standingLossKwhPerHour,\n      forecast_final_conservative_energy_kwh: plan.finalConservativeEnergyKwh,\n      forecast_min_conservative_energy_kwh: plan.minimumConservativeEnergyKwh,")
replace_once(path,
"      plan_total_cost_cents: plan.totalCostCents, forecast_horizon_end_at: plan.forecastHorizonEndAt,\n      forecast_min_conservative_energy_kwh: plan.minimumConservativeEnergyKwh,",
"      plan_total_cost_cents: plan.totalCostCents, forecast_horizon_end_at: plan.forecastHorizonEndAt,\n      forecast_final_conservative_energy_kwh: plan.finalConservativeEnergyKwh,\n      forecast_min_conservative_energy_kwh: plan.minimumConservativeEnergyKwh,")

# Home RPC/presentation model.
path = "energiazen-mini/lib/v2HomeReservePresentation.ts"
replace_once(path,
"  forecast_min_conservative_energy_kwh: number | null;\n  forecast_horizon_end_at: string | null;",
"  forecast_min_conservative_energy_kwh: number | null;\n  forecast_final_conservative_energy_kwh: number | null;\n  forecast_horizon_end_at: string | null;")
replace_once(path,
"  forecastMinimumEnergyKwh: number | null;\n  forecastMinimumPercent: number | null;",
"  forecastMinimumEnergyKwh: number | null;\n  forecastMinimumPercent: number | null;\n  forecastFinalEnergyKwh: number | null;\n  forecastFinalPercent: number | null;")
replace_once(path,
"  const forecastMinimumEnergy = reserve?.forecast_min_conservative_energy_kwh;\n  const forecastHorizonEndAt = reserve?.forecast_horizon_end_at;",
"  const forecastMinimumEnergy = reserve?.forecast_min_conservative_energy_kwh;\n  const forecastFinalEnergy = reserve?.forecast_final_conservative_energy_kwh;\n  const forecastHorizonEndAt = reserve?.forecast_horizon_end_at;")
replace_once(path,
"    forecastMinimumEnergy >= 0 &&\n    typeof forecastHorizonEndAt === \"string\" &&",
"    forecastMinimumEnergy >= 0 &&\n    typeof forecastFinalEnergy === \"number\" &&\n    Number.isFinite(forecastFinalEnergy) &&\n    forecastFinalEnergy >= 0 &&\n    typeof forecastHorizonEndAt === \"string\" &&")
replace_once(path,
"      forecastMinimumEnergyKwh: null,\n      forecastMinimumPercent: null,\n      forecastHorizonEndAt: null,",
"      forecastMinimumEnergyKwh: null,\n      forecastMinimumPercent: null,\n      forecastFinalEnergyKwh: null,\n      forecastFinalPercent: null,\n      forecastHorizonEndAt: null,")
replace_once(path,
"  const forecastMinimumPercent = clamp((forecastMinimumEnergy / capacity) * 100, 0, 100);\n  return {",
"  const forecastMinimumPercent = clamp((forecastMinimumEnergy / capacity) * 100, 0, 100);\n  const forecastFinalPercent = clamp((forecastFinalEnergy / capacity) * 100, 0, 100);\n  return {")
replace_once(path,
"    forecastMinimumEnergyKwh: forecastMinimumEnergy,\n    forecastMinimumPercent,\n    forecastHorizonEndAt,",
"    forecastMinimumEnergyKwh: forecastMinimumEnergy,\n    forecastMinimumPercent,\n    forecastFinalEnergyKwh: forecastFinalEnergy,\n    forecastFinalPercent,\n    forecastHorizonEndAt,")

# Hook default shape.
path = "energiazen-mini/lib/useV2HomeReserve.ts"
replace_once(path,
"  forecastMinimumEnergyKwh: null,\n  forecastMinimumPercent: null,\n  forecastHorizonEndAt: null,",
"  forecastMinimumEnergyKwh: null,\n  forecastMinimumPercent: null,\n  forecastFinalEnergyKwh: null,\n  forecastFinalPercent: null,\n  forecastHorizonEndAt: null,")

# Stored plan card: explicitly show tomorrow/horizon-end energy.
path = "energiazen-mini/lib/heatingPlanPresentation.ts"
replace_once(path,
"    forecastMinimumEnergyKwh: number | null;\n    forecastMinimumPercent: number | null;\n    percent: number | null;",
"    forecastMinimumEnergyKwh: number | null;\n    forecastMinimumPercent: number | null;\n    forecastFinalEnergyKwh: number | null;\n    forecastFinalPercent: number | null;\n    percent: number | null;")
replace_once(path,
"    v2EnergyReserve.forecastMinimumPercent !== null &&\n    v2EnergyReserve.targetReservePercent !== null &&",
"    v2EnergyReserve.forecastMinimumPercent !== null &&\n    v2EnergyReserve.forecastFinalEnergyKwh !== null &&\n    v2EnergyReserve.forecastFinalPercent !== null &&\n    v2EnergyReserve.targetReservePercent !== null &&")
replace_once(path,
"    ? `Nyt ${formatFinnishDecimal(v2EnergyReserve.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve.energyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve.forecastMinimumPercent as number)} % · tavoite ${formatFinnishDecimal(v2EnergyReserve.targetReservePercent as number)} % · turvaraja ${formatFinnishDecimal(v2EnergyReserve.safetyReservePercent as number)} %`",
"    ? `Nyt ${formatFinnishDecimal(v2EnergyReserve.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve.energyKwh as number)} kWh) · huomenna lopussa ${formatFinnishDecimal(v2EnergyReserve.forecastFinalPercent as number)} % (${formatFinnishDecimal(v2EnergyReserve.forecastFinalEnergyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve.forecastMinimumPercent as number)} %`")

# Unit test final forecast conversion.
path = "energiazen-mini/components/home/warm-water-card.test.ts"
replace_once(path,
"    forecast_min_conservative_energy_kwh: 10.6,\n    forecast_horizon_end_at: \"2026-09-17T21:00:00Z\",",
"    forecast_min_conservative_energy_kwh: 10.6,\n    forecast_final_conservative_energy_kwh: 13.3,\n    forecast_horizon_end_at: \"2026-09-17T21:00:00Z\",")
replace_once(path,
"  if (current.forecastMinimumPercent === null || Math.abs(current.forecastMinimumPercent - 59.98) >= 0.05) {\n    throw new Error(`expected V2 forecast minimum near 59.98%, got ${current.forecastMinimumPercent}`);\n  }",
"  if (current.forecastMinimumPercent === null || Math.abs(current.forecastMinimumPercent - 59.98) >= 0.05) {\n    throw new Error(`expected V2 forecast minimum near 59.98%, got ${current.forecastMinimumPercent}`);\n  }\n  if (current.forecastFinalPercent === null || Math.abs(current.forecastFinalPercent - 75.26) >= 0.05) {\n    throw new Error(`expected V2 horizon-end reserve near 75.26%, got ${current.forecastFinalPercent}`);\n  }")

# Database: add persisted field and extend authenticated RPC.
migration = Path("energiazen-mini/supabase/migrations/20260916161000_add_v2_forecast_final_energy.sql")
migration.write_text('''alter table public.v2_energy_reserve_shadow_runs\n  add column if not exists forecast_final_conservative_energy_kwh double precision;\n\ndrop function if exists public.get_v2_energy_reserve_home();\ncreate function public.get_v2_energy_reserve_home()\nreturns table (\n  run_at timestamptz,\n  available boolean,\n  conservative_energy_kwh double precision,\n  energy_capacity_kwh double precision,\n  safety_reserve_percent double precision,\n  target_reserve_percent double precision,\n  forecast_min_conservative_energy_kwh double precision,\n  forecast_final_conservative_energy_kwh double precision,\n  forecast_horizon_end_at timestamptz\n)\nlanguage sql\nsecurity definer\nset search_path = public, pg_temp\nstable\nas $$\n  select shadow.run_at, shadow.available, shadow.conservative_energy_kwh,\n    shadow.energy_capacity_kwh, shadow.safety_reserve_percent, shadow.target_reserve_percent,\n    shadow.forecast_min_conservative_energy_kwh, shadow.forecast_final_conservative_energy_kwh,\n    shadow.forecast_horizon_end_at\n  from public.v2_energy_reserve_shadow_runs as shadow\n  order by shadow.run_at desc\n  limit 1;\n$$;\nrevoke all on function public.get_v2_energy_reserve_home() from public, anon;\ngrant execute on function public.get_v2_energy_reserve_home() to authenticated;\n''')
