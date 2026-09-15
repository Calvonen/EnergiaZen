import {
  advanceState,
  calculateTankStateFromObservation,
  defaultEnergyModelCoreConfig,
  type TankState,
} from "./energyModelCore";
import {
  advanceLedgerFromTankState,
  createLedgerFromTankState,
} from "./physicalEnergyStateBridge";
import type { PhysicalEnergyLedger } from "./physicalEnergyLedger";
import { resolveAcceptedWaterDrawRemoval } from "./acceptedEnergyRemoval";
import type { WaterDrawEventSnapshot } from "./waterDrawLabelDomain";
import type { SensorGeometryEpoch } from "./sensorGeometry";
import {
  createAuthoritativeEnergyState,
  type AuthoritativeEnergyState,
} from "./authoritativeEnergyState";

export type PhysicalEnergyReplayReading = {
  bottomTempC: number;
  heating: boolean;
  inletTempC: number;
  timestamp: string;
  topTempC: number;
};

export type PhysicalEnergyReplayStep = {
  acceptedRemovalEnergyKwh: number;
  authoritativeEnergy: AuthoritativeEnergyState;
  ledger: PhysicalEnergyLedger;
  observedState: TankState;
  reading: PhysicalEnergyReplayReading;
};

export function runPhysicalEnergyReplay({
  acceptedWaterDrawEvents = [],
  geometry,
  heaterPowerKwhPerHour = defaultEnergyModelCoreConfig.heatingPowerKwhPerHour,
  readings,
}: {
  acceptedWaterDrawEvents?: WaterDrawEventSnapshot[];
  geometry: SensorGeometryEpoch;
  heaterPowerKwhPerHour?: number;
  readings: PhysicalEnergyReplayReading[];
}) {
  const ordered = [...readings].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  if (ordered.length === 0) {
    return {
      finalAuthoritativeEnergy: null,
      finalLedger: null,
      finalObservedState: null,
      steps: [] as PhysicalEnergyReplayStep[],
    };
  }

  const first = ordered[0];
  let observedState = calculateTankStateFromObservation({
    geometry,
    observation: {
      bottomTempC: first.bottomTempC,
      heating: first.heating,
      inletTempC: first.inletTempC,
      timestamp: first.timestamp,
      topTempC: first.topTempC,
    },
  });
  let ledger = createLedgerFromTankState(observedState);
  if (!ledger) {
    return {
      finalAuthoritativeEnergy: null,
      finalLedger: null,
      finalObservedState: observedState,
      steps: [] as PhysicalEnergyReplayStep[],
    };
  }

  let authoritativeEnergy = createAuthoritativeEnergyState({ ledger, observedState });
  const steps: PhysicalEnergyReplayStep[] = [
    {
      acceptedRemovalEnergyKwh: 0,
      authoritativeEnergy,
      ledger,
      observedState,
      reading: first,
    },
  ];

  for (let index = 1; index < ordered.length; index += 1) {
    const previousReading = ordered[index - 1];
    const reading = ordered[index];
    const previousMs = new Date(previousReading.timestamp).getTime();
    const currentMs = new Date(reading.timestamp).getTime();
    const deltaTimeMinutes = Math.max((currentMs - previousMs) / 60_000, 0);

    // Heating is an interval state. The reading at the beginning of the
    // interval tells us whether the 3 kW element was physically on during
    // that interval; using the end sample would drop the last heated segment
    // exactly when the relay turns off.
    const intervalHeating = previousReading.heating === true;

    observedState = advanceState(
      observedState,
      {
        bottomTempC: reading.bottomTempC,
        heating: intervalHeating,
        inletTempC: reading.inletTempC,
        timestamp: reading.timestamp,
        topTempC: reading.topTempC,
      },
      deltaTimeMinutes,
    );

    const acceptedRemovalEnergyKwh = acceptedWaterDrawEvents.reduce(
      (total, event) => {
        const endedAt = new Date(event.endedAt).getTime();
        if (!(endedAt > previousMs && endedAt <= currentMs)) return total;
        const decision = resolveAcceptedWaterDrawRemoval(event);
        return total + (decision.accepted ? decision.energyKwh : 0);
      },
      0,
    );

    ledger = advanceLedgerFromTankState({
      acceptedRemovalEnergyKwh,
      deltaTimeMinutes,
      heaterPowerKwhPerHour,
      heating: intervalHeating,
      modeledHeatLossKwh: 0,
      observedState,
      previousLedger: ledger,
    });
    authoritativeEnergy = createAuthoritativeEnergyState({ ledger, observedState });

    steps.push({
      acceptedRemovalEnergyKwh,
      authoritativeEnergy,
      ledger,
      observedState,
      reading,
    });
  }

  return {
    finalAuthoritativeEnergy: authoritativeEnergy,
    finalLedger: ledger,
    finalObservedState: observedState,
    steps,
  };
}
