from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))

# Home reserve presentation: allow a clearly marked last-good display snapshot.
path = "energiazen-mini/lib/v2HomeReservePresentation.ts"
replace_once(path,
"export const HOME_RESERVE_MAX_AGE_MS = 12 * 60_000;",
"export const HOME_RESERVE_MAX_AGE_MS = 30 * 60_000;")
replace_once(path,
"  forecast_horizon_end_at: string | null;\n};",
"  forecast_horizon_end_at: string | null;\n  latest_run_at: string | null;\n  latest_run_available: boolean | null;\n  latest_unavailable_reason: string | null;\n};")
replace_once(path,
"  forecastHorizonEndAt: string | null;\n};",
"  forecastHorizonEndAt: string | null;\n  isFallback: boolean;\n  sourceAgeMinutes: number | null;\n  latestUnavailableReason: string | null;\n};")
replace_once(path,
"      forecastHorizonEndAt: null,\n    };",
"      forecastHorizonEndAt: null,\n      isFallback: false,\n      sourceAgeMinutes: null,\n      latestUnavailableReason: null,\n    };")
replace_once(path,
"  const percent = clamp((energy / capacity) * 100, 0, 100);\n  const forecastMinimumPercent = clamp((forecastMinimumEnergy / capacity) * 100, 0, 100);\n  const forecastFinalPercent = clamp((forecastFinalEnergy / capacity) * 100, 0, 100);\n  return {",
"  const percent = clamp((energy / capacity) * 100, 0, 100);\n  const forecastMinimumPercent = clamp((forecastMinimumEnergy / capacity) * 100, 0, 100);\n  const forecastFinalPercent = clamp((forecastFinalEnergy / capacity) * 100, 0, 100);\n  const runAtMs = Date.parse(reserve?.run_at ?? \"\");\n  const latestRunAtMs = Date.parse(reserve?.latest_run_at ?? \"\");\n  const sourceAgeMinutes = Number.isFinite(runAtMs) ? Math.max(0, (nowMs - runAtMs) / 60_000) : null;\n  const isFallback = reserve?.latest_run_available === false ||\n    (Number.isFinite(latestRunAtMs) && Number.isFinite(runAtMs) && latestRunAtMs > runAtMs);\n  return {")
replace_once(path,
"    forecastFinalPercent,\n    forecastHorizonEndAt,\n  };",
"    forecastFinalPercent,\n    forecastHorizonEndAt,\n    isFallback,\n    sourceAgeMinutes,\n    latestUnavailableReason: reserve?.latest_unavailable_reason ?? null,\n  };")

# Hook default presentation shape.
path = "energiazen-mini/lib/useV2HomeReserve.ts"
replace_once(path,
"  forecastHorizonEndAt: null,\n};",
"  forecastHorizonEndAt: null,\n  isFallback: false,\n  sourceAgeMinutes: null,\n  latestUnavailableReason: null,\n};")

# Heating plan card: label the last-good snapshot honestly.
path = "energiazen-mini/lib/heatingPlanPresentation.ts"
replace_once(path,
"    targetReservePercent: number | null;\n  } | null;",
"    targetReservePercent: number | null;\n    isFallback?: boolean;\n  } | null;")
replace_once(path,
"  const v2ForecastSummary = v2ForecastAvailable\n    ? `Nyt ${formatFinnishDecimal(v2EnergyReserve.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve.energyKwh as number)} kWh) · huomenna lopussa ${formatFinnishDecimal(v2EnergyReserve.forecastFinalPercent as number)} % (${formatFinnishDecimal(v2EnergyReserve.forecastFinalEnergyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve.forecastMinimumPercent as number)} %`\n    : \"V2-energiavaraennuste ei ole juuri nyt saatavilla.\";",
"  const v2ForecastSummary = v2ForecastAvailable\n    ? v2EnergyReserve.isFallback\n      ? `Viimeisin varma arvio ${formatFinnishDecimal(v2EnergyReserve.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve.energyKwh as number)} kWh) · huomenna lopussa ${formatFinnishDecimal(v2EnergyReserve.forecastFinalPercent as number)} % (${formatFinnishDecimal(v2EnergyReserve.forecastFinalEnergyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve.forecastMinimumPercent as number)} %`\n      : `Nyt ${formatFinnishDecimal(v2EnergyReserve.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve.energyKwh as number)} kWh) · huomenna lopussa ${formatFinnishDecimal(v2EnergyReserve.forecastFinalPercent as number)} % (${formatFinnishDecimal(v2EnergyReserve.forecastFinalEnergyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve.forecastMinimumPercent as number)} %`\n    : \"V2-energiavaraennuste ei ole juuri nyt saatavilla.\";")
replace_once(path,
"        ? \"V2-suunnitelma käytössä\"\n        : \"V2-suunnitelma käytössä · ennuste ei saatavilla\"",
"        ? v2EnergyReserve.isFallback\n          ? \"V2-suunnitelma käytössä · viimeisin varma arvio\"\n          : \"V2-suunnitelma käytössä\"\n        : \"V2-suunnitelma käytössä · ennuste ei saatavilla\"")

