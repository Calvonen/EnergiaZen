import { detectsWaterDraw } from "./waterDrawDetection";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function sample(minutesFromStart: number, inletTemperatureC: number | null) {
  return {
    inletTemperatureC,
    time: minutesFromStart * 60 * 1000,
  };
}

export function runWaterDrawDetectionUnitTests() {
  assertEqual(detectsWaterDraw([]), false, "tyhja lista ei tuota havaintoa");
  assertEqual(
    detectsWaterDraw([sample(0, 15.7)]),
    false,
    "yksittainen lukema ei riita havaintoon",
  );
  assertEqual(
    detectsWaterDraw([sample(0, 15.7), sample(2, 10.7)]),
    true,
    "nopea vahintaan kynnysarvon pudotus ikkunan sisalla havaitaan",
  );
  assertEqual(
    detectsWaterDraw([sample(0, 15.7), sample(2, 10.8)]),
    false,
    "alle kynnysarvon pudotus ei laukea",
  );
  assertEqual(
    detectsWaterDraw([sample(0, 15.7), sample(10, 10.7)]),
    false,
    "yli ikkunan (5 min) tapahtuva pudotus ei laukea",
  );
  assertEqual(
    detectsWaterDraw([sample(0, 10.7), sample(2, 15.7)]),
    false,
    "nousu ei laukea, vain pudotus",
  );
  assertEqual(
    detectsWaterDraw([sample(0, null), sample(2, 12.2), sample(3, null)]),
    false,
    "puuttuvat lukemat eivat itsessaan laukea eivatka riko vertailua",
  );
  assertEqual(
    detectsWaterDraw([sample(0, 15.7), sample(2, 13.0), sample(4, 10.7)]),
    true,
    "vertailu ulottuu koko liukuvan ikkunan yli, ei vain edelliseen lukemaan - " +
      "kumpikaan yksittainen askel (2.7 ja 2.3) ei ylita kynnysta, mutta 0-4 min valinen 5.0 asteen pudotus saavuttaa sen",
  );
}
