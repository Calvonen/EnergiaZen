from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


logic = Path("energiazen-mini/supabase/functions/run-heating-optimizer/logic.ts")
text = logic.read_text()
anchor = "\nexport type RawTankReading = {"
helper = r'''

export type ActiveHeatingBlockGuard = {
  blockedHourId: string | null;
  lockedHourIds: string[];
};

function isStoredAutomaticPlanHour({
  hour,
  storedTodayHours,
  storedTomorrowHours,
  todayPlanDate,
  tomorrowPlanDate,
}: {
  hour: HeatingOptimizationHour;
  storedTodayHours: number[];
  storedTomorrowHours: number[];
  todayPlanDate: string;
  tomorrowPlanDate: string;
}) {
  const dateKey = getFinnishDateKey(hour.startDate);
  const hourNumber = getHelsinkiHourNumber(hour.date);
  return (
    (dateKey === todayPlanDate && storedTodayHours.includes(hourNumber)) ||
    (dateKey === tomorrowPlanDate && storedTomorrowHours.includes(hourNumber))
  );
}

export function resolveActiveHeatingBlockGuard({
  hours,
  latestHeating,
  now,
  safetyTopTemperature,
  storedTodayHours,
  storedTomorrowHours,
  todayPlanDate,
  tomorrowPlanDate,
  topTemperature,
}: {
  hours: HeatingOptimizationHour[];
  latestHeating: boolean | null;
  now: Date;
  safetyTopTemperature: number;
  storedTodayHours: number[];
  storedTomorrowHours: number[];
  todayPlanDate: string;
  tomorrowPlanDate: string;
  topTemperature: number | null | undefined;
}): ActiveHeatingBlockGuard {
  if (
    latestHeating !== true ||
    typeof topTemperature !== "number" ||
    topTemperature < safetyTopTemperature
  ) {
    return { blockedHourId: null, lockedHourIds: [] };
  }

  const ordered = [...hours].sort(
    (first, second) => first.date.getTime() - second.date.getTime(),
  );
  const currentIndex = ordered.findIndex(
    (hour) =>
      getFinnishDateKey(hour.startDate) === todayPlanDate &&
      hour.date.getTime() <= now.getTime() &&
      hour.endDate.getTime() > now.getTime(),
  );
  if (currentIndex < 0) {
    return { blockedHourId: null, lockedHourIds: [] };
  }

  const currentHour = ordered[currentIndex];
  if (
    !isStoredAutomaticPlanHour({
      hour: currentHour,
      storedTodayHours,
      storedTomorrowHours,
      todayPlanDate,
      tomorrowPlanDate,
    })
  ) {
    return { blockedHourId: null, lockedHourIds: [] };
  }

  const lockedHourIds: string[] = [];
  let expectedStart = currentHour.date.getTime();
  let index = currentIndex;
  for (; index < ordered.length; index += 1) {
    const hour = ordered[index];
    if (
      hour.date.getTime() !== expectedStart ||
      !isStoredAutomaticPlanHour({
        hour,
        storedTodayHours,
        storedTomorrowHours,
        todayPlanDate,
        tomorrowPlanDate,
      })
    ) {
      break;
    }
    lockedHourIds.push(hour.id);
    expectedStart = hour.endDate.getTime();
  }

  const blockedHour = ordered[index];
  return {
    blockedHourId:
      blockedHour && blockedHour.date.getTime() === expectedStart
        ? blockedHour.id
        : null,
    lockedHourIds,
  };
}

export function applyHardHeatingBlockGuard({
  blockedHourId,
  hours,
  lockedHourIds,
  maxHeatingHours,
  result,
}: {
  blockedHourId: string | null;
  hours: HeatingOptimizationHour[];
  lockedHourIds: string[];
  maxHeatingHours: number;
  result: HeatingOptimizationResult | null;
}): HeatingOptimizationResult | null {
  if (!result || (blockedHourId === null && lockedHourIds.length === 0)) {
    return result;
  }

  const locked = new Set(lockedHourIds);
  const rawSelected = new Set(result.selectedHeatingHourIds);
  if (blockedHourId) rawSelected.delete(blockedHourId);
  for (const id of locked) rawSelected.add(id);

  const orderedIds = [...hours]
    .sort((first, second) => first.date.getTime() - second.date.getTime())
    .map((hour) => hour.id);
  const lockedOrdered = orderedIds.filter((id) => locked.has(id));
  const extras = orderedIds.filter(
    (id) => rawSelected.has(id) && !locked.has(id) && id !== blockedHourId,
  );
  const capacity = Math.max(maxHeatingHours, lockedOrdered.length);
  const selectedHeatingHourIds = [
    ...lockedOrdered,
    ...extras.slice(0, Math.max(0, capacity - lockedOrdered.length)),
  ].sort((first, second) => orderedIds.indexOf(first) - orderedIds.indexOf(second));

  return {
    ...result,
    selectedHeatingHourIds,
    diagnostics: { ...result.diagnostics, selectedHeatingHourIds },
  };
}
'''
if anchor not in text:
    raise SystemExit("logic anchor not found")
