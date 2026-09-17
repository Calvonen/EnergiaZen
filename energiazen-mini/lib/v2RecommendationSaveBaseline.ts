let loadedV2TargetReservePercent: number | null = null;
let effectiveSavedV2TargetReservePercent: number | null = null;

export function getLoadedV2TargetReservePercent() {
  return loadedV2TargetReservePercent;
}

export function setLoadedV2TargetReservePercent(value: number | null) {
  loadedV2TargetReservePercent = value;
}

export function setEffectiveSavedV2TargetReservePercent(value: number | null) {
  effectiveSavedV2TargetReservePercent = value;
}

export function consumeEffectiveSavedV2TargetReservePercent() {
  const value = effectiveSavedV2TargetReservePercent;
  effectiveSavedV2TargetReservePercent = null;
  return value;
}
