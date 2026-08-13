// Single source of truth lives in supabase/functions/_shared/heatingBackendWatchdog.ts -
// framework-agnostic domain logic, kept alongside the app's other shared
// optimizer/publication modules for the same reason (see
// heatingOptimizer.ts in this directory): it lives under supabase/functions/
// so a future Edge Function watchdog can import it without escaping
// supabase/functions/ (the --use-api deploy bundler requirement). This file
// exists only so Node-side tooling (unit tests, the fail-safe simulator)
// can import it the same way every other shared domain module here is
// imported.
export * from "../supabase/functions/_shared/heatingBackendWatchdog";
