import {
  getTemperatureDropProfileHours,
  parseTemperatureDropProfile,
  selectTemperatureDropProfile,
  TemperatureDropProfileRow,
} from "./temperatureDropProfile";
import { fallbackHourlyTemperatureDrop } from "./tankTemperatureForecast";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function createRow(overrides: Partial<TemperatureDropProfileRow> = {}) {
  return {
    algorithm_version: "weighted-70-30-v1",
    created_at: "2026-07-20T06:00:00.000Z",
    general_fallback: 0.3,
    hourly_drops: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), hour / 10]),
    ),
    observation_days_by_hour: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), hour + 1]),
    ),
    profile_date: "2026-07-20",
    source_days: 30,
    source_end: "2026-07-20T00:00:00.000Z",
    source_start: "2026-06-20T00:00:00.000Z",
    timezone: "Europe/Helsinki",
    ...overrides,
  } satisfies TemperatureDropProfileRow;
}

export function runTemperatureDropProfileUnitTests() {
  const profile = parseTemperatureDropProfile(createRow());

  if (!profile) {
    throw new Error("kelvollinen 24 tunnin profiili hylättiin");
  }

  assertEqual(profile.hourlyDrops[23], 2.3, "24 tunnin profiili validoidaan");

  const validHourDrops = createRow().hourly_drops as Record<string, number>;
  const missingHourDrops = { ...validHourDrops };
  delete missingHourDrops["23"];
  assertEqual(
    parseTemperatureDropProfile(createRow({ hourly_drops: missingHourDrops })),
    null,
    "puuttuva tuntiavain hylätään",
  );

  const localProfile = Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => [hour, 0.5]),
  );
  const staleSelection = selectTemperatureDropProfile({
    localProfile,
    now: new Date("2026-08-10T06:00:00.000Z"),
    supabaseProfile: profile,
  });
  assertEqual(
    staleSelection.profileSource,
    "local-7-day",
    "vanhentunut profiili käyttää paikallista fallbackia",
  );
  assertEqual(
    staleSelection.hourlyTemperatureDropProfile[0],
    0.5,
    "vanhentuneen profiilin tuntiarvoja ei käytetä",
  );

  const freshSelection = selectTemperatureDropProfile({
    localProfile,
    now: new Date("2026-07-25T06:00:00.000Z"),
    supabaseProfile: profile,
  });
  assertEqual(
    freshSelection.profileSource,
    "supabase-30-day",
    "ajantasainen profiili käyttää Supabase-lähdettä",
  );
  assertEqual(
    freshSelection.generalFallback,
    0.3,
    "Supabase-profiilin yleinen fallback säilyy",
  );

  const hours = getTemperatureDropProfileHours(profile);
  assertEqual(
    hours.map((item) => item.hour),
    Array.from({ length: 24 }, (_, hour) => hour),
    "tunnit ovat järjestyksessä 0–23",
  );
  assertEqual(
    hours[17].observationDays,
    18,
    "havaintopäivien määrä välittyy oikealle tunnille",
  );
  assertEqual(
    selectTemperatureDropProfile({
      localProfile,
      supabaseProfile: null,
    }).generalFallback,
    fallbackHourlyTemperatureDrop,
    "puuttuva profiili käyttää viimeisenä 0.25 fallbackia",
  );
}
