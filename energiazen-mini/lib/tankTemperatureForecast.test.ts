import {
  buildHourlyTemperatureDropProfile,
  getForecastTargetHeatingStart,
  getForecastHeatingHours,
  isHeatingShiftedToTomorrow,
  predictWeightedTemperature,
  TankTemperatureReading,
} from "./tankTemperatureForecast";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(
  actual: number,
  expected: number,
  message: string,
  precision = 0.000001,
) {
  if (Math.abs(actual - expected) > precision) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function reading(
  createdAt: string,
  temperature: number,
  heating: boolean | null = false,
): TankTemperatureReading {
  return {
    bottom_temp: temperature,
    created_at: createdAt,
    heating,
    top_temp: temperature,
  };
}

function weightedReading({
  bottomTemperature,
  createdAt,
  heating = false,
  topTemperature,
}: {
  bottomTemperature: number;
  createdAt: string;
  heating?: boolean;
  topTemperature: number;
}): TankTemperatureReading {
  return {
    bottom_temp: bottomTemperature,
    created_at: createdAt,
    heating,
    top_temp: topTemperature,
  };
}

export function runTankTemperatureForecastUnitTests() {
  {
    const readings = Array.from({ length: 13 }, (_, index) =>
      reading(
        new Date(Date.UTC(2026, 6, 1, 4, index * 5)).toISOString(),
        60 - index * 0.1,
      ),
    );
    const profile = buildHourlyTemperatureDropProfile(readings);

    assertClose(
      profile[7],
      1.2,
      "5 minuutin mittaukset summataan tunnin kokonaispudotukseksi",
    );
  }

  {
    const profile = buildHourlyTemperatureDropProfile([
      reading("2026-07-01T04:00:00.000Z", 60),
      reading("2026-07-01T04:05:00.000Z", 59.9),
      reading("2026-07-01T04:10:00.000Z", 59.8),
      reading("2026-07-01T04:15:00.000Z", 54.8),
      reading("2026-07-01T04:20:00.000Z", 54.7),
      reading("2026-07-01T04:25:00.000Z", 54.6),
    ]);

    assertClose(
      profile[7],
      5.4,
      "suuri suihkupudotus ja pienet pudotukset muodostavat saman tunnin summan",
    );
  }

  {
    const profile = buildHourlyTemperatureDropProfile([
      reading("2026-07-01T04:00:00.000Z", 60),
      reading("2026-07-01T04:15:00.000Z", 54),
    ]);

    assertClose(profile[7], 6, "suihkupudotusta ei kerrota tunnin mittaiseksi");
  }

  {
    const profile = buildHourlyTemperatureDropProfile([
      reading("2026-07-01T04:00:00.000Z", 60),
      reading("2026-07-01T04:15:00.000Z", 55, true),
    ]);

    assertClose(profile[7], 0.25, "heating=true-jaksot jaavat pois");
  }

  {
    // T1-regressio: epavarma (heating=null, esim. Shellyn statuskysely
    // epaonnistui) lukema ei saa tulla mukaan pudotusprofiiliin - vain
    // eksplisiittinen heating=false kelpaa, aivan kuten heating=true jaa
    // pois.
    const profile = buildHourlyTemperatureDropProfile([
      reading("2026-07-01T04:00:00.000Z", 60),
      reading("2026-07-01T04:15:00.000Z", 55, null),
    ]);

    assertClose(
      profile[7],
      0.25,
      "epavarma (heating=null) lukema jattaa parin pois samoin kuin heating=true",
    );
  }

  {
    const profile = buildHourlyTemperatureDropProfile([
      reading("2026-07-01T04:00:00.000Z", 60),
      reading("2026-07-01T04:15:00.000Z", 59.5),
      reading("2026-07-01T05:00:00.000Z", 59),
      reading("2026-07-01T05:15:00.000Z", 58),
    ]);

    assertClose(profile[9], 0.75, "puuttuva kellotunti kayttaa yleismediaania");
  }

  {
    const readings = Array.from({ length: 7 }).flatMap((_, dayIndex) => {
      const startTemperature = 70;
      const dailyDrop = dayIndex + 1;

      return [
        reading(
          new Date(Date.UTC(2026, 6, 1 + dayIndex, 4, 0)).toISOString(),
          startTemperature,
        ),
        reading(
          new Date(Date.UTC(2026, 6, 1 + dayIndex, 4, 10)).toISOString(),
          startTemperature - dailyDrop,
        ),
        reading(
          new Date(Date.UTC(2026, 6, 1 + dayIndex, 4, 20)).toISOString(),
          startTemperature - dailyDrop,
        ),
      ];
    });
    const profile = buildHourlyTemperatureDropProfile(readings);

    assertClose(
      profile[7],
      4,
      "seitsemän päivän tuntisummista käytetään mediaania",
    );
  }

  {
    const profile = buildHourlyTemperatureDropProfile([
      weightedReading({
        bottomTemperature: 50,
        createdAt: "2026-07-01T04:00:00.000Z",
        topTemperature: 70,
      }),
      weightedReading({
        bottomTemperature: 49,
        createdAt: "2026-07-01T04:10:00.000Z",
        topTemperature: 68,
      }),
    ]);

    assertClose(profile[7], 1.7, "70/30-painotus käyttää ylä- ja alalämpöä");
  }

  {
    const profile = Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [hour, hour === 23 ? 2 : 1]),
    ) as Record<number, number>;
    const predicted = predictWeightedTemperature({
      currentTemperature: 70,
      from: new Date("2026-07-01T20:30:00.000Z"),
      hourlyDropProfile: profile,
      to: new Date("2026-07-01T22:30:00.000Z"),
    });

    assertClose(predicted, 67.5, "ennustus ylittaa vuorokauden rajan oikein");
  }

  {
    const hours = getForecastHeatingHours({
      currentHeatingHours: 1,
      predictedTemperature: 64.9,
      settingsHeatingHoursPerDay: 3,
    });

    assertEqual(hours, 2, "ennuste voi kasvattaa tarpeen 1 tunnista 2 tuntiin");
  }

  {
    const hours = getForecastHeatingHours({
      currentHeatingHours: 1,
      predictedTemperature: 49.9,
      settingsHeatingHoursPerDay: 3,
    });

    assertEqual(hours, 2, "ennuste saa lisata enintaan yhden lammitystunnin");
  }

  {
    const hours = getForecastHeatingHours({
      currentHeatingHours: 1,
      isFixedHeatingNeed: true,
      predictedTemperature: 40,
      settingsHeatingHoursPerDay: 3,
    });

    assertEqual(hours, 1, "fixed-tila ei muutu");
  }

  {
    const currentTime = new Date("2026-07-01T09:00:00.000Z");
    const todayMaintenanceHour = new Date("2026-07-01T10:00:00.000Z");
    const firstTomorrowHeatingHour = new Date("2026-07-02T02:00:00.000Z");
    const reason =
      "Huominen on 3,0 snt/kWh halvempi ja varausta on riittävästi, joten lämmitys siirrettiin huomiseen.";
    const target = getForecastTargetHeatingStart({
      currentTime,
      isShiftedToTomorrow: isHeatingShiftedToTomorrow(reason),
      preliminaryTodayHeatingHours: [
        {
          date: todayMaintenanceHour,
          status: "planned",
        },
      ],
      tomorrowHeatingHours: [
        {
          date: firstTomorrowHeatingHour,
        },
      ],
    });
    const predictedTemperature = predictWeightedTemperature({
      currentTemperature: 66,
      from: currentTime,
      hourlyDropProfile: Object.fromEntries(
        Array.from({ length: 24 }, (_, hour) => [hour, 0.1]),
      ),
      to: target ?? currentTime,
    });
    const hours = getForecastHeatingHours({
      currentHeatingHours: 1,
      predictedTemperature,
      settingsHeatingHoursPerDay: 3,
    });

    assertEqual(
      target?.toISOString(),
      firstTomorrowHeatingHour.toISOString(),
      "huomiseen siirrossa ennuste tehdaan huomisen ensimmaiseen tuntiin",
    );
    assertEqual(
      hours,
      2,
      "huomiseen siirretty ennuste kasvattaa tarpeen 1 tunnista 2 tuntiin",
    );
  }

  {
    const currentTime = new Date("2026-07-01T20:00:00.000Z");
    const pastTodayHeatingHour = new Date("2026-07-01T10:00:00.000Z");
    const firstTomorrowHeatingHour = new Date("2026-07-02T02:00:00.000Z");
    const target = getForecastTargetHeatingStart({
      currentTime,
      isShiftedToTomorrow: false,
      preliminaryTodayHeatingHours: [
        {
          date: pastTodayHeatingHour,
          status: "planned",
        },
      ],
      tomorrowHeatingHours: [
        {
          date: firstTomorrowHeatingHour,
        },
      ],
    });

    assertEqual(
      target?.toISOString(),
      firstTomorrowHeatingHour.toISOString(),
      "huomisen ensimmainen tunti valitaan kun tanaan ei ole tulevaa tuntia",
    );
  }
}
