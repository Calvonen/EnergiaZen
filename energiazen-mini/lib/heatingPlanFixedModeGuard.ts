// Codex P2 (PR #193): shouldPublishHeatingPlanFromApp lets a fixed-mode
// install publish heating_plans unconditionally, bypassing the
// backend-primary app-publisher gate by design - fixed plans are the
// user's explicit command, not something backend-primary should own. But
// that means a *mounted client still holding a stale local "fixed"* (e.g.
// left open while another device switches heating_need_mode to
// "automatic" in Supabase) keeps writing fixed plans over backend-primary's
// automatic publications indefinitely, since nothing was ever checking the
// authoritative remote mode before that specific write path.
//
// This is intentionally NOT full bidirectional settings Realtime sync: it
// only answers one narrow question, asked once per fixed-mode publish
// attempt, right before that attempt actually writes.
export type RemoteHeatingNeedModeCheckOutcome =
  | "fixed"
  | "not_fixed"
  | "check_failed";

export async function resolveRemoteHeatingNeedModeForFixedPublish({
  fetchRemoteMode,
}: {
  fetchRemoteMode: () => Promise<{
    data: { heating_need_mode: string | null } | null;
    error: unknown;
  }>;
}): Promise<RemoteHeatingNeedModeCheckOutcome> {
  let result: {
    data: { heating_need_mode: string | null } | null;
    error: unknown;
  };

  try {
    result = await fetchRemoteMode();
  } catch {
    return "check_failed";
  }

  if (result.error) {
    return "check_failed";
  }

  // Fail closed on anything other than a confirmed "fixed": a missing row,
  // a null mode, "automatic", or any unexpected value must all block the
  // write the same way a read error does - the whole point is that only a
  // confirmed-fixed remote state may ever let this app write heating_plans.
  return result.data?.heating_need_mode === "fixed" ? "fixed" : "not_fixed";
}

export function canPublishFixedHeatingPlanFromApp(
  outcome: RemoteHeatingNeedModeCheckOutcome,
): boolean {
  return outcome === "fixed";
}
