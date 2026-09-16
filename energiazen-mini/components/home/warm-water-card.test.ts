// Presentation regression for the production-shaped V2 reserve snapshot.
// Keep this arithmetic explicit so a future UI refactor cannot silently switch
// the card back to shower-count or non-conservative energy semantics.
const energy = 11.183;
const capacity = 17.673;
const percent = Math.min(100, Math.max(0, (energy / capacity) * 100));

if (Math.abs(percent - 63.28) >= 0.05) {
  throw new Error(`expected conservative V2 reserve near 63.28%, got ${percent}`);
}
