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
// check. backup_hours/fallback_enabled are selected purely so
// mergeHeatingControlSettingsBackfillPayload below can preserve them too if
// already authoritative - they likewise play no part in the completeness
// check (Shelly's own fail-safe fields, not run-heating-optimizer readiness
// inputs).
export const heatingControlSettingsCompletenessColumns =
  "heating_need_mode,automatic_max_heating_hours,safety_shower_reserve,target_shower_reserve,full_tank_showers,full_tank_average_temperature,min_tank_temperature,max_tank_temperature,heating_gain_source,backup_hours,fallback_enabled,updated_at";

export type HeatingControlSettingsCompletenessRow = {
  automatic_max_heating_hours: number | null;
  backup_hours: number[] | null;
  fallback_enabled: boolean | null;
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

function isValidHeatingNeedMode(
  value: string | null,
): value is "automatic" | "fixed" {
  return value === "automatic" || value === "fixed";
}

function isValidHeatingGainSource(
  value: string | null,
): value is "learned" | "fixed" {
  return value === "learned" || value === "fixed";
}

function isValidBackupHours(value: number[] | null): value is number[] {
  return Array.isArray(value) && value.length > 0;
}

// True only once the Supabase row carries every authoritative optimizer
// input run-heating-optimizer's publication-readiness gate requires -
// regardless of which mode is currently selected (a "fixed"-mode row still
// needs complete numeric fields so backend-primary is instantly ready the
// moment the user later switches to automatic). Existing installs created
// before these columns existed have every one of them NULL, which this
// correctly reports as not-yet-authoritative. Deliberately does not
// consider backup_hours/fallback_enabled - those are Shelly's own fail-safe
// fields, not part of run-heating-optimizer's readiness gate.
export function isHeatingControlSettingsRowAuthoritative(
  row: HeatingControlSettingsCompletenessRow | null,
): boolean {
  if (!row) {
    return false;
  }

  return (
    isValidHeatingNeedMode(row.heating_need_mode) &&
    Number.isFinite(row.automatic_max_heating_hours) &&
    Number.isFinite(row.full_tank_average_temperature) &&
    Number.isFinite(row.full_tank_showers) &&
    Number.isFinite(row.max_tank_temperature) &&
    Number.isFinite(row.min_tank_temperature) &&
    Number.isFinite(row.safety_shower_reserve) &&
    Number.isFinite(row.target_shower_reserve) &&
    isValidHeatingGainSource(row.heating_gain_source)
  );
}

// The subset of HeatingControlSettingsPayload (lib/heatingControlSettingsPayload.ts)
// that mergeHeatingControlSettingsBackfillPayload below can fill from local
// settings - a structurally-compatible local type rather than importing
// that module's type, so this file stays self-contained. id/timezone/
// updated_at are excluded: they are never "local vs. remote", they're
// always set the same way regardless of which side wins per field.
export type HeatingControlSettingsBackfillPayloadFields = {
  automatic_max_heating_hours: number;
  backup_hours: number[];
  fallback_enabled: boolean;
  full_tank_average_temperature: number;
  full_tank_showers: number;
  heating_gain_source: "learned" | "fixed";
  heating_need_mode: "automatic" | "fixed";
  max_tank_temperature: number;
  min_tank_temperature: number;
  safety_shower_reserve: number;
  target_shower_reserve: number;
};

// Codex P2 (PR #193, startup backfill follow-up): the original backfill
// wrote a full payload built purely from local AsyncStorage settings
// whenever the remote row was not YET fully authoritative - even if the
// remote row already had some fields correctly set (e.g. by another
// device), those already-good values would be silently overwritten by this
// device's possibly-stale local copy just because some OTHER field was
// still missing.
//
// This merges field-by-field instead: the observed remote row is the base,
// and a field only falls back to localPayload's value when the remote
// value is missing/invalid. A field that is already valid on the remote row
// - including heating_need_mode itself - is preserved verbatim, never
// replaced by the local value even if they differ. That is what stops a
// stale local "fixed" from reverting a freshly-set remote "automatic" (or
// vice versa) during the exact same kind of incomplete-row backfill this
// module exists to handle.
export function mergeHeatingControlSettingsBackfillPayload<
  T extends HeatingControlSettingsBackfillPayloadFields,
>(
  localPayload: T,
  observedRow: HeatingControlSettingsCompletenessRow | null,
): T {
  if (!observedRow) {
    return localPayload;
  }

  return {
    ...localPayload,
    automatic_max_heating_hours: Number.isFinite(
      observedRow.automatic_max_heating_hours,
    )
      ? (observedRow.automatic_max_heating_hours as number)
      : localPayload.automatic_max_heating_hours,
    backup_hours: isValidBackupHours(observedRow.backup_hours)
      ? observedRow.backup_hours
      : localPayload.backup_hours,
    fallback_enabled:
      typeof observedRow.fallback_enabled === "boolean"
        ? observedRow.fallback_enabled
        : localPayload.fallback_enabled,
    full_tank_average_temperature: Number.isFinite(
      observedRow.full_tank_average_temperature,
    )
      ? (observedRow.full_tank_average_temperature as number)
      : localPayload.full_tank_average_temperature,
    full_tank_showers: Number.isFinite(observedRow.full_tank_showers)
      ? (observedRow.full_tank_showers as number)
      : localPayload.full_tank_showers,
    heating_gain_source: isValidHeatingGainSource(
      observedRow.heating_gain_source,
    )
      ? observedRow.heating_gain_source
      : localPayload.heating_gain_source,
    heating_need_mode: isValidHeatingNeedMode(observedRow.heating_need_mode)
      ? observedRow.heating_need_mode
      : localPayload.heating_need_mode,
    max_tank_temperature: Number.isFinite(observedRow.max_tank_temperature)
      ? (observedRow.max_tank_temperature as number)
      : localPayload.max_tank_temperature,
    min_tank_temperature: Number.isFinite(observedRow.min_tank_temperature)
      ? (observedRow.min_tank_temperature as number)
      : localPayload.min_tank_temperature,
    safety_shower_reserve: Number.isFinite(observedRow.safety_shower_reserve)
      ? (observedRow.safety_shower_reserve as number)
      : localPayload.safety_shower_reserve,
    target_shower_reserve: Number.isFinite(observedRow.target_shower_reserve)
      ? (observedRow.target_shower_reserve as number)
      : localPayload.target_shower_reserve,
  };
}

export type HeatingControlSettingsSyncOutcome =
  | "already_synced"
  | "backfilled"
  | "backfill_failed"
  | "check_failed";

// Pure orchestration, DI'd for testing without a real Supabase client.
//
// Never substitutes an arbitrary backend default for a missing field: the
// only value ever used as a fallback is localSettings, i.e. exactly what
// loadSettings() already resolved from AsyncStorage (the app's own real -
// possibly still factory-default, but never "backend arbitrary" -
// effective settings), and only for fields the observed remote row does not
// already have. It never rewrites an already-valid remote heating_need_mode
// to "automatic": mergeHeatingControlSettingsBackfillPayload preserves
// whatever valid mode the row already has, and only ever falls back to
// localSettings.heatingNeedMode when the row had none.
//
// Race safety (Codex P2, PR #193): fetchRow() and the write below are two
// separate round trips, so another device or a Settings save can make the
// row authoritative in between. upsertIfUnchanged is a compare-and-swap
// gated on the exact row observed - it must return false, not perform the
// write, if that state no longer matches. Losing the race means someone
// else's write already happened, so this re-reads once and trusts it
// (isHeatingControlSettingsRowAuthoritative on the fresh read) instead of
// blindly retrying with a now-stale local snapshot. No new tables/state:
// the CAS token is the row's own existing updated_at column, and the
// retry-on-loss path reuses fetchRow.
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
    observedRow: HeatingControlSettingsCompletenessRow | null,
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

  let wrote: boolean;
  try {
    wrote = await upsertIfUnchanged(localSettings, fetchResult.data);
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
