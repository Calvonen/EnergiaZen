import type { SensorGeometryVersion } from "./sensorGeometry";

export type EnergyModelPhysicsVersion =
  | "physical-model-v2-foundation-v1"
  | "energy-model-core-v1";

export type TankDnaCalibrationEpoch = {
  calibrationStartedAt: string;
  calibrationEndedAt: string | null;
  notes?: string;
};

export type TankDnaProfile = {
  calibrationEpoch: TankDnaCalibrationEpoch;
  createdAt: string;
  modelVersion: EnergyModelPhysicsVersion;
  profileId: string;
  sensorGeometryVersion: SensorGeometryVersion;
  status: "candidate" | "active" | "retired";
};

export function assertTankDnaMatchesReplayGeometry({
  profile,
  sensorGeometryVersion,
}: {
  profile: TankDnaProfile;
  sensorGeometryVersion: SensorGeometryVersion;
}): void {
  if (profile.sensorGeometryVersion !== sensorGeometryVersion) {
    throw new Error(
      `Tank DNA profile ${profile.profileId} was calibrated for ${profile.sensorGeometryVersion}, not ${sensorGeometryVersion}`,
    );
  }
}

export function createTankDnaProfile({
  calibrationEpoch,
  createdAt,
  modelVersion,
  profileId,
  sensorGeometryVersion,
  status = "candidate",
}: {
  calibrationEpoch: TankDnaCalibrationEpoch;
  createdAt: string;
  modelVersion: EnergyModelPhysicsVersion;
  profileId: string;
  sensorGeometryVersion: SensorGeometryVersion;
  status?: TankDnaProfile["status"];
}): TankDnaProfile {
  assertValidIsoTimestamp(createdAt, "createdAt");
  assertValidIsoTimestamp(
    calibrationEpoch.calibrationStartedAt,
    "calibrationEpoch.calibrationStartedAt",
  );
  if (calibrationEpoch.calibrationEndedAt !== null) {
    assertValidIsoTimestamp(
      calibrationEpoch.calibrationEndedAt,
      "calibrationEpoch.calibrationEndedAt",
    );
  }

  return {
    calibrationEpoch,
    createdAt,
    modelVersion,
    profileId,
    sensorGeometryVersion,
    status,
  };
}

function assertValidIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
}
