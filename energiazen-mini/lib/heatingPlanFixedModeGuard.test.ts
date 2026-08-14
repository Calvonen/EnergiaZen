import {
  canPublishFixedHeatingPlanFromApp,
  resolveRemoteHeatingNeedModeForFixedPublish,
} from "./heatingPlanFixedModeGuard";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export async function runHeatingPlanFixedModeGuardUnitTests() {
  // 1. local fixed + remote fixed -> fixed publish allowed.
  {
    const outcome = await resolveRemoteHeatingNeedModeForFixedPublish({
      fetchRemoteMode: async () => ({
        data: { heating_need_mode: "fixed" },
        error: null,
      }),
    });
    assertEqual(outcome, "fixed", "a confirmed remote fixed mode must resolve to fixed");
    assertEqual(
      canPublishFixedHeatingPlanFromApp(outcome),
      true,
      "local fixed + remote fixed must permit the fixed publish",
    );
  }

  // 2. local fixed + remote automatic -> fixed publish blocked. Framed as
  // "a queued fixed publish is cancelled if authoritative mode has moved to
  // automatic": the outcome reflects whatever fetchRemoteMode returns at
  // the moment it is actually called (write time), not any earlier
  // assumption - see the source-contract test for where in the save chain
  // this call sits (after the plan is computed, immediately before the
  // write), which is what makes an already-queued publish pick this up.
  {
    const outcome = await resolveRemoteHeatingNeedModeForFixedPublish({
      fetchRemoteMode: async () => ({
        data: { heating_need_mode: "automatic" },
        error: null,
      }),
    });
    assertEqual(
      outcome,
      "not_fixed",
      "a remote mode of automatic must resolve to not_fixed",
    );
    assertEqual(
      canPublishFixedHeatingPlanFromApp(outcome),
      false,
      "local fixed + remote automatic must block the fixed publish (queued-publish cancellation)",
    );
  }

  // 3. remote mode read failure / missing / unknown -> fixed publish
  // blocked (fail closed in every case, never just on the literal
  // "automatic" value).
  {
    const missingRowOutcome = await resolveRemoteHeatingNeedModeForFixedPublish({
      fetchRemoteMode: async () => ({ data: null, error: null }),
    });
    assertEqual(missingRowOutcome, "not_fixed", "a missing row must fail closed");
    assertEqual(
      canPublishFixedHeatingPlanFromApp(missingRowOutcome),
      false,
      "a missing row must not permit the fixed publish",
    );

    const nullModeOutcome = await resolveRemoteHeatingNeedModeForFixedPublish({
      fetchRemoteMode: async () => ({
        data: { heating_need_mode: null },
        error: null,
      }),
    });
    assertEqual(nullModeOutcome, "not_fixed", "a null mode must fail closed");
    assertEqual(
      canPublishFixedHeatingPlanFromApp(nullModeOutcome),
      false,
      "a null mode must not permit the fixed publish",
    );

    const unknownModeOutcome = await resolveRemoteHeatingNeedModeForFixedPublish({
      fetchRemoteMode: async () => ({
        data: { heating_need_mode: "something-unexpected" },
        error: null,
      }),
    });
    assertEqual(unknownModeOutcome, "not_fixed", "an unrecognized mode value must fail closed");
    assertEqual(
      canPublishFixedHeatingPlanFromApp(unknownModeOutcome),
      false,
      "an unrecognized mode value must not permit the fixed publish",
    );

    const queryErrorOutcome = await resolveRemoteHeatingNeedModeForFixedPublish({
      fetchRemoteMode: async () => ({
        data: null,
        error: new Error("network down"),
      }),
    });
    assertEqual(queryErrorOutcome, "check_failed", "a query error must fail closed");
    assertEqual(
      canPublishFixedHeatingPlanFromApp(queryErrorOutcome),
      false,
      "a query error must not permit the fixed publish",
    );

    const thrownOutcome = await resolveRemoteHeatingNeedModeForFixedPublish({
      fetchRemoteMode: async () => {
        throw new Error("thrown before returning");
      },
    });
    assertEqual(thrownOutcome, "check_failed", "a thrown fetch error must fail closed");
    assertEqual(
      canPublishFixedHeatingPlanFromApp(thrownOutcome),
      false,
      "a thrown fetch error must not permit the fixed publish",
    );
  }
}
