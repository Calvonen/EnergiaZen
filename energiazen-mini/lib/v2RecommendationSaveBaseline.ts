import type { EnergiaZenSettings } from "./settingsDefaults";

export type PendingV2Recommendation = {
  savedAt: string;
  value: number;
};

let loadedV2TargetReservePercent: number | null = null;
let pendingV2Recommendation: PendingV2Recommendation | null = null;
let effectiveSettingsPersister:
  | ((settings: EnergiaZenSettings) => Promise<void>)
  | null = null;
let pendingRecommendationPersister:
  | ((pending: PendingV2Recommendation | null) => Promise<void>)
  | null = null;

export function getLoadedV2TargetReservePercent() {
  return loadedV2TargetReservePercent;
}

export function setLoadedV2TargetReservePercent(value: number | null) {
  loadedV2TargetReservePercent = value;
}

export function getPendingV2Recommendation() {
  return pendingV2Recommendation;
}

export function hydratePendingV2Recommendation(
  pending: PendingV2Recommendation | null,
) {
  pendingV2Recommendation = pending;
}

export function registerPendingV2RecommendationPersister(
  persister: (pending: PendingV2Recommendation | null) => Promise<void>,
) {
  pendingRecommendationPersister = persister;
}

export async function persistPendingV2Recommendation(
  pending: PendingV2Recommendation | null,
) {
  pendingV2Recommendation = pending;

  if (!pendingRecommendationPersister) {
    return false;
  }

  await pendingRecommendationPersister(pending);
  return true;
}

export function isPendingV2RecommendationAcknowledged({
  pending,
  runAt,
  telemetryRecommendation,
}: {
  pending: PendingV2Recommendation;
  runAt: string | null | undefined;
  telemetryRecommendation: number | null | undefined;
}) {
  const savedAtMs = Date.parse(pending.savedAt);
  const runAtMs = Date.parse(runAt ?? "");

  return (
    Number.isFinite(savedAtMs) &&
    Number.isFinite(runAtMs) &&
    runAtMs > savedAtMs &&
    telemetryRecommendation === pending.value
  );
}

export function registerEffectiveSettingsPersister(
  persister: (settings: EnergiaZenSettings) => Promise<void>,
) {
  effectiveSettingsPersister = persister;
}

export async function persistEffectiveSettingsLocally(
  settings: EnergiaZenSettings,
) {
  if (!effectiveSettingsPersister) {
    return false;
  }

  await effectiveSettingsPersister(settings);
  return true;
}
