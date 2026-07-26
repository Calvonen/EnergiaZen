declare const require: (moduleName: string) => {
  readFileSync(path: string, encoding: string): string;
};

const { readFileSync } = require("fs");

function assertIncludes(source: string, expected: string, message: string) {
  if (!source.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)}`);
  }
}

export function runHeatingGainHistorySourceTests() {
  const source = readFileSync("app/(tabs)/index.tsx", "utf8");

  assertIncludes(
    source,
    "fetchHeatingGainHistory(async (from, to) =>",
    "heating gain history uses paginated fetch",
  );
  assertIncludes(
    source,
    '.eq("heating", true)',
    "heating gain query is filtered on the server",
  );
  assertIncludes(
    source,
    ".range(from, to)",
    "heating gain query uses explicit Supabase ranges",
  );
  assertIncludes(
    source,
    "Date.now() - heatingGainHistoryDays * 24 * 60 * 60 * 1000",
    "heating gain history has a bounded lookback",
  );
  assertIncludes(
    source,
    "tankReadings: heatingOptimizationInput.heatingHistory",
    "optimizer uses the dedicated paginated heating history",
  );
}
