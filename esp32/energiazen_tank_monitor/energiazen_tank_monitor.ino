#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <U8g2lib.h>
#include <string.h>
#include <stdio.h>

// EnergyZen standalone ESP32 tank monitor
// Hardware:
// - ESP32 Dev Module
// - 2-3 x DS18B20 on GPIO4 (tank top + bottom, required; inlet, optional)
// - 1.3" SH1106 I2C OLED 128x64, SDA GPIO21, SCL GPIO22
//
// Required Arduino libraries:
// - OneWire
// - DallasTemperature
// - ArduinoJson
// - U8g2
//
// Configure these before flashing:
// - WIFI_SSID
// - WIFI_PASSWORD
// - SUPABASE_KEY
// - TOP_SENSOR_ADDRESS / BOTTOM_SENSOR_ADDRESS / INLET_SENSOR_ADDRESS
//
// Finding sensor ROM addresses:
// Sensors are identified by their unique 64-bit DS18B20 ROM address, not by
// bus scan order, since scan order is not guaranteed to stay stable. To find
// the addresses:
//   1. Flash with the placeholder all-zero addresses below and open the
//      Serial Monitor at 115200 baud. With TOP/BOTTOM unconfigured the
//      device stays in sensor setup mode (see below) and keeps re-printing
//      this list every few seconds.
//   2. The device prints every DS18B20 found on the bus together with its
//      ROM address, its current temperature reading, and the role (if any)
//      it currently matches.
//   3. Identify which physical sensor is which (e.g. warm one finger over a
//      sensor and watch which device's printed temperature changes), then
//      copy each ROM address into the matching TOP_SENSOR_ADDRESS /
//      BOTTOM_SENSOR_ADDRESS / INLET_SENSOR_ADDRESS constant below and
//      reflash.
// TOP and BOTTOM are required and must each have their own distinct ROM
// address. INLET is optional: leave it as all zeros to run without an inlet
// sensor - the device then keeps working normally with just the top/bottom
// readings, and `inlet_temp` is reported as null. If INLET is configured it
// must also be distinct from TOP and BOTTOM.
//
// While TOP_SENSOR_ADDRESS or BOTTOM_SENSOR_ADDRESS is still all zeros, or
// the same ROM address is assigned to more than one role, the device stays
// in a sensor setup mode instead of running normally: it periodically
// re-scans the OneWire bus and prints every discovered ROM address and
// temperature to Serial, shows "ASETUSTILA" on the OLED, and does not send
// anything to Supabase or run the sensor watchdog restart logic.

constexpr uint8_t ONE_WIRE_BUS_PIN = 4;
constexpr uint8_t OLED_SDA_PIN = 21;
constexpr uint8_t OLED_SCL_PIN = 22;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;
constexpr uint8_t DISPLAY_WIDTH_PX = 128;
constexpr unsigned long SENSOR_READ_INTERVAL_MS = 5000;
constexpr unsigned long SUPABASE_SEND_INTERVAL_MS = 60000;
constexpr unsigned long WIFI_RECONNECT_INTERVAL_MS = 30000;
constexpr unsigned long HTTP_TIMEOUT_MS = 10000;
constexpr unsigned long SENSOR_STALE_WARNING_MS = 120000;
constexpr unsigned long SENSOR_REINIT_AFTER_FAILED_READS = 3;
constexpr unsigned long SENSOR_RESTART_AFTER_STALE_MS = 15UL * 60UL * 1000UL;
constexpr unsigned long SENSOR_RESTART_BOOT_GRACE_MS = 5UL * 60UL * 1000UL;
constexpr unsigned long SENSOR_RESTART_COUNTER_RESET_MS = 30UL * 60UL * 1000UL;
constexpr unsigned long SENSOR_UNCHANGED_LOG_MS = 60UL * 60UL * 1000UL;
constexpr unsigned long UPLOAD_RECONNECT_AFTER_STALE_MS = 15UL * 60UL * 1000UL;
constexpr unsigned long UPLOAD_RESTART_AFTER_STALE_MS = 16UL * 60UL * 1000UL;
constexpr unsigned long UPLOAD_RESTART_BOOT_GRACE_MS = 5UL * 60UL * 1000UL;
constexpr unsigned long UPLOAD_RESTART_COUNTER_RESET_MS = 30UL * 60UL * 1000UL;
constexpr uint8_t MAX_SENSOR_WATCHDOG_RESTARTS = 3;
constexpr uint8_t MAX_UPLOAD_WATCHDOG_RESTARTS = 3;
constexpr float MIN_TANK_TEMPERATURE_C = 20.0;
constexpr float MAX_TANK_TEMPERATURE_C = 80.0;
constexpr float MIN_VALID_SENSOR_TEMPERATURE_C = 0.0;
constexpr float MAX_VALID_SENSOR_TEMPERATURE_C = 95.0;
constexpr float DS18B20_POWER_ON_TEMPERATURE_C = 85.0;
constexpr float SHOWERS_AT_MAX_TEMPERATURE = 6.0;