# Unit coverage for fallback and new 30 minute max display age.
path = "energiazen-mini/components/home/warm-water-card.test.ts"
replace_once(path,
"    forecast_horizon_end_at: \"2026-09-17T21:00:00Z\",\n  };",
"    forecast_horizon_end_at: \"2026-09-17T21:00:00Z\",\n    latest_run_at: \"2026-09-16T08:55:00Z\",\n    latest_run_available: true,\n    latest_unavailable_reason: null,\n  };")
replace_once(path,
"  const stale = buildV2HomeReservePresentation(\n    { ...base, run_at: \"2026-09-16T08:47:00Z\" },\n    now,\n  );",
"  const fallback = buildV2HomeReservePresentation(\n    {\n      ...base,\n      run_at: \"2026-09-16T08:50:00Z\",\n      latest_run_at: \"2026-09-16T08:59:00Z\",\n      latest_run_available: false,\n      latest_unavailable_reason: \"unresolved_water_draw_detected\",\n    },\n    now,\n  );\n  if (!fallback.available || !fallback.isFallback || fallback.percent === null) {\n    throw new Error(\"expected a recent last-good V2 snapshot to remain displayable as fallback\");\n  }\n\n  const stale = buildV2HomeReservePresentation(\n    { ...base, run_at: \"2026-09-16T08:29:00Z\" },\n    now,\n  );")
replace_once(path,
"    throw new Error(\"expected a 13-minute-old production snapshot and its limit markers to fail closed\");",
"    throw new Error(\"expected a 31-minute-old production snapshot and its limit markers to fail closed\");")

# DB RPC: return the newest complete available snapshot, plus latest-run health metadata.
migration = Path("energiazen-mini/supabase/migrations/20260916180000_home_last_good_v2_reserve.sql")
migration.write_text('''drop function if exists public.get_v2_energy_reserve_home();\ncreate function public.get_v2_energy_reserve_home()\nreturns table (\n  run_at timestamptz,\n  available boolean,\n  conservative_energy_kwh double precision,\n  energy_capacity_kwh double precision,\n  safety_reserve_percent double precision,\n  target_reserve_percent double precision,\n  forecast_min_conservative_energy_kwh double precision,\n  forecast_final_conservative_energy_kwh double precision,\n  forecast_horizon_end_at timestamptz,\n  latest_run_at timestamptz,\n  latest_run_available boolean,\n  latest_unavailable_reason text\n)\nlanguage sql\nsecurity definer\nset search_path = public, pg_temp\nstable\nas $$\n  with latest as (\n    select shadow.run_at, shadow.available, shadow.unavailable_reason\n    from public.v2_energy_reserve_shadow_runs as shadow\n    order by shadow.run_at desc\n    limit 1\n  ), last_good as (\n    select shadow.*\n    from public.v2_energy_reserve_shadow_runs as shadow\n    where shadow.available is true\n      and shadow.conservative_energy_kwh is not null\n      and shadow.energy_capacity_kwh is not null\n      and shadow.forecast_min_conservative_energy_kwh is not null\n      and shadow.forecast_final_conservative_energy_kwh is not null\n      and shadow.forecast_horizon_end_at is not null\n    order by shadow.run_at desc\n    limit 1\n  )\n  select good.run_at, true, good.conservative_energy_kwh, good.energy_capacity_kwh,\n    good.safety_reserve_percent, good.target_reserve_percent,\n    good.forecast_min_conservative_energy_kwh, good.forecast_final_conservative_energy_kwh,\n    good.forecast_horizon_end_at, latest.run_at, latest.available, latest.unavailable_reason\n  from last_good as good\n  cross join latest\n  where good.run_at >= now() - interval '30 minutes';\n$$;\nrevoke all on function public.get_v2_energy_reserve_home() from public, anon;\ngrant execute on function public.get_v2_energy_reserve_home() to authenticated;\n''')
