// Plain g++ unit test for shelly_heating_status.h - no PlatformIO/Arduino
// CLI harness exists for this firmware, so this is compiled and run
// directly instead. From the repo root:
//
//   g++ -std=c++17 -Wall -Wextra -o /tmp/shelly_heating_status_test
//   esp32/energiazen_tank_monitor/tests/shelly_heating_status_test.cpp
//   && /tmp/shelly_heating_status_test

#include "../shelly_heating_status.h"

#include <cstdio>
#include <cstring>

namespace {

int failureCount = 0;

void assertStatusEqual(ShellyHeatingStatus actual, ShellyHeatingStatus expected,
                        const char *message) {
  if (actual != expected) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    failureCount++;
  }
}

void assertStringEqual(const char *actual, const char *expected,
                        const char *message) {
  if (std::strcmp(actual, expected) != 0) {
    std::fprintf(stderr, "FAIL: %s: expected \"%s\", got \"%s\"\n", message,
                 expected, actual);
    failureCount++;
  }
}

// All signals green, with the given relay output - the only shape that may
// ever resolve to On or Off; every other test below flips exactly one
// signal away from this baseline to Unknown.
ShellyStatusSignals okSignals(bool outputValue) {
  ShellyStatusSignals signals = {};
  signals.wifiConnected = true;
  signals.httpBeginOk = true;
  signals.httpResponseCode = 200;
  signals.jsonParseOk = true;
  signals.outputFieldIsBool = true;
  signals.outputValue = outputValue;
  return signals;
}

}  // namespace

int main() {
  assertStatusEqual(decideShellyHeatingStatus(okSignals(true)),
                     ShellyHeatingStatus::On, "kaikki signaalit kunnossa, output=true -> On");
  assertStatusEqual(decideShellyHeatingStatus(okSignals(false)),
                     ShellyHeatingStatus::Off,
                     "kaikki signaalit kunnossa, output=false -> Off");

  {
    ShellyStatusSignals signals = okSignals(true);
    signals.wifiConnected = false;
    assertStatusEqual(
        decideShellyHeatingStatus(signals), ShellyHeatingStatus::Unknown,
        "WiFi ei yhdistetty -> Unknown, vaikka output olisi ollut true");
  }
  {
    ShellyStatusSignals signals = okSignals(true);
    signals.httpBeginOk = false;
    assertStatusEqual(decideShellyHeatingStatus(signals),
                       ShellyHeatingStatus::Unknown,
                       "http.begin epaonnistui -> Unknown");
  }
  {
    ShellyStatusSignals signals = okSignals(true);
    signals.httpResponseCode = -1;
    assertStatusEqual(
        decideShellyHeatingStatus(signals), ShellyHeatingStatus::Unknown,
        "negatiivinen vastauskoodi (GET epaonnistui) -> Unknown");
  }
  {
    ShellyStatusSignals signals = okSignals(true);
    signals.httpResponseCode = 0;
    assertStatusEqual(decideShellyHeatingStatus(signals),
                       ShellyHeatingStatus::Unknown,
                       "nollavastauskoodi -> Unknown");
  }
  {
    ShellyStatusSignals signals = okSignals(true);
    signals.httpResponseCode = 500;
    assertStatusEqual(decideShellyHeatingStatus(signals),
                       ShellyHeatingStatus::Unknown,
                       "muu kuin 200-vastauskoodi -> Unknown");
  }
  {
    ShellyStatusSignals signals = okSignals(true);
    signals.jsonParseOk = false;
    assertStatusEqual(decideShellyHeatingStatus(signals),
                       ShellyHeatingStatus::Unknown,
                       "JSON-jasennys epaonnistui -> Unknown");
  }
  {
    ShellyStatusSignals signals = okSignals(true);
    signals.outputFieldIsBool = false;
    assertStatusEqual(
        decideShellyHeatingStatus(signals), ShellyHeatingStatus::Unknown,
        "puuttuva tai ei-boolean output-kentta -> Unknown");
  }

  assertStringEqual(shellyHeatingStatusJsonToken(ShellyHeatingStatus::On),
                     "true", "On -> JSON-token \"true\"");
  assertStringEqual(shellyHeatingStatusJsonToken(ShellyHeatingStatus::Off),
                     "false", "Off -> JSON-token \"false\"");
  assertStringEqual(
      shellyHeatingStatusJsonToken(ShellyHeatingStatus::Unknown), "null",
      "Unknown -> JSON-token \"null\", ei koskaan \"false\"");

  assertStringEqual(shellyHeatingStatusLabel(ShellyHeatingStatus::On), "ON",
                     "On -> Serial-tunniste \"ON\"");
  assertStringEqual(shellyHeatingStatusLabel(ShellyHeatingStatus::Off), "OFF",
                     "Off -> Serial-tunniste \"OFF\"");
  assertStringEqual(shellyHeatingStatusLabel(ShellyHeatingStatus::Unknown),
                     "UNKNOWN", "Unknown -> Serial-tunniste \"UNKNOWN\"");

  if (failureCount > 0) {
    std::fprintf(stderr, "%d testi(a) epaonnistui\n", failureCount);
    return 1;
  }

  std::printf("shellyHeatingStatus: kaikki testit lapaisty\n");
  return 0;
}
