export type SensorGeometryVersion = "V1" | "V2";

export type TankPhysicalGeometry = {
  model: "Jäspi VLM-300 S";
  nominalVolumeLiters: 290;
  heightCm: 145;
};

export type SensorGeometry = {
  bottomSensorHeightFromBottomCm: number;
  effectiveFromInclusive: string | null;
  effectiveUntilExclusive: string | null;
  notes: string;
  tank: TankPhysicalGeometry;
  topSensorDistanceFromTopCm: number;
  version: SensorGeometryVersion;
};

export const jaspiVlm300SGeometry = {
  heightCm: 145,
  model: "Jäspi VLM-300 S",
  nominalVolumeLiters: 290,
} as const satisfies TankPhysicalGeometry;

export const sensorGeometryV1 = {
  bottomSensorHeightFromBottomCm: 22,
  effectiveFromInclusive: null,
  effectiveUntilExclusive: null,
  notes:
    "Historical geometry before the top sensor was moved; top sensor was 9 cm below the tank lid.",
  tank: jaspiVlm300SGeometry,
  topSensorDistanceFromTopCm: 9,
  version: "V1",
} as const satisfies SensorGeometry;

export const sensorGeometryV2 = {
  bottomSensorHeightFromBottomCm: 22,
  effectiveFromInclusive: null,
  effectiveUntilExclusive: null,
  notes:
    "Current geometry after the top sensor move; top sensor is 16 cm below the tank lid.",
  tank: jaspiVlm300SGeometry,
  topSensorDistanceFromTopCm: 16,
  version: "V2",
} as const satisfies SensorGeometry;

export type SensorGeometryEpoch = SensorGeometry & {
  effectiveFromInclusive: string | null;
  effectiveUntilExclusive: string | null;
};

export function createSensorGeometryEpochs({
  topSensorMovedAt,
}: {
  topSensorMovedAt: string;
}): SensorGeometryEpoch[] {
  assertValidIsoTimestamp(topSensorMovedAt, "topSensorMovedAt");

  return [
    {
      ...sensorGeometryV1,
      effectiveUntilExclusive: topSensorMovedAt,
    },
    {
      ...sensorGeometryV2,
      effectiveFromInclusive: topSensorMovedAt,
    },
  ];
}

export function assertValidSensorGeometryEpochs(
  epochs: SensorGeometryEpoch[],
): void {
  if (epochs.length === 0) {
    throw new Error("At least one sensor geometry epoch is required");
  }

  const sortedEpochs = [...epochs].sort(compareEpochStart);

  for (let index = 0; index < sortedEpochs.length; index += 1) {
    const epoch = sortedEpochs[index];

    if (epoch.effectiveFromInclusive !== null) {
      assertValidIsoTimestamp(
        epoch.effectiveFromInclusive,
        `epochs[${index}].effectiveFromInclusive`,
      );
    }
    if (epoch.effectiveUntilExclusive !== null) {
      assertValidIsoTimestamp(
        epoch.effectiveUntilExclusive,
        `epochs[${index}].effectiveUntilExclusive`,
      );
    }
    if (
      epoch.effectiveFromInclusive !== null &&
      epoch.effectiveUntilExclusive !== null &&
      new Date(epoch.effectiveFromInclusive).getTime() >=
        new Date(epoch.effectiveUntilExclusive).getTime()
    ) {
      throw new Error(`Sensor geometry epoch ${epoch.version} has an empty range`);
    }

    const nextEpoch = sortedEpochs[index + 1];
    if (!nextEpoch || epoch.effectiveUntilExclusive === null) {
      continue;
    }
    if (nextEpoch.effectiveFromInclusive !== epoch.effectiveUntilExclusive) {
      throw new Error(
        `Sensor geometry epochs must be contiguous between ${epoch.version} and ${nextEpoch.version}`,
      );
    }
  }
}

export function resolveSensorGeometryForTimestamp({
  epochs,
  timestamp,
}: {
  epochs: SensorGeometryEpoch[];
  timestamp: string;
}): SensorGeometryEpoch {
  assertValidIsoTimestamp(timestamp, "timestamp");
  assertValidSensorGeometryEpochs(epochs);

  const time = new Date(timestamp).getTime();
  const match = epochs.find((epoch) => {
    const startsAt = epoch.effectiveFromInclusive
      ? new Date(epoch.effectiveFromInclusive).getTime()
      : Number.NEGATIVE_INFINITY;
    const endsAt = epoch.effectiveUntilExclusive
      ? new Date(epoch.effectiveUntilExclusive).getTime()
      : Number.POSITIVE_INFINITY;

    return time >= startsAt && time < endsAt;
  });

  if (!match) {
    throw new Error(`No sensor geometry epoch covers timestamp ${timestamp}`);
  }

  return match;
}

function compareEpochStart(first: SensorGeometryEpoch, second: SensorGeometryEpoch) {
  const firstStart = first.effectiveFromInclusive
    ? new Date(first.effectiveFromInclusive).getTime()
    : Number.NEGATIVE_INFINITY;
  const secondStart = second.effectiveFromInclusive
    ? new Date(second.effectiveFromInclusive).getTime()
    : Number.NEGATIVE_INFINITY;

  return firstStart - secondStart;
}

function assertValidIsoTimestamp(value: string, label: string): void {
  const time = new Date(value).getTime();

  if (!Number.isFinite(time)) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
}