logic.write_text(text.replace(anchor, helper + anchor, 1))

index_path = "energiazen-mini/supabase/functions/run-heating-optimizer/index.ts"
replace_once(
    index_path,
    "  buildHeatingPlanPublicationDecision,\n",
    "  applyHardHeatingBlockGuard,\n  buildHeatingPlanPublicationDecision,\n",
)
replace_once(
    index_path,
    "  resolveOptimizerSettings,\n  resolvePostHeatingCooldownHourStart,\n",
    "  resolveOptimizerSettings,\n  resolveActiveHeatingBlockGuard,\n  resolvePostHeatingCooldownHourStart,\n",
)
old = '''    const cooldownHourStart = resolvePostHeatingCooldownHourStart({
      hours,
      latestHeating: heating,
      now: attemptNow,
      recentReadings: recoveryReadings,
      safetyTopTemperature: postHeatingCooldownSafetyTopTemperature,
      storedTodayHours,
      storedTomorrowHours,
      todayPlanDate,
      tomorrowPlanDate,
      topTemperature: currentTopTemperature,
    });
    // Keep normal optimization running, but make the actual chronologically
    // adjacent price interval after the already-started stored block a
    // last-resort safety choice instead of letting repeated 5-minute
    // recalculations extend the active block one hour at a time. Checking
    // the next interval's Helsinki-local hour rather than currentHour + 1
    // keeps both occurrences of the repeated DST hour covered by the same
    // stored planned-hour number. Measured top temperature below 50 C also
    // disables the cooldown penalty so the existing safety logic can react
    // immediately.
    const optimizerHours = hours.map((hour) =>
      cooldownHourStart !== null && hour.date.getTime() === cooldownHourStart
        ? { ...hour, price: hour.price + postHeatingCooldownPenaltyCents }
        : hour,
    );
    const run = runBackendHeatingOptimization({
'''
new = '''    const cooldownHourStart = resolvePostHeatingCooldownHourStart({
      hours,
      latestHeating: heating,
      now: attemptNow,
      recentReadings: recoveryReadings,
      safetyTopTemperature: postHeatingCooldownSafetyTopTemperature,
      storedTodayHours,
      storedTomorrowHours,
      todayPlanDate,
      tomorrowPlanDate,
      topTemperature: currentTopTemperature,
    });
    const activeBlockGuard = resolveActiveHeatingBlockGuard({
      hours,
      latestHeating: heating,
      now: attemptNow,
      safetyTopTemperature: postHeatingCooldownSafetyTopTemperature,
      storedTodayHours,
      storedTomorrowHours,
      todayPlanDate,
      tomorrowPlanDate,
      topTemperature: currentTopTemperature,
    });
    const boundaryBlockedHourId =
      cooldownHourStart === null
        ? null
        : hours.find((hour) => hour.date.getTime() === cooldownHourStart)?.id ?? null;
    const hardBlockedHourId = activeBlockGuard.blockedHourId ?? boundaryBlockedHourId;

    const optimizerHours = hours.map((hour) =>
      hardBlockedHourId !== null && hour.id === hardBlockedHourId
        ? { ...hour, price: hour.price + postHeatingCooldownPenaltyCents }
        : hour,
    );
    const run = runBackendHeatingOptimization({
'''
replace_once(index_path, old, new)
replace_once(
    index_path,
    '''      settings: optimizationSettings,
    });

    // Stateless by design''',
    '''      settings: optimizationSettings,
    });
    const guardedOptimizerResult = applyHardHeatingBlockGuard({
      blockedHourId: hardBlockedHourId,
      hours,
      lockedHourIds: activeBlockGuard.lockedHourIds,
      maxHeatingHours: optimizationSettings.maxHeatingHours,
      result: run.result,
    });

    // Stateless by design''',
)
replace_once(
    index_path,
    "      optimizerResult: run.result,\n      optimizerSettings:",
    "      optimizerResult: guardedOptimizerResult,\n      optimizerSettings:",
)

marker_path = "energiazen-mini/lib/heatingCooldownMarker.ts"
old = '''  const nextHour = optimizerHours.find(
    (hour) => hour.date.getTime() === currentHour.endDate.getTime(),
  );
  if (!nextHour || getFinnishDateKey(nextHour.startDate) !== todayPlanDate) {
    return null;
  }

  const nextHourNumber = getHelsinkiHourNumber(nextHour.date);
  if (storedTodayHours.includes(nextHourNumber)) {
    return null;
  }

  return optimizerSelectedHourIds.includes(nextHour.id) ? nextHour.id : null;
'''
new = '''  let blockTail = currentHour;
  while (true) {
    const nextHour = optimizerHours.find(
      (hour) => hour.date.getTime() === blockTail.endDate.getTime(),
    );
    if (!nextHour || getFinnishDateKey(nextHour.startDate) !== todayPlanDate) {
      return null;
    }

    const nextHourNumber = getHelsinkiHourNumber(nextHour.date);
    if (!storedTodayHours.includes(nextHourNumber)) {
      return optimizerSelectedHourIds.includes(nextHour.id) ? nextHour.id : null;
    }
    blockTail = nextHour;
  }
'''
replace_once(marker_path, old, new)

