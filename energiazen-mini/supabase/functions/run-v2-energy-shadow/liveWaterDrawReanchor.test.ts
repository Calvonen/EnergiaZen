import { resolveLiveDrawReanchors, type LiveDrawReading } from "./liveWaterDrawReanchor";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function reading(
  minute: number,
  bottomTemp: number,
  inletTemp: number,
  heating: boolean,
): LiveDrawReading {
  return {
    created_at: new Date(Date.UTC(2026, 8, 16, 5, minute, 0)).toISOString(),
    top_temp: 54.3,
    bottom_temp: bottomTemp,
    inlet_temp: inletTemp,
    heating,
  };
}

export function runLiveWaterDrawReanchorUnitTests() {
  // Production 2026-09-16: while the 3 kW heater was continuously on, the
  // stagnant inlet probe fell from about 18.9 C to 13.1 C within five minutes
  // even though the bottom of the tank kept warming. That is not evidence of
  // cold-water replacement and must not strand V2 in unresolved-draw state.
  const heaterOnlyInletOscillation = [
    reading(36, 29.6, 18.9, true),
    reading(37, 29.9, 18.9, true),
    reading(38, 30.1, 15.8, true),
    reading(39, 30.4, 15.4, true),
    reading(40, 30.6, 13.5, true),
    reading(41, 30.9, 13.1, true),
  ];
  const heaterOnlyResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: heaterOnlyInletOscillation,
    reliableDraws: [],
  });
  assert(!heaterOnlyResult.unresolved, "continuous heating with rising bottom temperature ignores inlet-only oscillation");
  assert(heaterOnlyResult.detectedUnlabeledDrawCount === 0, "heater-only inlet oscillation is not counted as a draw");

  // Preserve fail-closed behaviour when the same inlet signature is accompanied
  // by an actual cold-water response at the bottom sensor.
  const drawDuringHeating = [
    reading(36, 29.6, 18.9, true),
    reading(37, 29.9, 18.9, true),
    reading(38, 30.1, 15.8, true),
    reading(39, 29.7, 13.4, true),
    reading(40, 29.3, 13.1, true),
  ];
  const drawDuringHeatingResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: drawDuringHeating,
    reliableDraws: [],
  });
  assert(drawDuringHeatingResult.unresolved, "inlet drop plus bottom-temperature response still fails closed during heating");
  assert(drawDuringHeatingResult.detectedUnlabeledDrawCount === 1, "real draw response is still counted once");

  // Outside continuous heating, the original inlet-only fail-closed detector is
  // unchanged.
  const idleDraw = [
    reading(36, 35, 20, false),
    reading(37, 35, 20, false),
    reading(38, 34.9, 14, false),
  ];
  const idleDrawResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: idleDraw,
    reliableDraws: [],
  });
  assert(idleDrawResult.unresolved, "idle inlet draw signal remains fail-closed");
}