const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SUPABASE_KEY = "YOUR_SUPABASE_ANON_KEY";
const char *SUPABASE_ENDPOINT =
    "https://amyvzelzbvjvrevikvrp.supabase.co/rest/v1/tank_readings";
// Shelly RPC channels: id=0 is the actual water-heater channel; id=1 is the
// test channel.
const char *SHELLY_STATUS_ENDPOINT =
    "http://192.168.68.52/rpc/Switch.GetStatus?id=0";

// DS18B20 ROM addresses, see the "Finding sensor ROM addresses" note above.
// Measured on the real device: TOP ~62.8 C, BOTTOM ~46.5 C, INLET ~16.0 C.
DeviceAddress TOP_SENSOR_ADDRESS = {0x28, 0x70, 0x63, 0x22, 0x00, 0x00, 0x00, 0xAE};
DeviceAddress BOTTOM_SENSOR_ADDRESS = {0x28, 0x34, 0xF4, 0x22, 0x00, 0x00, 0x00, 0xE1};
DeviceAddress INLET_SENSOR_ADDRESS = {0x28, 0xD2, 0xBA, 0xC8, 0x00, 0x00, 0x00, 0x63};

OneWire oneWire(ONE_WIRE_BUS_PIN);
DallasTemperature sensors(&oneWire);
U8G2_SH1106_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE);

float topTemperatureC = NAN;
float bottomTemperatureC = NAN;
float inletTemperatureC = NAN;
float showersLeft = 0.0;
bool inletSensorConfigured = false;
bool requiredSensorsConfigured = false;
unsigned long previousSensorReadMs = 0;
unsigned long previousSupabaseSendMs = 0;
unsigned long previousWiFiReconnectAttemptMs = 0;
unsigned long lastSuccessfulSensorReadMillis = 0;
unsigned long lastSuccessfulUploadMillis = 0;
unsigned long lastSensorValueChangeMillis = 0;
unsigned long lastUploadRecoveryAttemptMillis = 0;
unsigned long lastWiFiStatusLogMillis = 0;
unsigned long sensorHealthySinceMillis = 0;
unsigned long uploadHealthySinceMillis = 0;
unsigned long startupMillis = 0;
uint32_t acceptedSensorReadingSequence = 0;
uint32_t lastUploadedSensorReadingSequence = 0;
uint8_t consecutiveSensorReadFailures = 0;
bool sensorDataStale = true;
bool uploadRecoveryAttempted = false;
wl_status_t previousLoggedWiFiStatus = WL_IDLE_STATUS;

RTC_DATA_ATTR uint8_t sensorWatchdogRestartCount = 0;
RTC_DATA_ATTR uint8_t uploadWatchdogRestartCount = 0;

float clampFloat(float value, float minimum, float maximum) {
  if (value < minimum) {
    return minimum;
  }

  if (value > maximum) {
    return maximum;
  }

  return value;
}

bool isValidTemperature(float temperatureC) {
  return temperatureC != DEVICE_DISCONNECTED_C && !isnan(temperatureC) &&
         temperatureC != DS18B20_POWER_ON_TEMPERATURE_C &&
         temperatureC >= MIN_VALID_SENSOR_TEMPERATURE_C &&
         temperatureC <= MAX_VALID_SENSOR_TEMPERATURE_C;
}

String invalidTemperatureReason(float temperatureC) {
  if (isnan(temperatureC)) {
    return "NaN";
  }

  if (temperatureC == DEVICE_DISCONNECTED_C || temperatureC <= -126.0) {
    return "DS18B20 disconnected";
  }

  if (temperatureC == DS18B20_POWER_ON_TEMPERATURE_C) {
    return "DS18B20 85C power-on value";
  }

  if (temperatureC < MIN_VALID_SENSOR_TEMPERATURE_C) {
    return "below tank range";
  }

  if (temperatureC > MAX_VALID_SENSOR_TEMPERATURE_C) {
    return "above tank range";
  }

  return "unknown";
}

bool isAddressConfigured(const DeviceAddress address) {
  for (uint8_t i = 0; i < 8; i++) {
    if (address[i] != 0x00) {
      return true;
    }
  }

  return false;
}

void printDeviceAddress(const DeviceAddress address) {
  for (uint8_t i = 0; i < 8; i++) {
    if (address[i] < 0x10) {
      Serial.print("0");
    }
    Serial.print(address[i], HEX);
  }
}

