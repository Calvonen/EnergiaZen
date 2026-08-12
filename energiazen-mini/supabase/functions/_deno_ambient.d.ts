// Minimal ambient declarations so every Edge Function's index.ts - which
// uses Deno-only globals and the "npm:" specifier import - can be
// type-checked with a plain Node-installed `typescript` compiler.
//
// This file exists only for tests/edgeFunctionRuntimeBindings.test.ts (see
// supabase/functions/tsconfig.deno-runtime-check.json). It is never
// bundled or deployed - index.ts files are Deno-only and are not
// type-checked by the app's tsconfig.json (which excludes
// supabase/functions/**) or by tsconfig.forecast-tests.json (which never
// includes any index.ts), so a bug like an identifier used without an
// import can type-check clean, pass `npm test`, pass eslint, and pass
// `tsc --noEmit` everywhere else in this repo, then only surface as a real
// runtime ReferenceError on a live Supabase deploy. Deno.serve/env.get are
// typed just precisely enough that every index.ts's handler parameter
// infers under `strict` without needing an explicit annotation - this
// check's job is catching undefined identifiers and similar binding bugs,
// not verifying full Deno API type-correctness.
declare const Deno: {
  serve(handler: (request: Request) => Response | Promise<Response>): void;
  env: { get(name: string): string | undefined };
};

declare module "npm:@supabase/supabase-js@2" {
  export function createClient(...args: any[]): any;
  export type SupabaseClient = any;
}
