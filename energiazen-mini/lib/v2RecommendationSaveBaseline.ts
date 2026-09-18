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
const pendingRecommendationListeners = new Set<() => void>();

function notifyPendingRecommendationListeners() {
  for (const listener of pendingRecommendationListeners) {
    listener();
  }
}

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
  notifyPendingRecommendationListeners();
}

export function subscribePendingV2Recommendation(listener: () => void) {
  pendingRecommendationListeners.add(listener);
  return () => {
    pendingRecommendationListeners.delete(listener);
  };
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
  notifyPendingRecommendationListeners();

  if (!pendingRecommendationPersister) {
    return false;
  }

  await pendingRecommendationPersister(pending);
  return true;
}

export function isPendingV2RecommendationAcknowledged({
  pending,
  runAt,
}: {
  pending: PendingV2Recommendation;
  runAt: string | null | undefined;
  telemetryRecommendation: number | null | undefined;
}) {
  const savedAtMs = Date.parse(pending.savedAt);
  const runAtMs = Date.parse(runAt ?? "");

  // Any shadow run created after the save settles the pending write. A matching
  // value confirms this device's save; a different value means a later write
  // from another client superseded it and telemetry becomes authoritative.
  return (
    Number.isFinite(savedAtMs) &&
    Number.isFinite(runAtMs) &&
    runAtMs > savedAtMs
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