const char *sensorRoleForAddress(const DeviceAddress address) {
  if (memcmp(address, TOP_SENSOR_ADDRESS, sizeof(DeviceAddress)) == 0) {
    return "TOP";
  }
  if (memcmp(address, BOTTOM_SENSOR_ADDRESS, sizeof(DeviceAddress)) == 0) {
    return "BOTTOM";
  }
  if (inletSensorConfigured &&
      memcmp(address, INLET_SENSOR_ADDRESS, sizeof(DeviceAddress)) == 0) {
    return "INLET";
  }

  return "UNASSIGNED";
}

bool addressesEqual(const DeviceAddress a, const DeviceAddress b) {
  return memcmp(a, b, sizeof(DeviceAddress)) == 0;
}

// True when both addresses are individually configured (non-zero) and equal
// to each other - i.e. the same physical sensor is assigned to two roles.
// Two unconfigured (all-zero) placeholder addresses are never a conflict.
bool addressesConflict(const DeviceAddress a, bool aConfigured,
                        const DeviceAddress b, bool bConfigured) {
  return aConfigured && bConfigured && addressesEqual(a, b);
}

// Pure check over the configured TOP/BOTTOM/INLET ROM addresses: returns
// false as soon as any two configured roles share the same ROM address.
// Kept separate from logDiscoveredSensors() so the role-assignment rule can
// be reasoned about (or unit tested, given a suitable harness) on its own.
bool sensorRoleAddressesAreUnique() {
  const bool topConfigured = isAddressConfigured(TOP_SENSOR_ADDRESS);
  const bool bottomConfigured = isAddressConfigured(BOTTOM_SENSOR_ADDRESS);

  if (addressesConflict(TOP_SENSOR_ADDRESS, topConfigured,
                         BOTTOM_SENSOR_ADDRESS, bottomConfigured)) {
    return false;
  }
  if (addressesConflict(TOP_SENSOR_ADDRESS, topConfigured,
                         INLET_SENSOR_ADDRESS, inletSensorConfigured)) {
    return false;
  }
  if (addressesConflict(BOTTOM_SENSOR_ADDRESS, bottomConfigured,
                         INLET_SENSOR_ADDRESS, inletSensorConfigured)) {
    return false;
  }

  return true;
}

void logDiscoveredSensors() {
  // Read live temperatures too (not just ROM addresses) so a sensor can be
  // identified by warming it with a finger while watching this log, even
  // while the device is in setup mode and readTemperatures() isn't running.
  sensors.requestTemperatures();

  const uint8_t deviceCount = sensors.getDeviceCount();
  Serial.print("DS18B20 devices found on bus: ");
  Serial.println(deviceCount);

  bool topFound = false;
  bool bottomFound = false;
  bool inletFound = false;

  for (uint8_t i = 0; i < deviceCount; i++) {
    DeviceAddress address;
    if (!sensors.getAddress(address, i)) {
      Serial.print("  Device ");
      Serial.print(i);
      Serial.println(": failed to read ROM address");
      continue;
    }

    const char *role = sensorRoleForAddress(address);
    if (strcmp(role, "TOP") == 0) {
      topFound = true;
    } else if (strcmp(role, "BOTTOM") == 0) {
      bottomFound = true;
    } else if (strcmp(role, "INLET") == 0) {
      inletFound = true;
    }

    const float temperatureC = sensors.getTempC(address);

    Serial.print("  Device ");
    Serial.print(i);
    Serial.print(" ROM=");
    printDeviceAddress(address);
    Serial.print(" temp=");
    if (isValidTemperature(temperatureC)) {
      Serial.print(temperatureC, 4);
      Serial.print(" C");
    } else {
      Serial.print(invalidTemperatureReason(temperatureC));
    }
    Serial.print(" role=");
    Serial.println(role);
  }

  Serial.print("Configured TOP_SENSOR_ADDRESS=");
  printDeviceAddress(TOP_SENSOR_ADDRESS);
  Serial.println(topFound ? " (found on bus)" : " (NOT found on bus)");

  Serial.print("Configured BOTTOM_SENSOR_ADDRESS=");
  printDeviceAddress(BOTTOM_SENSOR_ADDRESS);
  Serial.println(bottomFound ? " (found on bus)" : " (NOT found on bus)");

  if (inletSensorConfigured) {
    Serial.print("Configured INLET_SENSOR_ADDRESS=");
    printDeviceAddress(INLET_SENSOR_ADDRESS);
    Serial.println(inletFound ? " (found on bus)" : " (NOT found on bus)");
  } else {
    Serial.println(
        "INLET_SENSOR_ADDRESS not configured; inlet sensor disabled (optional)");
  }

  if (!isAddressConfigured(TOP_SENSOR_ADDRESS) ||
      !isAddressConfigured(BOTTOM_SENSOR_ADDRESS)) {
    Serial.println(
        "ERROR: TOP_SENSOR_ADDRESS/BOTTOM_SENSOR_ADDRESS not configured - "
        "copy the ROM addresses above into the .ino and reflash. Staying in "
        "sensor setup mode: no readings will be sent to Supabase.");
  } else if (!sensorRoleAddressesAreUnique()) {
    Serial.println(
        "ERROR: the same ROM address is assigned to more than one of "
        "TOP_SENSOR_ADDRESS/BOTTOM_SENSOR_ADDRESS/INLET_SENSOR_ADDRESS - "
        "each role needs its own distinct ROM address. Staying in sensor "
        "setup mode: no readings will be sent to Supabase.");
  } else {
    if (!topFound) {
      Serial.println("WARNING: configured TOP sensor not found on bus");
    }
    if (!bottomFound) {
      Serial.println("WARNING: configured BOTTOM sensor not found on bus");
    }
  }
  if (inletSensorConfigured && !inletFound) {
    Serial.println("WARNING: configured INLET sensor not found on bus");
  }
}

