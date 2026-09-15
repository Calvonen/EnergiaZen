import fs from "node:fs";
import path from "node:path";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runV2ProductionConstraintSourceTests() {
  const source = fs.readFileSync(
    path.join(process.cwd(), "supabase/functions/run-v2-energy-shadow/index.ts"),
    "utf8",
  );
  assert(source.includes("resolveV2HeatingConstraints"), "live V2 shadow must derive production constraints");
  assert(source.includes("constraints,"), "live V2 shadow must pass constraints to plan optimizer");
  assert(source.includes('.from("heating_plans")'), "live V2 shadow must read authoritative stored plans");
}
