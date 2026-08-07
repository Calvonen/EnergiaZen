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
    temperatureHistorySource.includes('(["24h", "day"] as const)') &&
      temperatureHistorySource.includes('"Edelliset päivät"') &&
      !temperatureHistorySource.includes('"7 vrk"') &&
      !temperatureHistorySource.includes('"7d"'),
    "lampohistoria korvaa 7 vrk -valilehden Edelliset paivat -nakymalla",
  );
  assertSource(
    temperatureHistorySource.includes("inFlightRef") &&
      temperatureHistorySource.includes("fetchCountRef") &&
      temperatureHistorySource.includes("Päivitetään...") &&
      !temperatureHistorySource.includes("setHistory24h([])") &&
      !temperatureHistorySource.includes("setHistoryDay([])"),
    "lampohistoria sailyttaa nakyvan datan ja estaa paallekkaiset haut",
  );
  assertSource(
    temperatureHistorySource.includes('"get_temperature_history_points"') &&
      temperatureHistorySource.includes("dayHistoryBucketMinutes") &&
      temperatureHistorySource.includes("getHelsinkiDayRange(dayKey)") &&
      temperatureHistorySource.includes("p_bucket_minutes: bucketMinutes"),
    "lampohistoria kayttaa Supabase RPC:ta ja 30 minuutin paivabucketointia",
  );
  assertSource(
    temperatureHistorySource.includes("temperatureHistoryDayCache") &&
      temperatureHistorySource.includes("getTemperatureHistoryDayCacheKey") &&
      temperatureHistorySource.includes("temperatureHistoryDayCache.has(cacheKey)") &&
      temperatureHistorySource.includes("temperatureHistoryDayCache.set(cacheKey"),
    "paivakohtainen lampohistoria cachetetaan nakyman, bucketin ja paivamaaran avaimella",
  );
  assertSource(
    temperatureHistorySource.includes("addHelsinkiCalendarDays") &&
      temperatureHistorySource.includes("isTodayHelsinkiDay") &&
      !temperatureHistorySource.includes("Eilen") &&
      !temperatureHistorySource.includes("Tänään") &&
      !temperatureHistorySource.includes("dayShortcut") &&
      temperatureHistorySource.includes(
        "Tältä päivältä ei ole lämpötilatietoja",
      ),
    "paivavalitsin estaa tulevaisuuden, ei sisalla pikavalintoja ja tyhja paiva nayttaa tyhjan tilan",
  );
  assertSource(
    temperatureHistorySource.includes("const tooltipWidth = 104") &&
      temperatureHistorySource.includes("historyTooltipLeft.setValue(tooltipLeft)") &&
      temperatureHistorySource.includes("Gesture.Pan()") &&
      temperatureHistorySource.includes(".activeOffsetX([-6, 6])") &&
      temperatureHistorySource.includes(".failOffsetY([-8, 8])") &&
      temperatureHistorySource.includes(".onUpdate((event) => updateSelectedHistoryPoint(event.x))") &&
      !temperatureHistorySource.includes(".onFinalize(() => setSelectedHistoryPoint(null))") &&
      temperatureHistorySource.includes("point.timestamp === currentPoint.point.timestamp") &&
      temperatureHistorySource.includes("return () => setSelectedHistoryPoint(null)") &&
      !temperatureHistorySource.includes("onResponderMove={updateSelectedHistoryPoint}") &&
      !temperatureHistorySource.includes("onResponderTerminationRequest={() => false}") &&
      temperatureHistorySource.includes("currentPoint?.index === nearestIndex") &&
      temperatureHistorySource.includes("[chartWidth, historyTooltipLeft, visibleHistory]") &&
      temperatureHistorySource.includes("pointX:"),
    "lampohistorian tooltip kayttaa natiivia vaakasuuntaista pan-eletta, ja valinta sailyy eleen jalkeen",
  );
  assertSource(
    !homeSource.includes("Viimeisin jakso") &&
      homeSource.includes("heatingPlanPresentation.selectedHours") &&
      homeSource.includes("heatingPlanPresentation.forecastSummary"),
    "etusivulta saa poistua vain Viimeisin jakso -tiedot",
  );
  assertSource(
    !homeSource.includes("heatingPlanPresentation.planCostSummary") &&
      !homeSource.includes("splitPlanCostSummary"),
    "lammityssuunnitelman arvioitu hinta -rivi on poistettu etusivulta kokonaan",
  );
  assertSource(
    homeSource.includes('.eq("region", electricityPriceRegion)') &&
      homeSource.includes('.eq("price_date", yesterdayKey)'),
    "etusivun eilisen hintahaku rajataan alueeseen ja paivaan ennen Supabasen rivirajaa",
  );
}