float calculateShowersLeft(float topC, float bottomC) {
  if (!isValidTemperature(topC) || !isValidTemperature(bottomC)) {
    return 0.0;
  }

  const float averageTankTemperatureC = (topC + bottomC) / 2.0;
  const float fillRatio =
      (averageTankTemperatureC - MIN_TANK_TEMPERATURE_C) /
      (MAX_TANK_TEMPERATURE_C - MIN_TANK_TEMPERATURE_C);

  return clampFloat(fillRatio, 0.0, 1.0) * SHOWERS_AT_MAX_TEMPERATURE;
}

void logElapsed(const char *label, unsigned long sinceMillis,
                unsigned long currentMs) {
  Serial.print(label);
  if (sinceMillis == 0) {
    Serial.println("never");
    return;
  }

  Serial.print((currentMs - sinceMillis) / 1000);
  Serial.println(" s");
}

void initializeTemperatureBus(const char *reason) {
  Serial.print("Reinitializing OneWire/DallasTemperature: ");
  Serial.println(reason);
  oneWire.reset();
  sensors.begin();
  sensors.setResolution(12);
}

void resetWatchdogCountersAfterStableRun(unsigned long currentMs) {
  if (sensorWatchdogRestartCount > 0 &&
      sensorHealthySinceMillis > 0 &&
      currentMs - sensorHealthySinceMillis >=
          SENSOR_RESTART_COUNTER_RESET_MS) {
    sensorWatchdogRestartCount = 0;
    Serial.println("Sensor watchdog restart count reset after stable readings");
  }

  if (uploadWatchdogRestartCount > 0 &&
      uploadHealthySinceMillis > 0 &&
      currentMs - uploadHealthySinceMillis >=
          UPLOAD_RESTART_COUNTER_RESET_MS) {
    uploadWatchdogRestartCount = 0;
    Serial.println("Upload watchdog restart count reset after stable uploads");
  }
}

