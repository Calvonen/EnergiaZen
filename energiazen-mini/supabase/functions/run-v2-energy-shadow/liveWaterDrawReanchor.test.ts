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
  // Production-shaped false positive: the inlet probe drops by >5 C while the
  // 3 kW heater is continuously on and both tank sensors keep rising. This is
  // the observed heater-only probe oscillation and must not poison V2 reserve.
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
  assert(!ambiguousHeatingResult.unresolved, "continuous heating with rising tank sensors suppresses inlet-only false draw");
  assert(ambiguousHeatingResult.detectedUnlabeledDrawCount === 0, "heater-only inlet oscillation is not counted as a draw");

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

  // A relative idle inlet drop that never reaches the confirmed cold-water
  // baseline is probe drift, not enough evidence to block V2.
  const idleWarmDrift = [
    reading(36, 35, 20, false),
    reading(37, 35, 20, false),
    reading(38, 34.9, 14, false),
    reading(39, 34.9, 14.1, false),
  ];
  const idleWarmDriftResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: idleWarmDrift,
    reliableDraws: [],
  });
  assert(!idleWarmDriftResult.unresolved, "warm inlet drift above cold baseline does not block V2");
  assert(idleWarmDriftResult.detectedUnlabeledDrawCount === 0, "warm drift is not counted as a draw");

  // One isolated cold sample is not enough either: require the inlet to remain
  // at the cold-water level for about one minute.
  const isolatedColdDip = [
    reading(36, 35, 20, false),
    reading(37, 35, 12.5, false),
    reading(38, 35, 16.5, false),
  ];
  const isolatedColdDipResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: isolatedColdDip,
    reliableDraws: [],
  });
  assert(!isolatedColdDipResult.unresolved, "single cold sample does not block V2");

  // A cold dwell that happened before a later unrelated warm drop must not
  // confirm that later candidate. This is the regression called out in review:
  // 12.5, 12.5, 20, 14 has a valid old cold dwell and a new 20 -> 14 drop,
  // but the later drop never reaches the cold baseline.
  const oldColdDwellThenWarmDrop = [
    reading(36, 35, 12.5, false),
    reading(37, 35, 12.5, false),
    reading(38, 35, 20, false),
    reading(39, 34.9, 14, false),
  ];
  const oldColdDwellThenWarmDropResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.2,
    readings: oldColdDwellThenWarmDrop,
    reliableDraws: [],
  });
  assert(
    !oldColdDwellThenWarmDropResult.unresolved,
    "cold dwell before a later warm drop cannot confirm that later candidate",
  );

  // A draw candidate at the exact five-minute detector boundary must survive
  // long enough for the one-minute confirmation dwell to complete.
  const boundaryCandidateThenColdDwell = [
    reading(30, 35, 20, false),
    reading(35, 34.8, 12.5, false),
    reading(36, 34.6, 12.4, false),
  ];
  const boundaryCandidateThenColdDwellResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.2,
    readings: boundaryCandidateThenColdDwell,
    reliableDraws: [],
  });
  assert(
    boundaryCandidateThenColdDwellResult.unresolved,
    "five-minute drop candidate remains available through one-minute cold dwell",
  );

  // An older valid cold dwell cannot validate a later isolated cold sample.
  // Pattern: 20, 12, 12, 20, 20, 20, 12. The first dwell is heater-only and
  // suppressed; the final isolated cold dip has no one-minute dwell of its own.
  const oldDwellThenIsolatedCold = [
    reading(30, 35.0, 20, true),
    reading(31, 35.2, 12, true),
    reading(32, 35.4, 12, true),
    reading(33, 35.6, 20, true),
    reading(34, 35.8, 20, true),
    reading(35, 36.0, 20, true),
    reading(36, 36.0, 12, false),
  ];
  const oldDwellThenIsolatedColdResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.2,
    readings: oldDwellThenIsolatedCold,
    reliableDraws: [],
  });
  assert(
    !oldDwellThenIsolatedColdResult.unresolved,
    "historical cold dwell cannot confirm a later isolated cold sample",
  );

  // The confirmation helper accepts up to a two-minute poll gap, so retain the
  // original five-minute drop candidate for that full interval as well.
  const maxGapBoundaryCandidate = [
    reading(30, 35, 20, false),
    reading(35, 34.8, 12.5, false),
    reading(37, 34.6, 12.4, false),
  ];
  const maxGapBoundaryCandidateResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.2,
    readings: maxGapBoundaryCandidate,
    reliableDraws: [],
  });
  assert(
    maxGapBoundaryCandidateResult.unresolved,
    "five-minute drop candidate survives the full two-minute confirmation poll gap",
  );

  // Reliable draw matching must use the original drop candidate timestamp,
  // not the later confirmation sample. The event ends at t0, the inlet drop is
  // at the +5 minute match boundary, and confirmation completes two minutes
  // later. This remains a trusted labeled draw, not an unresolved unlabeled one.
  const labeledBoundaryDraw = [
    reading(30, 35, 20, false),
    reading(35, 34.8, 12.5, false),
    reading(37, 34.6, 12.4, false),
  ];
  const labeledBoundaryDrawResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.2,
    readings: labeledBoundaryDraw,
    reliableDraws: [{
      event_started_at: reading(29, 35, 20, false).created_at,
      event_ended_at: reading(30, 35, 20, false).created_at,
    }],
  });
  assert(
    !labeledBoundaryDrawResult.unresolved,
    "reliable draw at match boundary uses drop candidate timestamp",
  );
  assert(
    labeledBoundaryDrawResult.detectedUnlabeledDrawCount === 0,
    "matched reliable draw is never reclassified as unlabeled after dwell confirmation",
  );

  // An unrelated pre-heating sample retained only for candidate lookup must
  // not disable heater-only suppression for the actual comparator-to-dwell
  // interval.
  const preHeatingSampleThenHeaterOnlyDrop = [
    reading(29, 34.8, 19.9, false),
    reading(30, 35.0, 20, true),
    reading(31, 35.1, 20, true),
    reading(32, 35.2, 20, true),
    reading(33, 35.3, 20, true),
    reading(34, 35.4, 20, true),
    reading(35, 35.5, 12.5, true),
    reading(36, 35.7, 12.4, true),
  ];
  const preHeatingSampleThenHeaterOnlyDropResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.2,
    readings: preHeatingSampleThenHeaterOnlyDrop,
    reliableDraws: [],
  });
  assert(
    !preHeatingSampleThenHeaterOnlyDropResult.unresolved,
    "heater-only suppression is scoped to the selected drop comparator interval",
  );
  assert(
    preHeatingSampleThenHeaterOnlyDropResult.detectedUnlabeledDrawCount === 0,
    "irrelevant pre-heating sample cannot turn heater-only oscillation into an unlabeled draw",
  );

  // An older labeled draw retained in the lookup window must not hide a newer
  // unlabeled drop whose own cold dwell is what reaches the current sample.
  const labeledOldThenUnlabeledNew = [
    reading(30, 35.0, 20, false),
    reading(31, 34.8, 12.4, false),
    reading(32, 34.7, 12.3, false),
    reading(33, 34.7, 20, false),
    reading(34, 34.7, 20, false),
    reading(35, 34.7, 20, false),
    reading(36, 34.5, 12.4, false),
    reading(37, 34.4, 12.3, false),
  ];
  const labeledOldThenUnlabeledNewResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.2,
    readings: labeledOldThenUnlabeledNew,
    reliableDraws: [{
      event_started_at: reading(26, 35, 20, false).created_at,
      event_ended_at: reading(26, 35, 20, false).created_at,
    }],
  });
  assert(
    labeledOldThenUnlabeledNewResult.unresolved,
    "newer unlabeled draw cannot inherit the older labeled candidate",
  );
  assert(
    labeledOldThenUnlabeledNewResult.detectedUnlabeledDrawCount === 1,
    "newer trailing dwell is counted as its own unlabeled draw",
  );

  // A real relative drop can begin while the inlet is already inside the cold
  // band. The current trailing dwell must still bind to that later drop.
  const alreadyColdThenDeeperDrop = [
    reading(30, 35, 13, false),
    reading(31, 35, 13, false),
    reading(32, 34.6, 7, false),
    reading(33, 34.4, 7, false),
  ];
  const alreadyColdThenDeeperDropResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12,
    readings: alreadyColdThenDeeperDrop,
    reliableDraws: [],
  });
  assert(
    alreadyColdThenDeeperDropResult.unresolved,
    "drop inside an already-cold dwell remains a real unlabeled draw",
  );
  assert(
    alreadyColdThenDeeperDropResult.detectedUnlabeledDrawCount === 1,
    "already-cold deeper drop is counted once",
  );

  // Real shower-shaped inlet behavior reaches the cold baseline and stays
  // there across two one-minute samples, so it remains fail-closed.
  const confirmedIdleDraw = [
    reading(36, 35, 20, false),
    reading(37, 34.9, 12.5, false),
    reading(38, 34.6, 12.4, false),
  ];
  const confirmedIdleDrawResult = resolveLiveDrawReanchors({
    coldInletBaselineC: 12.6,
    readings: confirmedIdleDraw,
    reliableDraws: [],
  });
  assert(confirmedIdleDrawResult.unresolved, "one-minute cold inlet dwell confirms a real draw");
  assert(confirmedIdleDrawResult.detectedUnlabeledDrawCount === 1, "confirmed cold draw is counted once");
}
