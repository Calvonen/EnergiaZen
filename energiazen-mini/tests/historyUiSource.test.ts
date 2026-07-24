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
  const temperatureHistorySource = readFileSync(
    join(process.cwd(), "app/history.tsx"),
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
    historySource.includes('"get_heating_periods"') &&
      !historySource.includes("fetchAllHeatingHistory("),
    "hintahistoria ei saa hakea kaikkia tank_readings-riveja pitkilta aikavaleilta",
  );
  assertSource(
    historySource.includes("isLoading ? (") &&
      !historySource.includes(
        'isLoading || (dataFilter === "heated" && isHeatingLoading)',
      ) &&
      historySource.includes("heatingLoadingCard"),
    "hintahistoria ja trendi naytetaan hintahaun jalkeen ilman lammityshistorian blokkia",
  );
  assertSource(
    historySource.includes("cacheRef") &&
      historySource.includes("inFlightRef") &&
      historySource.includes("fetchHistory(range") &&
      !historySource.includes("useEffect(() => {\n    void fetchHistory();"),
    "hintahistorian range-cache estaa turhat haut ja dataFilter pysyy paikallisena suodatuksena",
  );
  assertSource(
    !historySource.includes('size="large" style={styles.loader}') &&
      historySource.includes("loadingCard") &&
      historySource.includes("Päivitetään..."),
    "hintahistoria ei saa palauttaa koko data-alueen isoa spinneria",
  );
  assertSource(
    temperatureHistorySource.includes("void loadHistoryTab(selectedTab)") &&
      temperatureHistorySource.includes("hasLoadedRef.current[tab]") &&
      !temperatureHistorySource.includes("const d7Start") &&
      !temperatureHistorySource.includes("fetchTankReadingsSince"),
    "lampohistoria hakee 7 vrk datan laiskasti vain valitulle valilehdelle",
  );
  assertSource(
    temperatureHistorySource.includes("inFlightRef") &&
      temperatureHistorySource.includes("fetchCountRef") &&
      temperatureHistorySource.includes("Päivitetään...") &&
      !temperatureHistorySource.includes("setHistory24h([])") &&
      !temperatureHistorySource.includes("setHistory7d([])"),
    "lampohistoria sailyttaa nakyvan datan ja estaa paallekkaiset haut",
  );
  assertSource(
    temperatureHistorySource.includes('"get_temperature_history_points"') &&
      temperatureHistorySource.includes(
        'const bucketMinutes = tab === "24h" ? 10 : 60',
      ) &&
      temperatureHistorySource.includes("p_bucket_minutes: bucketMinutes"),
    "lampohistoria kayttaa supabase-harvennusta 10/60 minuutin valeilla",
  );
  assertSource(
    !homeSource.includes("Viimeisin jakso") &&
      homeSource.includes("heatingPlanPresentation.selectedHours") &&
      homeSource.includes("heatingPlanPresentation.planCostSummary") &&
      homeSource.includes("heatingPlanPresentation.forecastSummary"),
    "etusivulta saa poistua vain Viimeisin jakso -tiedot",
  );
}
