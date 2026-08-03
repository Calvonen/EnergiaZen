#ifndef ENERGIAZEN_SHELLY_HEATING_STATUS_H_
#define ENERGIAZEN_SHELLY_HEATING_STATUS_H_

// Pure, dependency-free tri-state decision over the Shelly relay's ON/OFF
// heating status. Deliberately has zero Arduino/ESP32/WiFi/HTTP includes so
// it can be compiled and unit tested with a plain g++ invocation - see
// tests/shelly_heating_status_test.cpp. There is no PlatformIO/Arduino CLI
// test harness in this repo for the .ino firmware, so keeping this decision
// free of hardware/library types is what makes it testable at all.
//
// Any single failed step on the way to reading the Shelly's status (no
// WiFi, HTTP begin failure, HTTP GET failure, a non-200 response, a JSON
// parse failure, or a missing/non-boolean "output" field) must collapse to
// Unknown, not Off - a status query that could not be answered is not the
// same fact as a relay confirmed off.
enum class ShellyHeatingStatus {
  On,
  Off,
  Unknown,
};

// Every signal readShellyHeatingStatus() gathers on the way to a result.
// Always construct with `= {}` so every field value-initializes to its
// "nothing succeeded yet" default (false / 0) rather than being left
// indeterminate.
struct ShellyStatusSignals {
  bool wifiConnected;
  bool httpBeginOk;
  int httpResponseCode;
  bool jsonParseOk;
  bool outputFieldIsBool;
  bool outputValue;
};

inline ShellyHeatingStatus decideShellyHeatingStatus(
    const ShellyStatusSignals &signals) {
  constexpr int kHttpStatusOk = 200;

  if (!signals.wifiConnected || !signals.httpBeginOk ||
      signals.httpResponseCode <= 0 ||
      signals.httpResponseCode != kHttpStatusOk || !signals.jsonParseOk ||
      !signals.outputFieldIsBool) {
    return ShellyHeatingStatus::Unknown;
  }

  return signals.outputValue ? ShellyHeatingStatus::On
                              : ShellyHeatingStatus::Off;
}

// The exact token written into the "heating" field of the Supabase
// tank_readings JSON payload.
inline const char *shellyHeatingStatusJsonToken(ShellyHeatingStatus status) {
  switch (status) {
    case ShellyHeatingStatus::On:
      return "true";
    case ShellyHeatingStatus::Off:
      return "false";
    case ShellyHeatingStatus::Unknown:
    default:
      return "null";
  }
}

inline const char *shellyHeatingStatusLabel(ShellyHeatingStatus status) {
  switch (status) {
    case ShellyHeatingStatus::On:
      return "ON";
    case ShellyHeatingStatus::Off:
      return "OFF";
    case ShellyHeatingStatus::Unknown:
    default:
      return "UNKNOWN";
  }
}

#endif  // ENERGIAZEN_SHELLY_HEATING_STATUS_H_
