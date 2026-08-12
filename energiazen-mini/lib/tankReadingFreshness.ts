// Single source of truth lives in supabase/functions/_shared/tankReadingFreshness.ts -
// framework-agnostic domain logic shared between the app and the
// run-heating-optimizer Edge Function. It lives under supabase/functions/
// (not here) because Supabase's --use-api deploy bundler only resolves
// imports that stay inside supabase/functions/ - see this repo's shadow-
// mode PR report for the full reasoning. This file exists only so every
// existing app import path keeps working unchanged.
export * from "../supabase/functions/_shared/tankReadingFreshness";
