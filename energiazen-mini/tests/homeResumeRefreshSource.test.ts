import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runHomeResumeRefreshSourceTests() {
  const homeSource = readFileSync(
    join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8",
  );
  const focusEffectStart = homeSource.indexOf("  useFocusEffect(");
  const focusEffectEnd = homeSource.indexOf(
    "\n  const fetchHourlyPrices",
    focusEffectStart,
  );
  const focusEffectSource = homeSource.slice(focusEffectStart, focusEffectEnd);
  const cleanupStart = focusEffectSource.indexOf("      return () => {");
  const cleanupSource = focusEffectSource.slice(cleanupStart);
  const backgroundGateStart = focusEffectSource.indexOf(
    'if (nextAppState === "background" || nextAppState === "inactive")',
  );
  const foregroundRefreshStart = focusEffectSource.indexOf(
    "if (returnedFromBackground) {",
    backgroundGateStart,
  );

  assertSource(
    focusEffectStart >= 0 &&
      focusEffectEnd > focusEffectStart &&
      cleanupStart >= 0,
    "etusivun tankkilukemien focus-efektin siivous pitää löytyä",
  );
  assertSource(
    focusEffectSource.includes("resumeRefreshPending = true;") &&
      focusEffectSource.includes("setIsTankReadingResumeRefreshPending(true);"),
    "background -> active pitää estää banneri jatkamispäivityksen ajaksi",
  );
  assertSource(
    backgroundGateStart >= 0 &&
      focusEffectSource.indexOf(
        "setIsTankReadingResumeRefreshPending(true);",
        backgroundGateStart,
      ) < foregroundRefreshStart,
    "banneriportti pitää sulkea jo taustalle siirryttäessä ennen foreground-renderiä",
  );
  assertSource(
    focusEffectSource.includes(
      "const refreshInFlightAtResume = tankReadingsRefreshInFlight;",
    ) &&
      focusEffectSource.includes("await refreshInFlightAtResume;") &&
      focusEffectSource.includes("await refreshTankReadings();") &&
      focusEffectSource.indexOf("await refreshTankReadings();") <
        focusEffectSource.indexOf(
          "setIsTankReadingResumeRefreshPending(false);",
        ),
    "foreground-portti saa avautua vasta erillisen refresh-attemptin valmistuttua",
  );
  assertSource(
    focusEffectSource.includes(
      "const focusRefreshGeneration = ++focusRefreshGenerationRef.current;",
    ) &&
      focusEffectSource.includes(
        "setIsTankReadingFocusRefreshPending(true);",
      ) &&
      focusEffectSource.includes(
        "focusRefreshGenerationRef.current === focusRefreshGeneration",
      ) &&
      focusEffectSource.includes("setIsTankReadingFocusRefreshPending(false);"),
    "jokaisella Home-focuksella pitää olla oma refresh-portti ja generation",
  );
  assertSource(
    focusEffectSource.includes(
      "const generation = ++resumeRefreshGeneration;",
    ) &&
      focusEffectSource.includes("generation !== resumeRefreshGeneration") &&
      focusEffectSource.includes("generation === resumeRefreshGeneration") &&
      focusEffectSource.indexOf("resumeRefreshGeneration += 1;") <
        focusEffectSource.indexOf(
          "setIsTankReadingResumeRefreshPending(true);",
          backgroundGateStart,
        ),
    "vain uusin resume-generation saa jatkaa refreshiin ja avata portin",
  );
  assertSource(
    cleanupSource.includes("resumeRefreshPending = false;") &&
      cleanupSource.includes("setIsTankReadingResumeRefreshPending(false);") &&
      cleanupSource.indexOf("setIsTankReadingResumeRefreshPending(false);") <
        cleanupSource.indexOf("appStateSubscription.remove();"),
    "background -> active -> toinen välilehti -> etusivu ei saa jättää jatkamispäivityksen banneriestettä päälle",
  );
}
