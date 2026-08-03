import {
  estimateRecoveryDropPerHour,
  recoveryDropLearningLimits,
} from "./heatingRecoveryDrop";
import { fallbackHourlyTemperatureDrop } from "./tankTemperatureForecast";
import type { TankTemperatureReading } from "./tankTemperatureForecast";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function reading(
  createdAt: string,
  temperature: number,
  heating: boolean | null,
): TankTemperatureReading {
  return {
    bottom_temp: temperature,
    created_at: createdAt,
    heating,
    top_temp: temperature,
  };
}

// Mirrors heatingGain.test.ts's helper: a 30 min, 4-reading segment that
// findValidHeatingSegments accepts, ending at initialTemperature + gainPerHour/2.
function createHeatingSegment(
  start: string,
  gainPerHour: number,
  initialTemperature = 40,
): TankTemperatureReading[] {
  const startTime = new Date(start).getTime();

  return [0, 10, 20, 30].map((minutes) => ({
    bottom_temp: initialTemperature + gainPerHour * (minutes / 60),
    created_at: new Date(startTime + minutes * 60 * 1000).toISOString(),
    heating: true,
    top_temp: initialTemperature + gainPerHour * (minutes / 60),
  }));
}

// The segment's last heating=true reading lands at `start` + 30 min. A poll
// interval later (here: +5 min, i.e. `start` + 35 min) is the first
// confirmed heating=false reading - the real off-transition per Codex's
// PR #121 review, not the segment's own endTime.
function offTransitionReading(start: string, temperature: number) {
  const startTime = new Date(start).getTime();

  return reading(
    new Date(startTime + 35 * 60 * 1000).toISOString(),
    temperature,
    false,
  );
}

// One full recovery window (60 min) after the off-transition reading, i.e.
// `start` + 95 min.
function recoveryReading(start: string, temperature: number) {
  const startTime = new Date(start).getTime();

  return reading(
    new Date(startTime + 95 * 60 * 1000).toISOString(),
    temperature,
    false,
  );
}

function withInlet(
  base: TankTemperatureReading,
  inletTemperatureC: number,
): TankTemperatureReading {
  return { ...base, inlet_temp: inletTemperatureC };
}

function cleanRecoverySegment(
  start: string,
): TankTemperatureReading[] {
  return [
    ...createHeatingSegment(start, 4),
    offTransitionReading(start, 42.3),
    recoveryReading(start, 42.2),
  ];
}

