import { createClient } from "npm:@supabase/supabase-js@2";

import {
  electricityPriceConflictColumns,
  normalizeSpotPriceResponse,
  selectCurrentAndNextAvailableDays,
} from "./normalize.ts";

const sourceBaseUrl = "https://api.spot-hinta.fi/TodayAndDayForward";
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

function getResolutionMinutes(): 15 | 60 {
  const value = Number(Deno.env.get("PRICE_RESOLUTION_MINUTES") ?? "60");
  if (value !== 15 && value !== 60) {
    throw new Error("PRICE_RESOLUTION_MINUTES must be 15 or 60");
  }
  return value;
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
        500,
      );
    }

    const region = "FI";
    const resolutionMinutes = getResolutionMinutes();
    const sourceUrl = new URL(sourceBaseUrl);
    sourceUrl.searchParams.set("region", region);
    sourceUrl.searchParams.set(
      "priceResolution",
      String(resolutionMinutes),
    );

    const sourceResponse = await fetch(sourceUrl, {
      headers: { Accept: "application/json" },
    });
    if (!sourceResponse.ok) {
      return jsonResponse(
        {
          error: "Electricity price source request failed",
          source_status: sourceResponse.status,
        },
        sourceResponse.status === 429 ? 429 : 502,
      );
    }

    let sourceData: unknown;
    try {
      sourceData = await sourceResponse.json();
    } catch {
      return jsonResponse(
        { error: "Electricity price source returned invalid JSON" },
        502,
      );
    }
    if (!Array.isArray(sourceData)) {
      return jsonResponse(
        { error: "Electricity price source returned an invalid payload" },
        502,
      );
    }

    const fetchedAt = new Date().toISOString();
    const normalizedRows = normalizeSpotPriceResponse(sourceData, {
      fetchedAt,
      region,
      resolutionMinutes,
    });
    const rows = selectCurrentAndNextAvailableDays(normalizedRows);
    if (rows.length === 0) {
      return jsonResponse(
        { error: "No valid prices for the current or next available day" },
        502,
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const { error } = await supabase.from("electricity_prices").upsert(rows, {
      onConflict: electricityPriceConflictColumns,
    });
    if (error) {
      console.error("electricity_prices upsert failed", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
      return jsonResponse(
        {
          error: "Failed to save electricity prices",
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        },
        500,
      );
    }

    const dates = [...new Set(rows.map((row) => row.price_date))].sort();
    return jsonResponse({
      date_range: { from: dates[0], to: dates[dates.length - 1] },
      fetched: sourceData.length,
      inserted_or_updated: rows.length,
      region,
      resolution_minutes: resolutionMinutes,
    });
  } catch (error) {
    console.error("fetch-electricity-prices failed", error);
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected electricity price fetch error",
      },
      500,
    );
  }
});
