#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
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
constexpr float MIN_TANK_TEMPERATURE_C = 20.0;
constexpr float MAX_TANK_TEMPERATURE_C = 80.0;
constexpr float SHOWERS_AT_MAX_TEMPERATURE = 6.0;

const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SUPABASE_KEY = "YOUR_SUPABASE_ANON_KEY";
const char *SUPABASE_ENDPOINT =
    "https://amyvzelzbvjvrevikvrp.supabase.co/rest/v1/tank_readings";

OneWire oneWire(ONE_WIRE_BUS_PIN);
DallasTemperature sensors(&oneWire);
U8G2_SH1106_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE);

float topTemperatureC = NAN;
float bottomTemperatureC = NAN;
float showersLeft = 0.0;
unsigned long previousSensorReadMs = 0;
unsigned long previousSupabaseSendMs = 0;

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
  return temperatureC != DEVICE_DISCONNECTED_C && !isnan(temperatureC);
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

void readTemperatures() {
  sensors.requestTemperatures();

  // The first discovered DS18B20 is shown as the upper tank sensor and the
  // second as the lower tank sensor. Swap the physical connectors if needed.
  topTemperatureC = sensors.getTempCByIndex(0);
  bottomTemperatureC = sensors.getTempCByIndex(1);
  showersLeft = calculateShowersLeft(topTemperatureC, bottomTemperatureC);
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.print("Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());
}

String jsonTemperatureValue(float temperatureC) {
  if (!isValidTemperature(temperatureC)) {
    return "null";
  }

  return String(temperatureC, 1);
}

void sendSupabaseReading() {
  connectWiFi();

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, SUPABASE_ENDPOINT)) {
    Serial.println("Supabase HTTP begin failed");
    return;
  }

  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Prefer", "return=minimal");

  const String payload =
      String("{\"top_temp\":") + jsonTemperatureValue(topTemperatureC) +
      ",\"bottom_temp\":" + jsonTemperatureValue(bottomTemperatureC) +
      ",\"showers\":" + String(showersLeft, 1) +
      ",\"heating\":false}";

  const int responseCode = http.POST(payload);
  Serial.print("Supabase POST response: ");
  Serial.println(responseCode);

  http.end();
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

  display.sendBuffer();
}

void setup() {
  Serial.begin(115200);

  sensors.begin();
  sensors.setResolution(12);

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  display.setI2CAddress(OLED_I2C_ADDRESS << 1);
  display.begin();
  display.clearBuffer();
  display.sendBuffer();

  connectWiFi();

  readTemperatures();
  updateDisplay();
  previousSupabaseSendMs = millis();
}

void loop() {
  const unsigned long currentMs = millis();

  if (currentMs - previousSensorReadMs >= SENSOR_READ_INTERVAL_MS) {
    previousSensorReadMs = currentMs;
    readTemperatures();
    updateDisplay();
  }

  if (currentMs - previousSupabaseSendMs >= SUPABASE_SEND_INTERVAL_MS) {
    previousSupabaseSendMs = currentMs;
    sendSupabaseReading();
  }
}