export function runHeatingRecoveryDropUnitTests() {
  {
    const readings = [
      ...createHeatingSegment("2026-07-01T00:00:00.000Z", 4),
      offTransitionReading("2026-07-01T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-01T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-02T00:00:00.000Z", 4),
      offTransitionReading("2026-07-02T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-02T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-03T00:00:00.000Z", 4),
      offTransitionReading("2026-07-03T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-03T00:00:00.000Z", 42.2),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    // Baseline is the off-transition reading (42.3), not the segment's own
    // endWeightedTemperature (42) - drop is 42.3 - 42.2 = 0.1 C over 1h.
    assertClose(
      estimate.dropPerHour,
      0.1,
      "palautumisnopeus lasketaan heating=false-siirtymalukemasta, ei jakson omasta loppulukemasta",
    );
    assertEqual(estimate.fallbackUsed, false, "riittava naytemaara kayttaa opittua arvoa");
    assertEqual(estimate.sampleCount, 3, "jokainen puhdas jakso tuottaa yhden naytteen");
  }

  {
    // Demonstrates the exact bug Codex flagged: anchoring on the segment's
    // own endTime (still mid-heating-tail) instead of the confirmed
    // heating=false reading folds the last interval's heating gain into the
    // learned drop, producing a spuriously large negative (rising) rate.
    const readings = [
      ...createHeatingSegment("2026-07-01T00:00:00.000Z", 4),
      offTransitionReading("2026-07-01T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-01T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-02T00:00:00.000Z", 4),
      offTransitionReading("2026-07-02T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-02T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-03T00:00:00.000Z", 4),
      offTransitionReading("2026-07-03T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-03T00:00:00.000Z", 42.2),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);
    const buggyAnchorDropPerHour = (42 - 42.2) / ((95 - 30) / 60);

    if (Math.abs(estimate.dropPerHour - buggyAnchorDropPerHour) < 0.01) {
      throw new Error(
        "korjaus ei toimi: tulos vastaa yha jakson omaan loppulukemaan ankkuroitua (virheellista) laskentaa",
      );
    }
  }

  {
    const readings = [
      ...createHeatingSegment("2026-07-01T00:00:00.000Z", 4),
      offTransitionReading("2026-07-01T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-01T00:00:00.000Z", 42.2),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.fallbackUsed,
      true,
      "liian vahan naytteita kayttaa fallbackia",
    );
    assertClose(
      estimate.dropPerHour,
      fallbackHourlyTemperatureDrop,
      "fallback on sama kuin hourlyDrop-profiilin oletusarvo",
    );
  }

  {
    const readings = [
      ...createHeatingSegment("2026-07-01T00:00:00.000Z", 4),
      offTransitionReading("2026-07-01T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-01T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-02T00:00:00.000Z", 4),
      offTransitionReading("2026-07-02T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-02T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-03T00:00:00.000Z", 4),
      offTransitionReading("2026-07-03T00:00:00.000Z", 42.3),
      // Uusi lammitys kaynnistyy palautumisikkunan sisalla -> naytetta ei
      // kelpuuteta.
      reading("2026-07-03T00:50:00.000Z", 42.5, true),
      recoveryReading("2026-07-03T00:00:00.000Z", 42.2),
    ];
    const estimate = estimateRecoveryDropPerHour(readings, 0.33);

    assertEqual(
      estimate.sampleCount,
      2,
      "palautumisikkunan sisalla alkava uusi lammitys ei tuota naytetta",
    );
    assertEqual(estimate.fallbackUsed, true, "kaksi naytetta ei riita opittuun arvoon");
    assertClose(
      estimate.dropPerHour,
      0.33,
      "annettu fallback kaytossa kun naytteita on liian vahan",
    );
  }

  {
    const readings = [
      ...createHeatingSegment("2026-07-01T00:00:00.000Z", 4),
      offTransitionReading("2026-07-01T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-01T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-02T00:00:00.000Z", 4),
      offTransitionReading("2026-07-02T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-02T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-03T00:00:00.000Z", 4),
      offTransitionReading("2026-07-03T00:00:00.000Z", 42.3),
      // Yli toleranssin (15 min) myohassa oleva lukema ei kelpaa: kohde on
      // offTransition + 95 min, tama on offTransion + 95 + 20 min.
      reading(
        new Date(
          new Date("2026-07-03T00:35:00.000Z").getTime() +
            (95 + recoveryDropLearningLimits.recoveryWindowToleranceMinutes + 5) *
              60 *
              1000,
        ).toISOString(),
        42.2,
        false,
      ),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      2,
      "toleranssin ulkopuolella oleva lukema ei tuota naytetta",
    );
  }

  {
    const readings = [
      ...createHeatingSegment("2026-07-01T00:00:00.000Z", 4),
      offTransitionReading("2026-07-01T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-01T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-02T00:00:00.000Z", 4),
      offTransitionReading("2026-07-02T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-02T00:00:00.000Z", 42.2),
      // Ei yhtaan heating=false-lukemaa jakson jalkeen -> naytetta ei voi
      // muodostaa lainkaan.
      ...createHeatingSegment("2026-07-03T00:00:00.000Z", 4),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      2,
      "jakso jota ei koskaan seuraa heating=false-lukema ei tuota naytetta",
    );
  }

  {
    // Todellinen tapaus: suihku alkaa juuri lammityksen paattyessa. Varaajan
    // omasta lampotilasta se ei valttamatta erotu, mutta tulovesianturi
    // nakee nopean, kylman pudotuksen (idle ~15.7, virtaava vesi ~12.2 -
    // oikealta laitteistolta mitatut arvot) 2 min siirtymalukeman jalkeen.
    const start3 = "2026-07-03T00:00:00.000Z";
    const drawStart = new Date(
      new Date(start3).getTime() + 37 * 60 * 1000,
    ).toISOString();
    const readings = [
      ...cleanRecoverySegment("2026-07-01T00:00:00.000Z"),
      ...cleanRecoverySegment("2026-07-02T00:00:00.000Z"),
      ...createHeatingSegment(start3, 4),
      withInlet(offTransitionReading(start3, 42.3), 15.7),
      withInlet(reading(drawStart, 42.25, false), 12.2),
      recoveryReading(start3, 42.2),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      2,
      "nopea pudotus tulovesilampotilassa palautumisikkunan alussa hylkaa naytteen",
    );
  }

  {
    // Sama pudotus mutta yli 5 minuutin ajalla (hitaampi kuin todellinen
    // vedenoton signatuuri) - ei tulkita vedenotoksi, nayte kelpaa.
    const start3 = "2026-07-03T00:00:00.000Z";
    const slowDrawTime = new Date(
      new Date(start3).getTime() + 45 * 60 * 1000,
    ).toISOString();
    const readings = [
      ...cleanRecoverySegment("2026-07-01T00:00:00.000Z"),
      ...cleanRecoverySegment("2026-07-02T00:00:00.000Z"),
      ...createHeatingSegment(start3, 4),
      withInlet(offTransitionReading(start3, 42.3), 15.7),
      withInlet(reading(slowDrawTime, 42.25, false), 12.2),
      recoveryReading(start3, 42.2),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      3,
      "yli 5 minuutin ajalla tapahtuva pudotus ei ole tarpeeksi nopea tulkittavaksi vedenotoksi",
    );
  }

  {
    // Tulovesi pysyy vakaana (ei pudotusta) koko ikkunan ajan - ei saa
    // hylata naytetta pelkan anturidatan lasnaolon takia.
    const start3 = "2026-07-03T00:00:00.000Z";
    const readings = [
      ...cleanRecoverySegment("2026-07-01T00:00:00.000Z"),
      ...cleanRecoverySegment("2026-07-02T00:00:00.000Z"),
      ...createHeatingSegment(start3, 4),
      withInlet(offTransitionReading(start3, 42.3), 15.7),
      withInlet(recoveryReading(start3, 42.2), 15.6),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      3,
      "vakaa tulovesilampotila ei hylkaa naytetta",
    );
  }

  {
    // Codexin P2-loydos: vedenotto on jo kaynnissa siirtymalukemalla itsellaan
    // (esim. suihku alkoi juuri ennen ensimmaista heating=false-pollia).
    // Ilman edeltavaa ikkunaa tama ei nakynyt mitenkaan, koska
    // siirtymalukema oli aina ensimmainen tarkasteltu piste. Uudelleenkaytetaan
    // lammitysjakson viimeista (heating=true) lukemaa vertailukohtana - se on
    // tasan 5 min ennen siirtymalukemaa, edeltavan ikkunan rajalla.
    const start3 = "2026-07-03T00:00:00.000Z";
    const heatingSegment3 = createHeatingSegment(start3, 4);
    const lastHeatingReadingWithInlet = withInlet(
      heatingSegment3[heatingSegment3.length - 1],
      15.7,
    );
    const readings = [
      ...cleanRecoverySegment("2026-07-01T00:00:00.000Z"),
      ...cleanRecoverySegment("2026-07-02T00:00:00.000Z"),
      ...heatingSegment3.slice(0, -1),
      lastHeatingReadingWithInlet,
      withInlet(offTransitionReading(start3, 42.3), 12.2),
      recoveryReading(start3, 42.2),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      2,
      "siirtymalukemalla jo kaynnissa oleva vedenotto havaitaan edeltavan ikkunan lukemien avulla",
    );
  }

  {
    // Codexin toinen P2-loydos: vedenotto tapahtuu candidates-joukossa mutta
    // valitun paatepisteen (nearest) JALKEEN - se ei vaikuta laskettuun
    // pudotukseen (vain offTransitionReading ja nearest kayttavat), joten
    // sen ei pida hylata muuten puhdasta naytetta. nearest osuu tasan
    // tavoiteaikaan (+95 min), vedenotto tulee +100 min kohdalla.
    const start3 = "2026-07-03T00:00:00.000Z";
    const afterNearestDrawTime = new Date(
      new Date(start3).getTime() + 100 * 60 * 1000,
    ).toISOString();
    const readings = [
      ...cleanRecoverySegment("2026-07-01T00:00:00.000Z"),
      ...cleanRecoverySegment("2026-07-02T00:00:00.000Z"),
      ...createHeatingSegment(start3, 4),
      withInlet(offTransitionReading(start3, 42.3), 15.7),
      withInlet(recoveryReading(start3, 42.2), 15.6),
      withInlet(reading(afterNearestDrawTime, 42.15, false), 12.0),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      3,
      "valitun paatepisteen jalkeen tapahtuva vedenotto ei hylkaa muuten puhdasta naytetta",
    );
  }

  {
    // Todellinen tapaus: lammitys pysahtyi varaajan mekaaniseen
    // termostaattiin (60 astetta), ei appin omaan paatokseen.
    // estimateRecoveryDropPerHour kayttaa vain findValidHeatingSegments:n
    // hyvaksymia jaksoja, joten heatingGain.ts:n hylkays (ks.
    // heatingGain.test.ts) poistaa jakson myos taalta ilman erillista
    // tarkistusta - tama testi todistaa etta se ketju todella toimii.
    const readings = [
      ...cleanRecoverySegment("2026-07-01T00:00:00.000Z"),
      ...cleanRecoverySegment("2026-07-02T00:00:00.000Z"),
      ...createHeatingSegment("2026-07-03T00:00:00.000Z", 4, 58),
      offTransitionReading("2026-07-03T00:00:00.000Z", 60.1),
      recoveryReading("2026-07-03T00:00:00.000Z", 60.0),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      2,
      "termostaatin todennakoisesti katkaisema lammitysjakso ei tuota myoskaan recoveryDrop-naytetta",
    );
  }

  {
    // T1-regressio: epavarma (heating=null, esim. Shellyn statuskysely
    // epaonnistui ESP32:lla) lukema ei kelpaa off-transition-ankkuriksi -
    // vain eksplisiittinen heating=false kelpaa. Jos jaksoa ei koskaan
    // seuraa aito false-lukema, naytetta ei muodostu lainkaan.
    const readings = [
      ...createHeatingSegment("2026-07-01T00:00:00.000Z", 4),
      offTransitionReading("2026-07-01T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-01T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-02T00:00:00.000Z", 4),
      offTransitionReading("2026-07-02T00:00:00.000Z", 42.3),
      recoveryReading("2026-07-02T00:00:00.000Z", 42.2),
      ...createHeatingSegment("2026-07-03T00:00:00.000Z", 4),
      reading(
        new Date(
          new Date("2026-07-03T00:00:00.000Z").getTime() + 35 * 60 * 1000,
        ).toISOString(),
        42.3,
        null,
      ),
    ];
    const estimate = estimateRecoveryDropPerHour(readings);

    assertEqual(
      estimate.sampleCount,
      2,
      "epavarma (null) heating-tila ei kelpaa off-transition-ankkuriksi",
    );
  }
}