bool readTemperatures(unsigned long currentMs) {
  sensors.requestTemperatures();

  const float rawTopTemperatureC = sensors.getTempC(TOP_SENSOR_ADDRESS);
  const float rawBottomTemperatureC = sensors.getTempC(BOTTOM_SENSOR_ADDRESS);
  const float rawInletTemperatureC =
      inletSensorConfigured ? sensors.getTempC(INLET_SENSOR_ADDRESS) : NAN;

  Serial.print("Sensor raw top/bottom/inlet: ");
  Serial.print(rawTopTemperatureC, 4);
  Serial.print(" / ");
  Serial.print(rawBottomTemperatureC, 4);
  Serial.print(" / ");
  if (inletSensorConfigured) {
    Serial.println(rawInletTemperatureC, 4);
  } else {
    Serial.println("not configured");
  }

  // The inlet sensor is optional and tracked independently of the top/bottom
  // health bookkeeping below, so a missing or failing inlet sensor never
  // affects the required top/bottom readings.
  if (inletSensorConfigured) {
    if (isValidTemperature(rawInletTemperatureC)) {
      inletTemperatureC = rawInletTemperatureC;
    } else {
      inletTemperatureC = NAN;
      Serial.print("Inlet sensor reading rejected: ");
      Serial.println(invalidTemperatureReason(rawInletTemperatureC));
    }
  }

  // The upper and lower tank sensors are identified by their configured ROM
  // addresses above, not by bus scan order.
  const bool topValid = isValidTemperature(rawTopTemperatureC);
  const bool bottomValid = isValidTemperature(rawBottomTemperatureC);

  if (!topValid || !bottomValid) {
    consecutiveSensorReadFailures++;
    sensorDataStale = true;
    sensorHealthySinceMillis = 0;

    Serial.print("Rejected sensor reading: ");
    if (!topValid) {
      Serial.print("top=");
      Serial.print(invalidTemperatureReason(rawTopTemperatureC));
      Serial.print(" ");
    }
    if (!bottomValid) {
      Serial.print("bottom=");
      Serial.print(invalidTemperatureReason(rawBottomTemperatureC));
    }
    Serial.println();
    Serial.print("Consecutive sensor read failures: ");
    Serial.println(consecutiveSensorReadFailures);
    logElapsed("Time since successful sensor read: ",
               lastSuccessfulSensorReadMillis, currentMs);

    if (consecutiveSensorReadFailures >= SENSOR_REINIT_AFTER_FAILED_READS) {
      initializeTemperatureBus("consecutive invalid readings");
      consecutiveSensorReadFailures = 0;
    }

    return false;
  }

  if (isValidTemperature(topTemperatureC) &&
      isValidTemperature(bottomTemperatureC) &&
      rawTopTemperatureC == topTemperatureC &&
      rawBottomTemperatureC == bottomTemperatureC &&
      lastSensorValueChangeMillis > 0 &&
      currentMs - lastSensorValueChangeMillis >= SENSOR_UNCHANGED_LOG_MS) {
    Serial.println(
        "Sensor values unchanged for 60 minutes; not treated as failure alone");
    lastSensorValueChangeMillis = currentMs;
  } else if (rawTopTemperatureC != topTemperatureC ||
             rawBottomTemperatureC != bottomTemperatureC) {
    lastSensorValueChangeMillis = currentMs;
  }

  topTemperatureC = rawTopTemperatureC;
  bottomTemperatureC = rawBottomTemperatureC;
  showersLeft = calculateShowersLeft(topTemperatureC, bottomTemperatureC);

  consecutiveSensorReadFailures = 0;
  if (sensorHealthySinceMillis == 0) {
    sensorHealthySinceMillis = currentMs;
  }
  sensorDataStale = false;
  lastSuccessfulSensorReadMillis = currentMs;
  acceptedSensorReadingSequence++;

  Serial.println("Accepted sensor reading");
  Serial.print("Accepted sensor reading sequence: ");
  Serial.println(acceptedSensorReadingSequence);
  logElapsed("Time since successful sensor read: ",
             lastSuccessfulSensorReadMillis, currentMs);
  return true;
}

void maintainWiFi(unsigned long currentMs, bool forceReconnect = false) {
  const wl_status_t status = WiFi.status();
  if (forceReconnect || status != previousLoggedWiFiStatus ||
      currentMs - lastWiFiStatusLogMillis >= WIFI_RECONNECT_INTERVAL_MS) {
    Serial.print("WiFi status: ");
    Serial.println(status);
    previousLoggedWiFiStatus = status;
    lastWiFiStatusLogMillis = currentMs;
  }

  if (status == WL_CONNECTED && !forceReconnect) {
    return;
  }

  if (!forceReconnect &&
      currentMs - previousWiFiReconnectAttemptMs < WIFI_RECONNECT_INTERVAL_MS) {
    return;
  }

  previousWiFiReconnectAttemptMs = currentMs;
  WiFi.mode(WIFI_STA);

  if (forceReconnect) {
    Serial.println("Forcing WiFi disconnect/reconnect");
    WiFi.disconnect();
    delay(100);
  }

  Serial.println("Starting WiFi reconnect");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

String jsonTemperatureValue(float temperatureC) {
  if (!isValidTemperature(temperatureC)) {
    return "null";
  }

  return String(temperatureC, 1);
}

bool readShellyHeatingStatus() {
  bool heating = false;

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Shelly status skipped: WiFi disconnected");
    Serial.println("Shelly heating channel: OFF");
    return false;
  }

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, SHELLY_STATUS_ENDPOINT)) {
    Serial.println("Warning: Shelly HTTP begin failed");
    Serial.println("Shelly heating channel: OFF");
    return false;
  }
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);

  const int responseCode = http.GET();
  Serial.print("Shelly HTTP response code: ");
  Serial.println(responseCode);

  if (responseCode <= 0) {
    Serial.print("Warning: Shelly HTTP GET failed: ");
    Serial.println(responseCode);
  } else if (responseCode != HTTP_CODE_OK) {
    Serial.print("Warning: Shelly unexpected HTTP response: ");
    Serial.println(responseCode);
  } else {
    const String response = http.getString();
    JsonDocument doc;
    const DeserializationError error = deserializeJson(doc, response);

    if (error) {
      Serial.print("Warning: Shelly JSON parse failed: ");
      Serial.println(error.c_str());
    } else if (!doc["output"].is<bool>()) {
      Serial.println("Warning: Shelly JSON missing boolean output field");
    } else {
      heating = doc["output"].as<bool>();
    }
  }

  http.end();

  Serial.print("Shelly heating channel: ");
  Serial.println(heating ? "ON" : "OFF");
  return heating;
}

