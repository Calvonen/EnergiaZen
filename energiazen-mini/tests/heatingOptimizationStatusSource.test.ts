import fs from "node:fs";
import path from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runHeatingOptimizationStatusSourceTests() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );

  const optimizationStatusStart = source.indexOf(
    "const optimizationStatus =",
  );
  const optimizationStatusEnd = source.indexOf(
    "console.log(",
    optimizationStatusStart,
  );
  const optimizationStatusBlock =
    optimizationStatusStart !== -1 && optimizationStatusEnd !== -1
      ? source.slice(optimizationStatusStart, optimizationStatusEnd)
      : "";

  assertSource(
    optimizationStatusStart !== -1 &&
      optimizationStatusEnd !== -1 &&
      optimizationStatusBlock.includes(
        "heatingOptimization.selectedHeatingHourIds.length > 0",
      ) &&
      optimizationStatusBlock.includes("heatingOptimization.valid") &&
      optimizationStatusBlock.includes('"planned"') &&
      optimizationStatusBlock.includes('"planned-invalid-fallback"'),
    "optimizationStatus erottaa validin ja invalidin (fallback) suunnitelman heatingOptimization.valid-lipun perusteella",
  );

  assertSource(
    source.includes("valid: heatingOptimization.valid"),
    "heatingOptimization.valid kirjataan lokiin, jotta invalid fallback ei nay huomaamattomana planned-tilana",
  );
  assertSource(
    source.includes(
      "targetCheckShowersLeft: heatingOptimization.targetCheckShowersLeft",
    ) &&
      source.includes(
        "finalShowersLeft: heatingOptimization.finalShowersLeft",
      ),
    "tavoitehetken suihkuvaraus ja horisontin loppuarvo kirjataan lokiin omina, erillisina kenttinaan",
  );
}
