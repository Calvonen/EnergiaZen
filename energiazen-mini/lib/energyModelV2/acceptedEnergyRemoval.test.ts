import { resolveAcceptedWaterDrawRemoval } from "./acceptedEnergyRemoval";
import type { WaterDrawEventSnapshot } from "./waterDrawLabelDomain";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function event(overrides: Partial<WaterDrawEventSnapshot> = {}): WaterDrawEventSnapshot {
  return {
    detectionKinds: [],
    durationMinutes: 8,
    endedAt: "2026-09-08T12:08:00.000Z",
    energyAfterStabilizationKwh: 7.1,
    energyBeforeKwh: 8.0,
    energyQualityReason: null,
    energyReliable: true,
    estimatedNaturalLossKwh: 0.05,
    estimatedWaterDrawNetEnergyKwh: 0.85,
    rawEnergyChangeKwh: -0.9,
    startedAt: "2026-09-08T12:00:00.000Z",
    ...overrides,
  };
}

export function runAcceptedEnergyRemovalUnitTests() {
  const accepted = resolveAcceptedWaterDrawRemoval(event());
  assert(accepted.accepted, "reliable positive water-draw energy is accepted");
  assert(accepted.energyKwh === 0.85, "accepted removal preserves the estimated net energy");

  const unreliable = resolveAcceptedWaterDrawRemoval(event({ energyReliable: false }));
  assert(!unreliable.accepted, "unreliable water-draw energy fails closed");
  assert(unreliable.energyKwh === 0, "unreliable event removes no physical energy");

  const risingTank = resolveAcceptedWaterDrawRemoval(
    event({ energyQualityReason: "tank_energy_rising", energyReliable: false }),
  );
  assert(!risingTank.accepted, "tank-energy-rising quality issue is rejected");

  const missing = resolveAcceptedWaterDrawRemoval(
    event({ estimatedWaterDrawNetEnergyKwh: null }),
  );
  assert(!missing.accepted, "missing net-energy estimate is rejected");

  const zero = resolveAcceptedWaterDrawRemoval(
    event({ estimatedWaterDrawNetEnergyKwh: 0 }),
  );
  assert(!zero.accepted, "zero energy removal is rejected");
}
