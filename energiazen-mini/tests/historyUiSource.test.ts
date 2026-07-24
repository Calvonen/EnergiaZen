import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(
  condition: boolean,
  message: string,
) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runHistoryUiSourceTests() {
  const historySource = readFileSync(
    join(process.cwd(), "app/electricity-history.tsx"),
    "utf8",
  );
  const homeSource = readFileSync(
    join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );

  assertSource(
    !historySource.includes("Hintatyyppi") &&
      !historySource.includes('value === "spot" ? "Spot" : "Yhteensä"'),
    "Spot/Yhteensä-valintaa ei saa renderöidä",
  );
  assertSource(
    historySource.includes('"Kaikki hinnat" : "Lämmitetyt tunnit"') &&
      historySource.includes("calculateHeatedPriceHistory") &&
      historySource.includes("segment.spotPriceCentsPerKwh"),
    "Lämmitetyt tunnit -näkymän ja spot-lisätiedon pitää säilyä",
  );
  assertSource(
    historySource.includes(
      'useState<HistoryDataFilter>("heated")',
    ) &&
      historySource.includes('(["heated", "all"] as const)') &&
      historySource.indexOf('(["heated", "all"] as const)') <
        historySource.indexOf(
          'value === "all" ? "Kaikki hinnat" : "Lämmitetyt tunnit"',
        ),
    "Lämmitetyt tunnit on ensimmäinen ja oletuksena valittu vaihtoehto",
  );
  assertSource(
    !historySource.includes('setDataFilter("all")') &&
      !historySource.includes('setDataFilter("heated")') &&
      historySource.includes("onPress={() => setRange(option.value)}"),
    "aikavälin vaihto ei saa vaihtaa tarkasteltavan datan valintaa",
  );
  assertSource(
    historySource.includes('dataFilter === "all"') &&
      historySource.includes("groupElectricityPricesByHelsinkiDay"),
    "Kaikki hinnat -näkymän pitää säilyä",
  );
  assertSource(
    historySource.includes("buildTodayHeatingTimeline") &&
      homeSource.includes("getHeatingHourMarker"),
    "historian ja etusivun pitää käyttää yhteistä merkkilogiikkaa",
  );
  assertSource(
    !homeSource.includes("Viimeisin jakso") &&
      homeSource.includes("heatingPlanPresentation.selectedHours") &&
      homeSource.includes("heatingPlanPresentation.planCostSummary") &&
      homeSource.includes("heatingPlanPresentation.forecastSummary"),
    "etusivulta saa poistua vain Viimeisin jakso -tiedot",
  );
}
