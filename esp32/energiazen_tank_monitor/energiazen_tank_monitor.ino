#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>

// EnergiaZen standalone ESP32 tank monitor
// Hardware:
// - ESP32 Dev Module
// - 2 x DS18B20 on GPIO4
// - 1.3" SH1106 I2C OLED 128x64, SDA GPIO21, SCL GPIO22
//
// Required Arduino libraries:
// - OneWire
// - DallasTemperature
// - Adafruit GFX Library
// - Adafruit SH110X

constexpr uint8_t ONE_WIRE_BUS_PIN = 4;
constexpr uint8_t OLED_SDA_PIN = 21;
constexpr uint8_t OLED_SCL_PIN = 22;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;
constexpr uint8_t OLED_WIDTH = 128;
constexpr uint8_t OLED_HEIGHT = 64;
constexpr int OLED_RESET_PIN = -1;

constexpr unsigned long SENSOR_READ_INTERVAL_MS = 5000;
constexpr float MIN_TANK_TEMPERATURE_C = 20.0;
constexpr float MAX_TANK_TEMPERATURE_C = 80.0;
constexpr float SHOWERS_AT_MAX_TEMPERATURE = 6.0;

OneWire oneWire(ONE_WIRE_BUS_PIN);
DallasTemperature sensors(&oneWire);
Adafruit_SH1106G display(OLED_WIDTH, OLED_HEIGHT, &Wire, OLED_RESET_PIN);

float topTemperatureC = NAN;
float bottomTemperatureC = NAN;
float showersLeft = 0.0;
unsigned long previousSensorReadMs = 0;

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

void printTemperatureLine(const char *label, float temperatureC) {
  display.print(label);
  display.print(" ");

  if (isValidTemperature(temperatureC)) {
    display.print(temperatureC, 1);
    display.print(" C");
  } else {
    display.print("--.- C");
  }
}

void updateDisplay() {
  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);

  display.println("EnergiaZen");

  display.setCursor(0, 18);
  printTemperatureLine("Yla", topTemperatureC);

  display.setCursor(0, 34);
  printTemperatureLine("Ala", bottomTemperatureC);

  display.setCursor(0, 50);
  display.print("Suihkut ");
  display.print(showersLeft, 1);

  display.display();
}

void setup() {
  Serial.begin(115200);

  sensors.begin();
  sensors.setResolution(12);

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  display.begin(OLED_I2C_ADDRESS, true);
  display.clearDisplay();
  display.display();

  readTemperatures();
  updateDisplay();
}

void loop() {
  const unsigned long currentMs = millis();

  if (currentMs - previousSensorReadMs >= SENSOR_READ_INTERVAL_MS) {
    previousSensorReadMs = currentMs;
    readTemperatures();
    updateDisplay();
  }
}
