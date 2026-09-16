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
  // Production-shaped ambiguity: the inlet probe drops by >5 C while the 3 kW
  // heater is on and the bottom keeps rising. That trace cannot distinguish a
  // heater-induced probe oscillation from a real draw whose cooling is masked
  // by active heating, so the live ledger must fail closed.
  const ambiguousHeatingInletDrop = [
    reading(36, 29.6, 18.9, true),
    reading(37, 29.9, 18.9, true),
    reading(38, 30.1, 15.8, true),
    reading(39, 30.4, 15.4, true),
    reading(40, 30.6, 13.5, true),
    reading(41, 30.9, 13.1, true),
  ];
  const ambiguousHeatingResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: ambiguousHeatingInletDrop,
    reliableDraws: [],
  });
  assert(ambiguousHeatingResult.unresolved, "heating-time inlet drop remains unresolved even when bottom rises");
  assert(ambiguousHeatingResult.detectedUnlabeledDrawCount === 1, "ambiguous heating-time inlet drop is counted once");

  // Heater shutoff alone does not make the ambiguity disappear. The inlet is
  // still cold, so the ledger remains fail-closed instead of silently restoring
  // the heater energy that may have been consumed by a real draw.
  const ambiguousThenIdleCold = [
    ...ambiguousHeatingInletDrop,
    reading(42, 31.0, 13.2, false),
  ];
  const ambiguousThenIdleColdResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: ambiguousThenIdleCold,
    reliableDraws: [],
  });
  assert(ambiguousThenIdleColdResult.unresolved, "cold inlet after heater shutoff remains fail-closed");
  assert(ambiguousThenIdleColdResult.detectedUnlabeledDrawCount === 1, "same trailing inlet event is not double-counted");

  // Once the inlet has demonstrably recovered for three contiguous minutes and
  // the unheated tank has then stayed quiet for 15 minutes, re-anchor to the
  // measured tank state. This safely resolves both possibilities: a real draw
  // and a heater-induced inlet-probe oscillation.
  const recoveredAndStable = [
    ...ambiguousThenIdleCold,
    reading(43, 31.0, 17.0, false),
    reading(44, 31.0, 17.1, false),
    reading(45, 31.0, 17.2, false),
    reading(46, 31.0, 17.3, false),
    reading(47, 31.0, 17.4, false),
    reading(48, 31.0, 17.5, false),
    reading(49, 31.0, 17.6, false),
    reading(50, 31.0, 17.7, false),
    reading(51, 31.0, 17.8, false),
    reading(52, 31.0, 17.9, false),
    reading(53, 31.0, 18.0, false),
    reading(54, 31.0, 18.1, false),
    reading(55, 31.0, 18.2, false),
    reading(56, 31.0, 18.3, false),
    reading(57, 31.0, 18.4, false),
    reading(58, 31.0, 18.5, false),
    reading(59, 31.0, 18.6, false),
    reading(60, 31.0, 18.7, false),
    reading(61, 31.0, 18.8, false),
  ];
  const recoveredAndStableResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: recoveredAndStable,
    reliableDraws: [],
  });
  assert(!recoveredAndStableResult.unresolved, "recovered inlet plus quiet tank resolves ambiguity by reanchoring");
  assert(recoveredAndStableResult.detectedUnlabeledDrawCount === 1, "ambiguous event remains a single draw candidate");
  assert(recoveredAndStableResult.reanchorIndexes.length === 1, "resolved ambiguity produces exactly one physical reanchor");

  // A real draw during heating must remain fail-closed even if the heater masks
  // some of its thermal response. A visible bottom drop is still handled too.
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
  assert(drawDuringHeatingResult.unresolved, "inlet drop during heating remains fail-closed regardless of bottom response");
  assert(drawDuringHeatingResult.detectedUnlabeledDrawCount === 1, "real draw response is counted once");

  // Polling gaps never weaken the inlet evidence.
  const heatingWithSampleGap = [
    reading(36, 29.6, 18.9, true),
    reading(37, 29.9, 18.9, true),
    reading(40, 30.4, 13.5, true),
    reading(41, 30.6, 13.1, true),
  ];
  const heatingWithSampleGapResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: heatingWithSampleGap,
    reliableDraws: [],
  });
  assert(heatingWithSampleGapResult.unresolved, "heating inlet drop across a polling gap remains fail-closed");
  assert(heatingWithSampleGapResult.detectedUnlabeledDrawCount === 1, "gapped heating signal is counted once");

  // Outside heating, the original inlet-only fail-closed detector is unchanged.
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
