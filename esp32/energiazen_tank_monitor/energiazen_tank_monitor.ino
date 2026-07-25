#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <U8g2lib.h>

// EnergyZen standalone ESP32 tank monitor
// Hardware:
// - ESP32 Dev Module
// - 2 x DS18B20 on GPIO4
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

constexpr uint8_t ONE_WIRE_BUS_PIN = 4;
constexpr uint8_t OLED_SDA_PIN = 21;
constexpr uint8_t OLED_SCL_PIN = 22;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;
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

OneWire oneWire(ONE_WIRE_BUS_PIN);
DallasTemperature sensors(&oneWire);
U8G2_SH1106_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE);

float topTemperatureC = NAN;
float bottomTemperatureC = NAN;
float showersLeft = 0.0;
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

  // The first discovered DS18B20 is shown as the upper tank sensor and the
  // second as the lower tank sensor. Swap the physical connectors if needed.
  const float rawTopTemperatureC = sensors.getTempCByIndex(0);
  const float rawBottomTemperatureC = sensors.getTempCByIndex(1);

  Serial.print("Sensor raw top/bottom: ");
  Serial.print(rawTopTemperatureC, 4);
  Serial.print(" / ");
  Serial.println(rawBottomTemperatureC, 4);

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

void printTemperatureLine(const char *label, float temperatureC) {
  display.print(label);
  display.print(" ");

  if (isValidTemperature(temperatureC)) {
    display.print(temperatureC, 1);
    display.print(" c");
  } else {
    display.print("--.- c");
  }
}

void updateDisplay() {
  display.clearBuffer();

  display.setFont(u8g2_font_helvB14_tf);
  display.setCursor(0, 16);
  display.print("EnergyZen");

  display.setFont(u8g2_font_helvB18_tf);
  display.setCursor(0, 40);
  printTemperatureLine("Yla", topTemperatureC);

  display.setCursor(0, 64);
  printTemperatureLine("Ala", bottomTemperatureC);

  if (sensorDataStale &&
      (lastSuccessfulSensorReadMillis == 0 ||
       millis() - lastSuccessfulSensorReadMillis >= SENSOR_STALE_WARNING_MS)) {
    display.setFont(u8g2_font_5x7_tf);
    display.setCursor(96, 10);
    display.print("STALE");
  }

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

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  display.setI2CAddress(OLED_I2C_ADDRESS << 1);
  display.begin();
  display.clearBuffer();
  display.sendBuffer();

  maintainWiFi(millis(), true);

  readTemperatures(millis());
  updateDisplay();
  previousSupabaseSendMs = millis();
}

void loop() {
  const unsigned long currentMs = millis();

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