bool sendSupabaseReading(unsigned long currentMs) {
  maintainWiFi(currentMs);

  const bool hasAcceptedSensorReading = lastSuccessfulSensorReadMillis > 0;
  const unsigned long sensorReadingAgeMs =
      hasAcceptedSensorReading ? currentMs - lastSuccessfulSensorReadMillis : 0;
  Serial.print("Accepted sensor reading sequence: ");
  Serial.println(acceptedSensorReadingSequence);
  Serial.print("Last uploaded sensor reading sequence: ");
  Serial.println(lastUploadedSensorReadingSequence);
  Serial.print("Accepted sensor reading age: ");
  if (!hasAcceptedSensorReading) {
    Serial.println("never");
  } else {
    Serial.print(sensorReadingAgeMs / 1000);
    Serial.println(" s");
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Supabase send skipped: WiFi disconnected");
    uploadHealthySinceMillis = 0;
    return false;
  }

  if (sensorDataStale) {
    Serial.println("Supabase send skipped: sensor data marked stale");
    return false;
  }

  if (!hasAcceptedSensorReading) {
    Serial.println("Supabase send skipped: no accepted sensor reading yet");
    return false;
  }

  if (acceptedSensorReadingSequence == lastUploadedSensorReadingSequence) {
    Serial.println(
        "Supabase send skipped: accepted sensor reading already uploaded");
    return false;
  }

  if (sensorReadingAgeMs > 2 * SENSOR_READ_INTERVAL_MS) {
    Serial.println("Supabase send skipped: accepted sensor reading too old");
    return false;
  }

  const bool heating = readShellyHeatingStatus();

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, SUPABASE_ENDPOINT)) {
    Serial.println("Supabase HTTP begin failed");
    uploadHealthySinceMillis = 0;
    return false;
  }
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);

  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Prefer", "return=minimal");

  const String payload =
      String("{\"top_temp\":") + jsonTemperatureValue(topTemperatureC) +
      ",\"bottom_temp\":" + jsonTemperatureValue(bottomTemperatureC) +
      ",\"inlet_temp\":" + jsonTemperatureValue(inletTemperatureC) +
      ",\"showers\":" + String(showersLeft, 1) +
      ",\"heating\":" + (heating ? "true" : "false") + "}";

  const int responseCode = http.POST(payload);
  const String response = responseCode > 0 ? http.getString() : "";
  Serial.print("Supabase HTTP status: ");
  Serial.println(responseCode);
  Serial.print("Supabase response: ");
  Serial.println(response);

  if (responseCode >= 200 && responseCode < 300) {
    lastSuccessfulUploadMillis = currentMs;
    lastUploadedSensorReadingSequence = acceptedSensorReadingSequence;
    if (uploadHealthySinceMillis == 0) {
      uploadHealthySinceMillis = currentMs;
    }
    uploadRecoveryAttempted = false;
    Serial.println("Supabase insert accepted");
    Serial.print("Last uploaded sensor reading sequence: ");
    Serial.println(lastUploadedSensorReadingSequence);
  } else {
    uploadHealthySinceMillis = 0;
    Serial.println("Supabase insert failed");
  }
  logElapsed("Time since successful Supabase upload: ",
             lastSuccessfulUploadMillis, currentMs);

  http.end();
  return responseCode >= 200 && responseCode < 300;
}

// u8g2_font_helvB08/10/12_tf all include the full ISO8859-1 (Latin-1) glyph
// range, which covers both "ä" (U+00E4) and the degree sign "°" (U+00B0) -
// verified against the rendered glyph tables at
// https://github.com/olikraus/u8g2/wiki/fntgrpadobex11 before using them
// here, rather than assuming support or silently falling back to ASCII.
void formatTemperatureLine(char *buffer, size_t bufferSize, const char *label,
                            float temperatureC) {
  if (isValidTemperature(temperatureC)) {
    snprintf(buffer, bufferSize, "%s %.1f °C", label, temperatureC);
  } else {
    snprintf(buffer, bufferSize, "%s --.- °C", label);
  }
}