marker_test = Path("energiazen-mini/lib/heatingCooldownMarker.test.ts")
mt = marker_test.read_text()
insertion = r'''
  const secondPlannedHour = createHour("second-planned", "2025-01-15T11:00:00+02:00");
  const afterBlockHour = createHour("after-block", "2025-01-15T12:00:00+02:00");
  const twoHourBlock = [currentHour, secondPlannedHour, afterBlockHour];
  const twoHourPriceHours = [pastHour, ...twoHourBlock];
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      backendValidation: {
        ...baseBackendValidation,
        validated_plan_fingerprint: "2025-01-15|10,11",
        validated_planned_hours: [10, 11],
        validated_price_snapshot: buildCooldownPriceSnapshot(
          twoHourPriceHours,
          "2025-01-15",
          "2025-01-16",
        ),
      },
      optimizerHours: twoHourBlock,
      priceHours: twoHourPriceHours,
      optimizerSelectedHourIds: [currentHour.id, secondPlannedHour.id, afterBlockHour.id],
      storedTodayHours: [10, 11],
    }),
    afterBlockHour.id,
    "a two-hour active block must mark the hour after the block",
  );
'''
marker_anchor = "\n  const firstRepeatedHour = createHour("
if marker_anchor not in mt:
    raise SystemExit("marker test anchor not found")
marker_test.write_text(mt.replace(marker_anchor, insertion + marker_anchor, 1))

logic_test = Path("energiazen-mini/supabase/functions/run-heating-optimizer/logic.test.ts")
lt = logic_test.read_text()
lt = lt.replace(
    "  buildHeatingPlanFingerprint,\n",
    "  applyHardHeatingBlockGuard,\n  buildHeatingPlanFingerprint,\n",
    1,
)
lt = lt.replace(
    "  resolveHourlyDropProfile,\n",
    "  resolveActiveHeatingBlockGuard,\n  resolveHourlyDropProfile,\n",
    1,
)
test_anchor = '''  assertEqual(
    isHeatingOptimizerCronSecretAuthorized("private-cron-secret", "private-cron-secret"),'''
tests = r'''
  const activeBlockHours = buildOptimizerHours(
    priceRowsBetween(
      new Date("2026-09-03T02:00:00.000Z"),
      new Date("2026-09-03T06:00:00.000Z"),
    ),
    new Date("2026-09-03T02:18:00.000Z"),
    "2026-09-03",
    "2026-09-04",
  );
  const activeBlockGuard = resolveActiveHeatingBlockGuard({
    hours: activeBlockHours,
    latestHeating: true,
    now: new Date("2026-09-03T02:18:00.000Z"),
    safetyTopTemperature: 50,
    storedTodayHours: [5, 6],
    storedTomorrowHours: [],
    todayPlanDate: "2026-09-03",
    tomorrowPlanDate: "2026-09-04",
    topTemperature: 53.9,
  });
  assertEqual(
    activeBlockGuard.lockedHourIds,
    ["2026-09-03T02:00:00.000Z", "2026-09-03T03:00:00.000Z"],
    "an active [5,6] plan must hard-lock both contiguous block hours",
  );
  assertEqual(
    activeBlockGuard.blockedHourId,
    "2026-09-03T04:00:00.000Z",
    "the first hour after an active [5,6] block must be hard-blocked",
  );
  assertEqual(
    resolveActiveHeatingBlockGuard({
      hours: activeBlockHours,
      latestHeating: true,
      now: new Date("2026-09-03T02:18:00.000Z"),
      safetyTopTemperature: 50,
      storedTodayHours: [5, 6],
      storedTomorrowHours: [],
      todayPlanDate: "2026-09-03",
      tomorrowPlanDate: "2026-09-04",
      topTemperature: 49.9,
    }),
    { blockedHourId: null, lockedHourIds: [] },
    "top below 50 C must remove the hard lock and block",
  );

  const fakeGuardResult = {
    selectedHeatingHourIds: [
      "2026-09-03T02:00:00.000Z",
      "2026-09-03T03:00:00.000Z",
      "2026-09-03T04:00:00.000Z",
    ],
    diagnostics: {
      selectedHeatingHourIds: [
        "2026-09-03T02:00:00.000Z",
        "2026-09-03T03:00:00.000Z",
        "2026-09-03T04:00:00.000Z",
      ],
    },
  } as HeatingOptimizationResult;
  const guardedResult = applyHardHeatingBlockGuard({
    blockedHourId: activeBlockGuard.blockedHourId,
    hours: activeBlockHours,
    lockedHourIds: activeBlockGuard.lockedHourIds,
    maxHeatingHours: 4,
    result: fakeGuardResult,
  });
  assertEqual(
    guardedResult?.selectedHeatingHourIds,
    ["2026-09-03T02:00:00.000Z", "2026-09-03T03:00:00.000Z"],
    "publication guard must remove 07-08 even when optimizer selected it",
  );

'''
if test_anchor not in lt:
    raise SystemExit("logic test anchor not found")
logic_test.write_text(lt.replace(test_anchor, tests + test_anchor, 1))
