// Regression check for the class of bug that broke `npx supabase functions
// deploy run-heating-optimizer --use-api`: an Edge Function (or a module it
// imports) reaching outside supabase/functions/ via a relative import
// (e.g. "../../../lib/heatingOptimizer"). Supabase's --use-api deploy
// bundler only resolves relative imports that stay inside
// supabase/functions/ - such an import type-checks and passes `npm test`
// fine under Node/tsc, but fails to bundle for a real deploy with
// "Module not found ... /source/lib/...". There is no Deno CLI in this
// environment to run a real `supabase functions deploy` as a regression
// test, so this statically re-derives the same containment rule the
// bundler enforces, without needing network access or Deno.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const functionsRoot = "supabase/functions";
const fromSpecifierPattern = /\bfrom\s+["']([^"']+)["']/g;

function listDeployableSourceFiles(root: string): string[] {
  const absoluteRoot = join(process.cwd(), root);
  const entries = readdirSync(absoluteRoot, { recursive: true }) as string[];

  return entries
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(root, entry))
    .filter((path) => statSync(join(process.cwd(), path)).isFile());
}

// Every "from '...'" specifier that starts with "." (a relative import),
// wherever it appears in the file - single-line or spread across a
// multi-line import/export-from block.
function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(fromSpecifierPattern)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

export function runEdgeFunctionImportBoundariesUnitTests() {
  const files = listDeployableSourceFiles(functionsRoot);
  assert(files.length > 0, "expected to find deployable .ts files under supabase/functions/");

  const violations: string[] = [];

  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const resolved = normalize(join(dirname(file), specifier));
      const relativeToFunctionsRoot = relative(functionsRoot, resolved);
      const escapesFunctionsRoot =
        relativeToFunctionsRoot === ".." || relativeToFunctionsRoot.startsWith(`..${"/"}`);

      if (escapesFunctionsRoot) {
        violations.push(`${file} imports "${specifier}" -> resolves outside ${functionsRoot}/`);
      }
    }
  }

  assert(
    violations.length === 0,
    [
      "Found Edge Function source files with relative imports that escape supabase/functions/ - " +
        "these will fail `npx supabase functions deploy <name> --use-api` with " +
        '"Module not found" even though they resolve fine under Node/tsc. ' +
        "Move the target file under supabase/functions/_shared/ (with a re-export shim left at " +
        "its old lib/ path for existing app callers) instead of importing it from outside " +
        "supabase/functions/:",
      ...violations,
    ].join("\n"),
  );
}