// Applies the first font (in preference order) under which every line in
// `lines` fits within DISPLAY_WIDTH_PX, so a set of lines meant to share one
// look never gets individually clipped on the OLED's right edge. Falls back
// to the last (smallest) font in the list if none fit, and logs exactly
// which line(s) are still too wide so a mis-sized string is caught here
// instead of silently clipping on the display.
void applyFittingFont(const char *const *lines, uint8_t lineCount,
                       const uint8_t *const *fontsByPreference,
                       uint8_t fontCount) {
  for (uint8_t f = 0; f < fontCount; f++) {
    display.setFont(fontsByPreference[f]);

    bool allLinesFit = true;
    for (uint8_t i = 0; i < lineCount; i++) {
      if (display.getUTF8Width(lines[i]) > DISPLAY_WIDTH_PX) {
        allLinesFit = false;
        break;
      }
    }

    const bool isSmallestFont = f == fontCount - 1;
    if (allLinesFit || isSmallestFont) {
      if (!allLinesFit) {
        for (uint8_t i = 0; i < lineCount; i++) {
          if (display.getUTF8Width(lines[i]) > DISPLAY_WIDTH_PX) {
            Serial.print(
                "WARNING: OLED line does not fit even at the smallest "
                "configured font and will be clipped: ");
            Serial.println(lines[i]);
          }
        }
      }
      return;
    }
  }
}

const uint8_t *const TEMPERATURE_LINE_FONTS[] = {u8g2_font_helvB12_tf,
                                                  u8g2_font_helvB10_tf,
                                                  u8g2_font_helvB08_tf};
const uint8_t *const SETUP_LINE_FONTS[] = {u8g2_font_helvB10_tf,
                                            u8g2_font_helvB08_tf};

void updateDisplay() {
  display.clearBuffer();

  display.setFont(u8g2_font_helvB10_tf);
  display.setCursor(0, 9);
  display.print("EnergyZen");

  char topLine[24];
  char bottomLine[24];
  char inletLine[24];
  formatTemperatureLine(topLine, sizeof(topLine), "Ylä", topTemperatureC);
  formatTemperatureLine(bottomLine, sizeof(bottomLine), "Ala",
                         bottomTemperatureC);
  formatTemperatureLine(inletLine, sizeof(inletLine), "Tulo",
                         inletTemperatureC);

  const char *temperatureLines[] = {topLine, bottomLine, inletLine};
  applyFittingFont(temperatureLines, 3, TEMPERATURE_LINE_FONTS,
                    sizeof(TEMPERATURE_LINE_FONTS) /
                        sizeof(TEMPERATURE_LINE_FONTS[0]));

  display.setCursor(0, 24);
  display.print(topLine);

  display.setCursor(0, 39);
  display.print(bottomLine);

  display.setCursor(0, 54);
  display.print(inletLine);

  if (sensorDataStale &&
      (lastSuccessfulSensorReadMillis == 0 ||
       millis() - lastSuccessfulSensorReadMillis >= SENSOR_STALE_WARNING_MS)) {
    display.setFont(u8g2_font_5x7_tf);
    display.setCursor(96, 10);
    display.print("STALE");
  }

  display.sendBuffer();
}

void updateSetupDisplay() {
  display.clearBuffer();

  display.setFont(u8g2_font_helvB10_tf);
  display.setCursor(0, 9);
  display.print("EnergyZen");

  char sensorsLine[24];
  snprintf(sensorsLine, sizeof(sensorsLine), "Antureita: %u",
           static_cast<unsigned>(sensors.getDeviceCount()));

  const char *setupLines[] = {"ASETUSTILA", sensorsLine,
                               "Sarjaportti 115200"};
  applyFittingFont(setupLines, 3, SETUP_LINE_FONTS,
                    sizeof(SETUP_LINE_FONTS) / sizeof(SETUP_LINE_FONTS[0]));

  display.setCursor(0, 28);
  display.print(setupLines[0]);

  display.setCursor(0, 44);
  display.print(setupLines[1]);

  display.setCursor(0, 58);
  display.print(setupLines[2]);

  display.sendBuffer();
}

void checkSensorWatchdog(unsigned long currentMs) {
  const unsigned long sensorWatchdogBaseMs =
      lastSuccessfulSensorReadMillis > 0 ? lastSuccessfulSensorReadMillis
                                         : startupMillis;
  const unsigned long sensorStaleMs = currentMs - sensorWatchdogBaseMs;
  if (sensorStaleMs < SENSOR_RESTART_AFTER_STALE_MS) {
    return;
  }

  initializeTemperatureBus("sensor watchdog stale timeout");

  if (millis() < SENSOR_RESTART_BOOT_GRACE_MS) {
    Serial.println("Sensor watchdog restart delayed by boot grace period");
    return;
  }

  if (sensorWatchdogRestartCount >= MAX_SENSOR_WATCHDOG_RESTARTS) {
    Serial.println("Sensor watchdog restart suppressed: restart limit reached");
    return;
  }

  sensorWatchdogRestartCount++;
  Serial.print("ESP.restart reason: no successful sensor read for ");
  Serial.print(sensorStaleMs / 1000);
  Serial.print(" s after bus reinitialization, restart count ");
  Serial.println(sensorWatchdogRestartCount);
  ESP.restart();
}

