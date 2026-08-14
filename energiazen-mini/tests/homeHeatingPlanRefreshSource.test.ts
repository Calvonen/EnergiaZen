import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runHomeHeatingPlanRefreshSourceTests() {
  const homeSource = readFileSync(
    join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );

  const loadStart = homeSource.indexOf(
    "const loadHeatingPlans = useCallback(async () => {",
  );
  const loadEffectStart = homeSource.indexOf(
    "useEffect(() => {\n    void loadHeatingPlans();\n  }, [loadHeatingPlans, visiblePlanDatesKey]);",
  );
  const realtimeEffectStart = homeSource.indexOf(
    'supabase\n      .channel("home-heating-plans-live")',
  );
  const realtimeEffectEnd = homeSource.indexOf(
    "\n  }, [loadHeatingPlans]);",
    realtimeEffectStart,
  );
  const realtimeEffectSource = homeSource.slice(
    realtimeEffectStart,
    realtimeEffectEnd,
  );

  assertSource(
    loadStart >= 0 && loadEffectStart > loadStart && realtimeEffectStart > loadEffectStart,
    "loadHeatingPlans must exist as a reusable callback shared by the visible-dates effect and the realtime/poll effect",
  );

  // The old effect kept a per-call closure over visiblePlanDatesKey, so it
  // could only ever be re-run by a dependency change (i.e. the visible
  // dates changing) - not by an external backend write. Guard against that
  // regressing back in: loadHeatingPlans itself must not depend on the
  // visiblePlanDatesKey identity, only on a ref that both the visible-dates
  // effect and the realtime/poll effect can update/read independently.
  const loadBodyEnd = homeSource.indexOf("\n  }, []);", loadStart);
  const loadBodySource = homeSource.slice(loadStart, loadBodyEnd);
  assertSource(
    loadBodySource.includes("visiblePlanDatesKeyRef.current.split(\",\")") &&
      !loadBodySource.includes("visiblePlanDatesKey.split"),
    "loadHeatingPlans must read the visible plan dates through a ref, not close over visiblePlanDatesKey, so its identity stays stable",
  );
  assertSource(
    loadBodySource.includes("!isHomeScreenMountedRef.current") &&
      loadBodySource.indexOf("!isHomeScreenMountedRef.current") <
        loadBodySource.indexOf("setStoredHeatingPlans("),
    "loadHeatingPlans must not update state after the Home screen has unmounted",
  );
  assertSource(
    loadBodySource.includes("const generation = ++loadHeatingPlansGenerationRef.current;") &&
      loadBodySource.includes("generation !== loadHeatingPlansGenerationRef.current") &&
      loadBodySource.indexOf("generation !== loadHeatingPlansGenerationRef.current") <
        loadBodySource.indexOf("setStoredHeatingPlans("),
    "a slower, older loadHeatingPlans() call must not clobber state once a newer call has started",
  );

  assertSource(
    realtimeEffectStart >= 0 && realtimeEffectEnd > realtimeEffectStart,
    "a realtime subscription effect for heating_plans must exist and be cleaned up",
  );
  assertSource(
    realtimeEffectSource.includes('.on(\n        "postgres_changes",') &&
      realtimeEffectSource.includes('event: "*"') &&
      realtimeEffectSource.includes('schema: "public"') &&
      realtimeEffectSource.includes('table: "heating_plans"') &&
      realtimeEffectSource.includes(".subscribe()"),
    "the app must subscribe to postgres_changes on heating_plans to react to a backend publication without remounting",
  );
  assertSource(
    realtimeEffectSource.includes("setInterval(") &&
      realtimeEffectSource.includes("heatingPlansBackendPollIntervalMs") &&
      realtimeEffectSource.includes("void loadHeatingPlans();"),
    "a periodic poll fallback must exist alongside the realtime subscription",
  );
  assertSource(
    realtimeEffectSource.includes("return () => {") &&
      realtimeEffectSource.includes("clearInterval(pollIntervalId)") &&
      realtimeEffectSource.includes("supabase.removeChannel(heatingPlansChannel)") &&
      realtimeEffectSource.indexOf("clearInterval(pollIntervalId)") <
        realtimeEffectSource.indexOf("supabase.removeChannel(heatingPlansChannel)"),
    "unmount must clear both the poll interval and the realtime channel subscription",
  );

  assertSource(
    homeSource.includes(
      "const heatingPlansBackendPollIntervalMs = 90_000;",
    ),
    "the poll fallback interval must be an explicit, named constant",
  );

  // The realtime handler must not blindly reload on every unrelated table
  // event - only when the changed row's plan_date is currently visible (or
  // the row identity could not be determined, in which case it must still
  // reload rather than silently miss a change).
  assertSource(
    homeSource.includes(
      "!visiblePlanDatesKeyRef.current.split(\",\").includes(changedPlanDate)",
    ),
    "the realtime handler must only skip a reload when the changed plan_date is confirmed outside the visible range",
  );

  // Backend-primary automatic writes must stay app-side disabled; this
  // fix only adds a read-side refresh path, never a new write path.
  assertSource(
    homeSource.includes("shouldPublishHeatingPlanFromApp({") &&
      homeSource.includes("backendPrimaryEnabled: BACKEND_PRIMARY_HEATING_PLAN_ENABLED,"),
    "the app-side automatic publication gate must remain in place - this fix must not restore direct app writes",
  );
}
