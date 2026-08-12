// Regression check for two classes of bug that broke real
// `npx supabase functions deploy run-heating-optimizer --use-api` deploys,
// neither of which `npm test`/tsc catches on their own:
//
// 1. A relative import escaping supabase/functions/ (e.g.
//    "../../../lib/heatingOptimizer") - the --use-api deploy bundler only
//    resolves relative imports that stay inside supabase/functions/, so
//    this fails to bundle with "Module not found ... /source/lib/...".
// 2. A relative import missing its explicit .ts extension (e.g.
//    "./heatingOptimizer" instead of "./heatingOptimizer.ts") - the
//    bundler does not do Node/esbuild-style extensionless resolution, so
//    this fails to bundle with
//    'Module not found ".../source/supabase/functions/_shared/heatingOptimizer"'
//    even once the file is correctly placed under supabase/functions/.
//
// Both type-check and pass `npm test` fine under Node/tsc regardless (tsc's
// classic/commonjs resolution neither cares about the functions/ boundary
// nor requires the extension), which is exactly how both shipped past
// local verification and only surfaced on a real deploy. There is no Deno
// CLI in this environment to run a real `supabase functions deploy` as a
// regression test, so this statically re-derives the same two rules the
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

  const escapeViolations: string[] = [];
  const missingExtensionViolations: string[] = [];

  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const resolved = normalize(join(dirname(file), specifier));
      const relativeToFunctionsRoot = relative(functionsRoot, resolved);
      const escapesFunctionsRoot =
        relativeToFunctionsRoot === ".." || relativeToFunctionsRoot.startsWith(`..${"/"}`);

      if (escapesFunctionsRoot) {
        escapeViolations.push(`${file} imports "${specifier}" -> resolves outside ${functionsRoot}/`);
      }

      if (!specifier.endsWith(".ts") && !specifier.endsWith(".tsx")) {
        missingExtensionViolations.push(`${file} imports "${specifier}" (missing an explicit .ts extension)`);
      }
    }
  }

  assert(
    escapeViolations.length === 0,
    [
      "Found Edge Function source files with relative imports that escape supabase/functions/ - " +
        "these will fail `npx supabase functions deploy <name> --use-api` with " +
        '"Module not found" even though they resolve fine under Node/tsc. ' +
        "Move the target file under supabase/functions/_shared/ (with a re-export shim left at " +
        "its old lib/ path for existing app callers) instead of importing it from outside " +
        "supabase/functions/:",
      ...escapeViolations,
    ].join("\n"),
  );

  assert(
    missingExtensionViolations.length === 0,
    [
      "Found Edge Function source files with relative imports missing an explicit .ts extension - " +
        "the --use-api deploy bundler does not do extensionless resolution (unlike Node/tsc, which " +
        "resolve these fine locally), so these fail to bundle with " +
        '\'Module not found ".../source/supabase/functions/..."\' on a real deploy. ' +
        'Add the extension, e.g. "./heatingOptimizer" -> "./heatingOptimizer.ts":',
      ...missingExtensionViolations,
    ].join("\n"),
  );
}
