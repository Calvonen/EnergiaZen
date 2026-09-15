const fs = require('fs');

const path = 'app/settings.tsx';
let text = fs.readFileSync(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  text = text.replace(oldText, newText);
}

replaceOnce(
`import {
  fetchLatestTemperatureDropProfile,
  getTemperatureDropProfileHours,
  isTemperatureDropProfileFresh,
  TemperatureDropProfile,
} from "@/lib/temperatureDropProfile";`,
`import {
  fetchLatestTemperatureDropProfile,
  getTemperatureDropProfileHours,
  isTemperatureDropProfileFresh,
  TemperatureDropProfile,
} from "@/lib/temperatureDropProfile";
import {
  calculateV2EnergyCapacityKwh,
  reservePercentToKwh,
} from "@/lib/energyModelV2/energyReservePercent";`,
'import V2 reserve helpers',
);

replaceOnce(
`  label: string;
  subheadingBefore?: string;`,
`  label: string;
  secondaryValue?: string;
  subheadingBefore?: string;`,
'row secondary value',
);

replaceOnce(
`  safetyShowerReserve: {
    max: 9.5,
    min: 0,
    step: 0.5,
    unit: "suihkua",
  },
  maxTankTemperature: {`,
`  safetyShowerReserve: {
    max: 9.5,
    min: 0,
    step: 0.5,
    unit: "suihkua",
  },
  v2TargetReservePercent: {
    max: 100,
    min: 5,
    step: 5,
    unit: "%",
  },
  v2SafetyReservePercent: {
    max: 95,
    min: 0,
    step: 5,
    unit: "%",
  },
  maxTankTemperature: {`,
'percent setting editor options',
);

replaceOnce(
`  const [profileError, setProfileError] = useState<string | null>(null);
  const [showHourlyDetails, setShowHourlyDetails] = useState(false);`,
`  const [profileError, setProfileError] = useState<string | null>(null);
  const [latestInletTempC, setLatestInletTempC] = useState<number | null>(null);
  const [showHourlyDetails, setShowHourlyDetails] = useState(false);`,
'inlet state',
);

replaceOnce(
`  const settingsSections = useMemo(`,
`  const loadLatestInletTemperature = useCallback(async () => {
    const { data, error } = await supabase
      .from("tank_readings")
      .select("inlet_temp")
      .not("inlet_temp", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("Failed to load latest inlet temperature", error);
      setLatestInletTempC(null);
      return;
    }

    const inletTemp = data?.inlet_temp;
    setLatestInletTempC(
      typeof inletTemp === "number" && Number.isFinite(inletTemp)
        ? inletTemp
        : null,
    );
  }, []);

  const v2EnergyCapacityKwh = useMemo(
    () =>
      latestInletTempC === null
        ? null
        : calculateV2EnergyCapacityKwh({
            inletTemperatureC: latestInletTempC,
            maxTankTemperatureC: settings.maxTankTemperature,
            tankVolumeLiters: settings.tankSizeLiters,
          }),
    [latestInletTempC, settings.maxTankTemperature, settings.tankSizeLiters],
  );

  const formatV2ReserveKwh = useCallback(
    (percent: number) => {
      if (v2EnergyCapacityKwh === null) {
        return "kWh-arvio ei saatavilla";
      }
      const kwh = reservePercentToKwh(percent, v2EnergyCapacityKwh);
      return kwh === null
        ? "kWh-arvio ei saatavilla"
        : `≈ ${kwh.toFixed(1).replace(".", ",")} kWh`;
    },
    [v2EnergyCapacityKwh],
  );

  const settingsSections = useMemo(`,
'load inlet and capacity',
);

replaceOnce(
`          {
            accent: "#36f4d4",
            description:
              "Optimointi pyrkii pitämään käytettävissä yleensä vähintään tämän määrän suihkuja. Varaus voi hetkellisesti laskea tavoitteen alle, jos edullisia lämmitystunteja on tulossa.",
            key: "targetShowerReserve",
            label: "Tavoitevaraus suihkuina",
            value: \`${'${settings.targetShowerReserve}'} suihkua\`,
          },
          {
            accent: "#ffcf5a",
            description:
              "Ennustettu varaus ei saa laskea tämän alle. Jos raja uhkaa alittua, lämmitystä aikaistetaan hinnasta riippumatta.",
            key: "safetyShowerReserve",
            label: "Turvaraja suihkuina",
            value: \`${'${settings.safetyShowerReserve}'} suihkua\`,
          },`,
`          {
            accent: "#36f4d4",
            description:
              "V2 pyrkii pitämään varaajan fyysisestä energiakapasiteetista vähintään tämän osuuden. Prosentti on käyttäjän asetus; laskenta tehdään taustalla kWh-yksiköissä.",
            key: "v2TargetReservePercent",
            label: "Tavoitevaraus",
            secondaryValue: formatV2ReserveKwh(settings.v2TargetReservePercent),
            value: \`${'${settings.v2TargetReservePercent}'} %\`,
          },
          {
            accent: "#ffcf5a",
            description:
              "V2-ennusteen konservatiivinen energiamäärä ei saa laskea tämän osuuden alle. Jos raja uhkaa alittua, lämmitystä aikaistetaan hinnasta riippumatta.",
            key: "v2SafetyReservePercent",
            label: "Turvaraja",
            secondaryValue: formatV2ReserveKwh(settings.v2SafetyReservePercent),
            value: \`${'${settings.v2SafetyReservePercent}'} %\`,
          },`,
'replace shower reserve rows with percent reserve rows',
);

replaceOnce(
`    [settings],
  );`,
`    [formatV2ReserveKwh, settings],
  );`,
'settings section dependencies',
);

replaceOnce(
`      case "Lämminvesivaraus":
        return {
          key: "warmWater" as const,
          summary: getWarmWaterReserveSummary(settings),
        };`,
`      case "Lämminvesivaraus":
        return {
          key: "warmWater" as const,
          summary: `${settings.v2TargetReservePercent} % tavoite • ${settings.v2SafetyReservePercent} % turvaraja`,
        };`,
'V2 reserve summary',
);

replaceOnce(
`                    <Text style={styles.settingValue}>{row.value}</Text>`,
`                    <View style={{ alignItems: "flex-end", gap: 2 }}>
                      <Text style={styles.settingValue}>{row.value}</Text>
                      {row.secondaryValue ? (
                        <Text
                          style={[
                            styles.settingDescription,
                            { textAlign: "right" },
                          ]}
                        >
                          {row.secondaryValue}
                        </Text>
                      ) : null}
                    </View>`,
'secondary kWh rendering',
);

replaceOnce(
`  useFocusEffect(
    useCallback(() => {
      void loadTemperatureDropProfile();
    }, [loadTemperatureDropProfile]),
  );`,
`  useFocusEffect(
    useCallback(() => {
      void loadTemperatureDropProfile();
      void loadLatestInletTemperature();
    }, [loadLatestInletTemperature, loadTemperatureDropProfile]),
  );`,
'load inlet on focus',
);

fs.writeFileSync(path, text);
