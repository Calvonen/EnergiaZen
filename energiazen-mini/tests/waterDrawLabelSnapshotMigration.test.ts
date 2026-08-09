import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runWaterDrawLabelSnapshotMigrationTests() {
  const source = readFileSync(join(
    process.cwd(),
    "supabase/migrations/20260809030000_lock_water_draw_label_v2_snapshot.sql",
  ), "utf8");
  const immutableV2Start = source.indexOf("if old.feature_snapshot_version = 2 then");
  const legacyGuardStart = source.indexOf("elsif new.feature_snapshot_version is distinct from 2 then");
  const immutableV2 = source.slice(immutableV2Start, legacyGuardStart);
  const legacyGuard = source.slice(legacyGuardStart, source.indexOf("end if;", legacyGuardStart));
  const featureAssignments = [
    "new.energy_before_kwh = old.energy_before_kwh",
    "new.energy_after_stabilization_kwh = old.energy_after_stabilization_kwh",
    "new.raw_energy_change_kwh = old.raw_energy_change_kwh",
    "new.estimated_natural_loss_kwh = old.estimated_natural_loss_kwh",
  ];

  assertSource(immutableV2Start !== -1 && legacyGuardStart > immutableV2Start,
    "migraation pitaa erottaa valmis v2 snapshot ja legacy-rivi");
  assertSource(featureAssignments.every((assignment) => immutableV2.includes(assignment)) &&
    immutableV2.includes("new.feature_snapshot_version = 2"),
  "valmiin v2 snapshotin featureiden ja version pitaa pysya muuttumattomina UPDATEssa");
  assertSource(featureAssignments.every((assignment) => legacyGuard.includes(assignment)) &&
    legacyGuard.includes("new.feature_snapshot_version = old.feature_snapshot_version"),
  "legacy-featureita ei saa vaihtaa ilman kertaluonteista v2-promootiota");
  assertSource(source.includes("elsif new.feature_snapshot_version is distinct from 2 then"),
    "legacy-rivi pitaa voida taydentaa kerran asettamalla feature_snapshot_version arvoksi 2");
  assertSource(!source.includes("new.label =") && !source.includes("new.note ="),
    "snapshot-triggeri ei saa estaa labelin tai noten muuttamista");

  const grantSource = readFileSync(join(
    process.cwd(),
    "supabase/migrations/20260809040000_grant_water_draw_label_permissions.sql",
  ), "utf8");
  assertSource(grantSource.includes("grant select, insert, update, delete on table public.water_draw_labels to authenticated"),
    "authenticated-roolilla pitaa olla upsertin vaatimat tauluoikeudet RLS-policyjen lisaksi");
}