void checkUploadWatchdog(unsigned long currentMs) {
  const unsigned long uploadWatchdogBaseMs =
      lastSuccessfulUploadMillis > 0 ? lastSuccessfulUploadMillis
                                     : startupMillis;
  const unsigned long uploadStaleMs = currentMs - uploadWatchdogBaseMs;

  if (currentMs - startupMillis < UPLOAD_RESTART_BOOT_GRACE_MS) {
    return;
  }

  if (uploadStaleMs >= UPLOAD_RECONNECT_AFTER_STALE_MS &&
      !uploadRecoveryAttempted) {
    Serial.print("Upload stale for ");
    Serial.print(uploadStaleMs / 1000);
    Serial.println(" s; trying WiFi reconnect before restart");
    maintainWiFi(currentMs, true);
    uploadRecoveryAttempted = true;
    lastUploadRecoveryAttemptMillis = currentMs;
    return;
  }

  if (uploadRecoveryAttempted &&
      uploadStaleMs >= UPLOAD_RESTART_AFTER_STALE_MS &&
      currentMs - lastUploadRecoveryAttemptMillis >= HTTP_TIMEOUT_MS) {
    if (uploadWatchdogRestartCount >= MAX_UPLOAD_WATCHDOG_RESTARTS) {
      Serial.println("Upload watchdog restart suppressed: restart limit reached");
      return;
    }

    uploadWatchdogRestartCount++;
    Serial.print("ESP.restart reason: no successful Supabase upload for ");
    Serial.print(uploadStaleMs / 1000);
    Serial.print(" s after WiFi reconnect, restart count ");
    Serial.println(uploadWatchdogRestartCount);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(115200);
  startupMillis = millis();

  sensors.begin();
  sensors.setResolution(12);

  inletSensorConfigured = isAddressConfigured(INLET_SENSOR_ADDRESS);
  requiredSensorsConfigured = isAddressConfigured(TOP_SENSOR_ADDRESS) &&
                               isAddressConfigured(BOTTOM_SENSOR_ADDRESS) &&
                               sensorRoleAddressesAreUnique();
  logDiscoveredSensors();

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  display.setI2CAddress(OLED_I2C_ADDRESS << 1);
  display.begin();
  display.clearBuffer();
  display.sendBuffer();

  maintainWiFi(millis(), true);

  if (requiredSensorsConfigured) {
    readTemperatures(millis());
    updateDisplay();
  } else {
    updateSetupDisplay();
  }
  previousSupabaseSendMs = millis();
}

// TOP_SENSOR_ADDRESS/BOTTOM_SENSOR_ADDRESS are required and, together with
// an optionally configured INLET_SENSOR_ADDRESS, must all be distinct (see
// sensorRoleAddressesAreUnique()). Until that holds, the device stays in
// this setup mode instead of running the normal read/upload/watchdog cycle:
// it never sends readings to Supabase (top_temp/bottom_temp would only ever
// be null, or a role address could collide with another) and never triggers
// a sensor watchdog restart over a configuration problem a reboot can't fix.
// It periodically re-scans the bus so newly attached sensors show up
// without a reflash.
void runSensorSetupMode(unsigned long currentMs) {
  if (currentMs - previousSensorReadMs >= SENSOR_READ_INTERVAL_MS) {
    previousSensorReadMs = currentMs;
    initializeTemperatureBus("periodic sensor setup mode scan");
    logDiscoveredSensors();
    updateSetupDisplay();
  }

  maintainWiFi(currentMs);
}

void loop() {
  const unsigned long currentMs = millis();

  if (!requiredSensorsConfigured) {
    runSensorSetupMode(currentMs);
    return;
  }

  if (currentMs - previousSensorReadMs >= SENSOR_READ_INTERVAL_MS) {
    previousSensorReadMs = currentMs;
    readTemperatures(currentMs);
    updateDisplay();
    checkSensorWatchdog(currentMs);
  }

  if (currentMs - previousSupabaseSendMs >= SUPABASE_SEND_INTERVAL_MS) {
    previousSupabaseSendMs = currentMs;
    sendSupabaseReading(currentMs);
    checkUploadWatchdog(currentMs);
  }

  maintainWiFi(currentMs);
  resetWatchdogCountersAfterStableRun(currentMs);
}
