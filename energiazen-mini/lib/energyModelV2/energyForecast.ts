// Single source of truth lives in supabase/functions/_shared/energyModelV2/energyForecast.ts.
// Keep the app import path stable while allowing the same framework-agnostic
// implementation to run in Supabase Edge Functions.
export * from "../../supabase/functions/_shared/energyModelV2/energyForecast";
