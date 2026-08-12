export const defaultTargetShowerReserve = 4;
export const defaultSafetyShowerReserve = 2;

function roundToHalf(value: number) {
  return Math.round(value * 2) / 2;
}

export function normalizeShowerReserves({
  fullTankShowers,
  safetyShowerReserve,
  targetShowerReserve,
}: {
  fullTankShowers: number;
  safetyShowerReserve?: number;
  targetShowerReserve?: number;
}) {
  const normalizedTarget = Math.min(
    Math.max(
      roundToHalf(targetShowerReserve ?? defaultTargetShowerReserve),
      0.5,
    ),
    fullTankShowers,
  );
  const normalizedSafety = Math.min(
    Math.max(
      roundToHalf(safetyShowerReserve ?? defaultSafetyShowerReserve),
      0,
    ),
    normalizedTarget - 0.5,
  );

  return {
    safetyShowerReserve: Math.max(0, normalizedSafety),
    targetShowerReserve: normalizedTarget,
  };
}

export function normalizeStoredShowerReserves({
  fullTankShowers,
  minimumShowersBeforeExpensiveTomorrow,
  safetyShowerReserve,
  targetShowerReserve,
}: {
  fullTankShowers: number;
  minimumShowersBeforeExpensiveTomorrow?: number;
  safetyShowerReserve?: number;
  targetShowerReserve?: number;
}) {
  return normalizeShowerReserves({
    fullTankShowers,
    safetyShowerReserve,
    targetShowerReserve:
      targetShowerReserve ?? minimumShowersBeforeExpensiveTomorrow,
  });
}

export function getShowerReserveOptions({
  fullTankShowers,
  safetyShowerReserve,
  targetShowerReserve,
  type,
}: {
  fullTankShowers: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
  type: "safety" | "target";
}) {
  const minimum = type === "target" ? safetyShowerReserve + 0.5 : 0;
  const maximum =
    type === "target" ? fullTankShowers : targetShowerReserve - 0.5;

  return Array.from(
    { length: Math.max(0, Math.floor((maximum - minimum) * 2) + 1) },
    (_, index) => minimum + index * 0.5,
  );
}
