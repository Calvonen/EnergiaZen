// Regression check for the class of bug that shipped a working deploy
// (`npx supabase functions deploy run-heating-optimizer --use-api`
// succeeded) that then 500'd on its first real invocation:
//
//   ReferenceError: fetchHeatingGainHistory is not defined
//
// index.ts called fetchHeatingGainHistory(...) but never imported it from
// "./logic.ts" - logic.ts did re-export it, but nothing forced index.ts's
// own import list to actually name it. This is invisible to every other
// check in this repo: index.ts files are Deno-only (Deno.serve, Deno.env,
// "npm:" specifier imports) and are deliberately excluded from the app's
// tsconfig.json (which excludes supabase/functions/**) and never appear in
// tsconfig.forecast-tests.json's include list either - so a plain
// undefined-identifier bug in an index.ts type-checks as "not checked at
// all", passes `npm test`, passes eslint, passes `tsc --noEmit` on the app,
// and only surfaces as a live 500 on a real Supabase invocation.
//
// This runs a real `tsc --noEmit` over every supabase/functions/*/index.ts
// (and its non-test local dependencies, including supabase/functions/
// _shared/**) using supabase/functions/tsconfig.deno-runtime-check.json,
// which stubs just enough of the Deno/npm-specifier surface (see
// supabase/functions/_deno_ambient.d.ts) for a plain Node-installed
// `typescript` to resolve everything else for real - catching an
// undefined/renamed/never-exported identifier the same way tsc would catch
// it anywhere else in this repo, not just a hand-rolled name-matcher.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function runEdgeFunctionRuntimeBindingsUnitTests() {
  const tscBin = require.resolve("typescript/bin/tsc");
  const configPath = join(process.cwd(), "supabase/functions/tsconfig.deno-runtime-check.json");

  try {
    execFileSync(process.execPath, [tscBin, "-p", configPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const output =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : String(error);

    assert(
      false,
      [
        "supabase/functions/*/index.ts (and their local dependencies) failed a real tsc " +
          "type-check under supabase/functions/tsconfig.deno-runtime-check.json - this usually " +
          "means an identifier is used without being imported/exported (exactly the class of bug " +
          "that shipped a working deploy which then 500'd with a ReferenceError on its first real " +
          "invocation). Run `node node_modules/typescript/bin/tsc -p " +
          "supabase/functions/tsconfig.deno-runtime-check.json` directly to see the same output:",
        output.trim(),
      ].join("\n"),
    );
  }
}
