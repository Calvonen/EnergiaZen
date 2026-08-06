declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit: (code?: number) => never;
};
declare function require(moduleName: string): any;

import { validateReplay } from "../lib/energyModelV2/replayValidation";
import { createSensorGeometryEpochs } from "../lib/energyModelV2/sensorGeometry";
import type { TankTemperatureReading } from "../lib/tankTemperatureForecast";

const fs = require("node:fs/promises");
const path = require("node:path");

const readingColumns = "created_at,top_temp,bottom_temp,inlet_temp,heating";
const pageSize = 1000;
const envSupabaseUrl = process.env.SUPABASE_URL ?? process.env.ENERGIAZEN_SUPABASE_URL;
const envSupabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_KEY;
const envTopSensorMovedAt = process.env.ENERGYZEN_TOP_SENSOR_MOVED_AT;

type ReplayValidateArgs = {
  day: string;
  outputDir: string | null;
  topSensorMovedAt: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = readSupabaseUrl();
  const supabaseKey = readSupabaseKey();
  const { fromInclusive, toExclusive } = getHelsinkiDayBoundsUtc(args.day);
  const readings = await fetchTankReadings({
    fromInclusive,
    supabaseKey,
    supabaseUrl,
    toExclusive,
  });

  if (readings.length === 0) {
    throw new Error(
      `No tank_readings found for ${args.day} (${fromInclusive} - ${toExclusive})`,
    );
  }

  const validation = validateReplay({
    readings,
    sensorGeometryEpochs: createSensorGeometryEpochs({
      topSensorMovedAt: args.topSensorMovedAt,
    }),
  });
  const outputDir = args.outputDir ?? path.join("artifacts", "replay", args.day);

  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(path.join(outputDir, "report.json"), {
      ...validation.report,
      events: validation.events,
      replayWindow: {
        fromInclusive,
        toExclusive,
      },
    }),
    writeJson(path.join(outputDir, "metrics.json"), validation.metrics),
    fs.writeFile(path.join(outputDir, "replay.csv"), `${validation.csv}\n`, "utf8"),
    writeJson(path.join(outputDir, "visualization.json"), validation.visualizationData),
  ]);

  console.log(
    JSON.stringify(
      {
        day: args.day,
        outputDir,
        readingCount: readings.length,
        report: validation.report,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): ReplayValidateArgs {
  const day = readOption(argv, "--day") ?? readPositionalDay(argv);
  const outputDir = readOption(argv, "--output-dir");
  const topSensorMovedAt =
    readOption(argv, "--top-sensor-moved-at") ??
    envTopSensorMovedAt ??
    null;

  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Usage: npm run replay:validate --day YYYY-MM-DD");
  }
  if (!topSensorMovedAt || !Number.isFinite(new Date(topSensorMovedAt).getTime())) {
    throw new Error(
      "Set ENERGYZEN_TOP_SENSOR_MOVED_AT or pass --top-sensor-moved-at ISO_TIMESTAMP",
    );
  }

  return { day, outputDir, topSensorMovedAt };
}

function readPositionalDay(argv: string[]) {
  return argv.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? null;
}

function readOption(argv: string[], name: string) {
  const index = argv.indexOf(name);

  if (index === -1) {
    return null;
  }

  return argv[index + 1] ?? null;
}

function readSupabaseUrl() {
  if (envSupabaseUrl) {
    return envSupabaseUrl;
  }

  throw new Error("Missing required environment variable: SUPABASE_URL or ENERGIAZEN_SUPABASE_URL");
}

function readSupabaseKey() {
  if (envSupabaseKey) {
    return envSupabaseKey;
  }

  throw new Error(
    "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY or SUPABASE_KEY",
  );
}

async function fetchTankReadings({
  fromInclusive,
  supabaseKey,
  supabaseUrl,
  toExclusive,
}: {
  fromInclusive: string;
  supabaseKey: string;
  supabaseUrl: string;
  toExclusive: string;
}) {
  const readings: TankTemperatureReading[] = [];
  let offset = 0;

  while (true) {
    const url = new URL("/rest/v1/tank_readings", supabaseUrl);

    url.searchParams.set("select", readingColumns);
    url.searchParams.set("created_at", `gte.${fromInclusive}`);
    url.searchParams.append("created_at", `lt.${toExclusive}`);
    url.searchParams.set("order", "created_at.asc");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Supabase tank_readings fetch failed: ${response.status} ${await response.text()}`,
      );
    }

    const page = (await response.json()) as TankTemperatureReading[];
    readings.push(...page);

    if (page.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return readings;
}

function getHelsinkiDayBoundsUtc(day: string) {
  const start = getHelsinkiDateStartIso(day);
  const [year, month, date] = day.split("-").map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, date + 1))
    .toISOString()
    .slice(0, 10);

  return {
    fromInclusive: start,
    toExclusive: getHelsinkiDateStartIso(nextDay),
  };
}

function getHelsinkiDateStartIso(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetTimestamp = Date.UTC(year, month - 1, day);
  let utcTimestamp = targetTimestamp;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Helsinki",
    year: "numeric",
  });

  for (let index = 0; index < 2; index += 1) {
    const parts = formatter.formatToParts(new Date(utcTimestamp));
    const getPart = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const localTimestamp = Date.UTC(
      getPart("year"),
      getPart("month") - 1,
      getPart("day"),
      getPart("hour"),
      getPart("minute"),
      getPart("second"),
    );

    utcTimestamp += targetTimestamp - localTimestamp;
  }

  return new Date(utcTimestamp).toISOString();
}

async function writeJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
