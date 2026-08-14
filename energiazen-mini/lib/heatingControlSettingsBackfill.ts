import type { EnergiaZenSettings } from "./settings";

// Kept in the same order/shape as resolveOptimizerSettings's readiness
// check in supabase/functions/run-heating-optimizer/logic.ts, but as an
// independent app-side implementation rather than a cross-module import -
// importing that Edge Function's logic.ts would pull its entire
// I/O-and-retry dependency tree into the React Native bundle for a single
// boolean check. Pinned to the exact same field list by
// tests/heatingControlSettingsBackfillSource.test.ts so the two can't
// silently drift apart.
// updated_at is selected purely as an optimistic-concurrency token for the
// conditional write in ensureHeatingControlSettingsBackfilled below - it
// plays no part in isHeatingControlSettingsRowAuthoritative's completeness
// check.
export const heatingControlSettingsCompletenessColumns =
  "heating_need_mode,automatic_max_heating_hours,safety_shower_reserve,target_shower_reserve,full_tank_showers,full_tank_average_temperature,min_tank_temperature,max_tank_temperature,heating_gain_source,updated_at";

export type HeatingControlSettingsCompletenessRow = {
  automatic_max_heating_hours: number | null;
  full_tank_average_temperature: number | null;
  full_tank_showers: number | null;
  heating_gain_source: string | null;
  heating_need_mode: string | null;
  max_tank_temperature: number | null;
  min_tank_temperature: number | null;
  safety_shower_reserve: number | null;
  target_shower_reserve: number | null;
  updated_at: string | null;
};

// True only once the Supabase row carries every authoritative optimizer
// input run-heating-optimizer's publication-readiness gate requires -
// regardless of which mode is currently selected (a "fixed"-mode row still
// needs complete numeric fields so backend-primary is instantly ready the
// moment the user later switches to automatic). Existing installs created
// before these columns existed have every one of them NULL, which this
// correctly reports as not-yet-authoritative.
export function isHeatingControlSettingsRowAuthoritative(
  row: HeatingControlSettingsCompletenessRow | null,
): boolean {
  if (!row) {
    return false;
  }

  return (
    (row.heating_need_mode === "automatic" || row.heating_need_mode === "fixed") &&
    Number.isFinite(row.automatic_max_heating_hours) &&
    Number.isFinite(row.full_tank_average_temperature) &&
    Number.isFinite(row.full_tank_showers) &&
    Number.isFinite(row.max_tank_temperature) &&
    Number.isFinite(row.min_tank_temperature) &&
    Number.isFinite(row.safety_shower_reserve) &&
    Number.isFinite(row.target_shower_reserve) &&
    (row.heating_gain_source === "learned" || row.heating_gain_source === "fixed")
  );
}

export type HeatingControlSettingsSyncOutcome =
  | "already_synced"
  | "backfilled"
  | "backfill_failed"
  | "check_failed";

// Pure orchestration, DI'd for testing without a real Supabase client.
//
// Never substitutes an arbitrary backend default for a missing field: the
// only value ever written is localSettings, i.e. exactly what loadSettings()
// already resolved from AsyncStorage (the app's own real - possibly still
// factory-default, but never "backend arbitrary" - effective settings). It
// never rewrites heating_need_mode to "automatic": buildHeatingControlSettingsPayload
// (called by upsertIfUnchanged) mirrors localSettings.heatingNeedMode
// verbatim, so a user already on fixed mode stays on fixed mode after a
// backfill.
//
// Race safety (Codex P2, PR #193): fetchRow() and the write below are two
// separate round trips, so another device or a Settings save can make the
// row authoritative in between. upsertIfUnchanged is a compare-and-swap
// gated on the exact row state just observed (rowExisted/observedUpdatedAt)
// - it must return false, not perform the write, if that state no longer
// matches. Losing the race means someone else's write already happened, so
// this re-reads once and trusts it (isHeatingControlSettingsRowAuthoritative
// on the fresh read) instead of blindly retrying with a now-stale local
// snapshot. No new tables/state: the CAS token is the row's own existing
// updated_at column, and the retry-on-loss path reuses fetchRow.
export async function ensureHeatingControlSettingsBackfilled({
  fetchRow,
  localSettings,
  upsertIfUnchanged,
}: {
  fetchRow: () => Promise<{
    data: HeatingControlSettingsCompletenessRow | null;
    error: unknown;
  }>;
  localSettings: EnergiaZenSettings;
  upsertIfUnchanged: (
    settings: EnergiaZenSettings,
    rowExisted: boolean,
    observedUpdatedAt: string | null,
  ) => Promise<boolean>;
}): Promise<HeatingControlSettingsSyncOutcome> {
  let fetchResult: {
    data: HeatingControlSettingsCompletenessRow | null;
    error: unknown;
  };

  try {
    fetchResult = await fetchRow();
  } catch {
    return "check_failed";
  }

  if (fetchResult.error) {
    return "check_failed";
  }

  if (isHeatingControlSettingsRowAuthoritative(fetchResult.data)) {
    return "already_synced";
  }

  const rowExisted = fetchResult.data !== null;
  const observedUpdatedAt = fetchResult.data?.updated_at ?? null;

  let wrote: boolean;
  try {
    wrote = await upsertIfUnchanged(localSettings, rowExisted, observedUpdatedAt);
  } catch {
    return "backfill_failed";
  }

  if (wrote) {
    return "backfilled";
  }

  // Lost the compare-and-swap: the row changed between the read above and
  // this write attempt. Re-read once and defer to whatever is there now
  // rather than overwrite it with localSettings.
  let recheckResult: {
    data: HeatingControlSettingsCompletenessRow | null;
    error: unknown;
  };

  try {
    recheckResult = await fetchRow();
  } catch {
    return "backfill_failed";
  }

  if (recheckResult.error) {
    return "backfill_failed";
  }

  return isHeatingControlSettingsRowAuthoritative(recheckResult.data)
    ? "already_synced"
    : "backfill_failed";
}

// Legacy-publisher gate helper: only "already_synced"/"backfilled" may ever
// disable the app's own automatic heating_plans publisher. Any failure
// (fetch error or backfill write error) must keep it enabled - never leave
// an install without a working automatic publisher.
export function isHeatingControlSettingsSyncOutcomeSynced(
  outcome: HeatingControlSettingsSyncOutcome,
): boolean {
  return outcome === "already_synced" || outcome === "backfilled";
}
