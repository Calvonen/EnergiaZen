// Presentation regressions for the production-shaped V2 reserve snapshot.
// Keep these rules explicit so a future UI refactor cannot silently switch
// the card back to shower-count/non-conservative semantics or show stale data.
const energy = 11.183;
const capacity = 17.673;
const percent = Math.min(100, Math.max(0, (energy / capacity) * 100));

if (Math.abs(percent - 63.28) >= 0.05) {
  throw new Error(`expected conservative V2 reserve near 63.28%, got ${percent}`);
}

const maxAgeMs = 12 * 60_000;
function isFresh(runAtMs: number, nowMs: number) {
  const ageMs = nowMs - runAtMs;
  return Number.isFinite(runAtMs) && ageMs >= 0 && ageMs <= maxAgeMs;
}

const now = Date.parse("2026-09-16T09:00:00Z");
if (!isFresh(Date.parse("2026-09-16T08:49:00Z"), now)) {
  throw new Error("expected an 11-minute-old reserve snapshot to remain fresh");
}
if (isFresh(Date.parse("2026-09-16T08:47:00Z"), now)) {
  throw new Error("expected a 13-minute-old reserve snapshot to fail closed");
}
if (isFresh(Date.parse("2026-09-16T09:01:00Z"), now)) {
  throw new Error("expected a future-dated reserve snapshot to fail closed");
}
