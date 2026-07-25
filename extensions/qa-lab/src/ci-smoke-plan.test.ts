// Qa Lab tests cover bounded CI smoke profile planning.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaSmokeCiPart } from "./ci-smoke-plan.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { listQaScenariosForExecutionProfile, readQaScenarioPack } from "./scenario-catalog.js";
import { scenarioMatchesQaProviderLane } from "./scenario-lane.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

const catalogProfileMock = vi.hoisted(() => ({
  mode: "actual" as "actual" | "empty" | "ineligible" | "unsupported",
}));

vi.mock("./scenario-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scenario-catalog.js")>();
  return {
    ...actual,
    listQaScenariosForExecutionProfile(profile: string) {
      if (catalogProfileMock.mode === "empty") {
        throw new Error(`unknown QA scenario execution profile: ${profile}`);
      }
      const scenarios = actual.listQaScenariosForExecutionProfile(profile);
      if (catalogProfileMock.mode === "ineligible") {
        return scenarios.map((scenario, index) =>
          index === 0 ? { ...scenario, sourcePath: "qa/scenarios/not-smoke-owned.yaml" } : scenario,
        );
      }
      if (catalogProfileMock.mode === "unsupported") {
        return scenarios.map((scenario, index) =>
          index === 0
            ? { ...scenario, execution: { ...scenario.execution, channel: "discord" } }
            : scenario,
        );
      }
      return scenarios;
    },
  };
});

type QaScenario = ReturnType<typeof readQaScenarioPack>["scenarios"][number];

function estimateScenarioCost(scenario: QaScenario | undefined): number {
  if (!scenario) {
    throw new Error("QA smoke plan selected an unknown scenario.");
  }
  if (scenario.execution.kind === "script") {
    return 8;
  }
  if (scenario.execution.kind === "playwright") {
    return 6;
  }
  return scenario.execution.kind === "flow" && scenario.execution.isolationReason ? 4 : 1;
}

describe("createQaSmokeCiPart", () => {
  afterEach(() => {
    catalogProfileMock.mode = "actual";
  });

  it("balances the bounded automatic smoke set across four profile parts", () => {
    const parts = ["profile-1", "profile-2", "profile-3", "profile-4"].map((partId) =>
      createQaSmokeCiPart(partId),
    );
    const repeatedLast = createQaSmokeCiPart("profile-4");

    expect(repeatedLast).toEqual(parts[3]);
    for (const part of parts) {
      expect(part.runs[0]?.channel).toBe(OPENCLAW_CRABLINE_DEFAULT_CHANNEL);
    }
    // The matrix channel run rides only on the last part.
    expect(
      parts.slice(0, 3).some((part) => part.runs.some((run) => run.channel === "matrix")),
    ).toBe(false);
    expect(parts[3]?.runs.some((run) => run.channel === "matrix")).toBe(true);

    const scenarioIds = parts.flatMap((part) => part.runs.flatMap((run) => run.scenario_ids));
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    const scenarioPack = readQaScenarioPack();
    const scenarioById = new Map(
      scenarioPack.scenarios.map((scenario) => [scenario.id, scenario] as const),
    );
    const profileScenarios = listQaScenariosForExecutionProfile("qa:smoke-ci");
    const profileScenarioIds = profileScenarios.map((scenario) => scenario.id);
    expect(profileScenarioIds).toHaveLength(12);
    expect(new Set(scenarioIds)).toEqual(new Set(profileScenarioIds));
    expect(
      new Set(scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.execution.kind)),
    ).toEqual(new Set(["flow", "playwright", "script"]));

    const selectedScenarioPaths = new Set(
      scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.sourcePath),
    );
    const scorecardReport = readQaScorecardTaxonomyReport([...scenarioById.values()]);
    const smokeScenarioRefs = new Set(
      scorecardReport.categories
        .filter((category) => category.profiles.includes("smoke-ci"))
        .flatMap((category) => category.scenarioRefs),
    );
    expect(
      [...selectedScenarioPaths].every(
        (scenarioPath) => scenarioPath !== undefined && smokeScenarioRefs.has(scenarioPath),
      ),
    ).toBe(true);
    const uncoveredCategoryIds = scorecardReport.categories
      .filter((category) => category.profiles.includes("smoke-ci"))
      .filter((category) => !category.scenarioRefs.some((ref) => selectedScenarioPaths.has(ref)))
      .map((category) => category.id);
    expect(uncoveredCategoryIds).toEqual([]);

    const profileScenarioIdSet = new Set(profileScenarioIds);
    const taxonomyProfile = expectDefined(
      scorecardReport.profiles.find((profile) => profile.id === "smoke-ci"),
      "smoke-ci taxonomy profile",
    );
    const providerMode = normalizeQaProviderMode("mock-openai");
    const primaryModel = defaultQaModelForMode(providerMode);
    const eligibleScenariosOutsideProfile = scenarioPack.scenarios.filter(
      (scenario) =>
        smokeScenarioRefs.has(scenario.sourcePath) &&
        !profileScenarioIdSet.has(scenario.id) &&
        scenarioMatchesQaProviderLane({
          scenario,
          providerMode,
          primaryModel,
          channelDriver: taxonomyProfile.channelDriver,
          channel: scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
        }),
    );
    expect(eligibleScenariosOutsideProfile.length).toBeGreaterThan(0);
    expect(
      eligibleScenariosOutsideProfile.every((scenario) => !scenarioIds.includes(scenario.id)),
    ).toBe(true);

    const primaryScenarioIds = parts.map(
      (part) => part.runs.find((run) => run.slug === "primary")?.scenario_ids ?? [],
    );
    const primaryRunCosts = primaryScenarioIds.map((ids) =>
      ids.reduce(
        (cost, scenarioId) => cost + estimateScenarioCost(scenarioById.get(scenarioId)),
        0,
      ),
    );
    const largestScenarioCost = Math.max(
      ...primaryScenarioIds.flatMap((ids) =>
        ids.map((scenarioId) => estimateScenarioCost(scenarioById.get(scenarioId))),
      ),
    );
    const heaviestRunCost = expectDefined(
      primaryRunCosts.toSorted((left, right) => right - left)[0],
      "heaviest QA smoke run cost",
    );
    const lightestRunCost = expectDefined(
      primaryRunCosts.toSorted((left, right) => left - right)[0],
      "lightest QA smoke run cost",
    );
    // Greedy balance: no part carries more than one heaviest-scenario cost
    // beyond the lightest, and every part runs at least one scenario.
    expect(heaviestRunCost - lightestRunCost).toBeLessThanOrEqual(largestScenarioCost);
    expect(primaryScenarioIds.every((ids) => ids.length > 0)).toBe(true);
  });

  it("rejects undeclared profile parts", () => {
    expect(() => createQaSmokeCiPart("profile-5")).toThrow(
      "unknown QA smoke CI profile part: profile-5",
    );
  });

  it("fails when the scenario-owned smoke profile is empty", () => {
    catalogProfileMock.mode = "empty";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "qa:smoke-ci did not resolve any scenario execution profile members",
    );
  });

  it("fails when the scenario-owned smoke profile contains a taxonomy-ineligible scenario", () => {
    catalogProfileMock.mode = "ineligible";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "qa:smoke-ci resolved ineligible CI scenarios",
    );
  });

  it("fails when the scenario-owned smoke profile contains an unsupported channel", () => {
    catalogProfileMock.mode = "unsupported";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "qa:smoke-ci resolved unsupported CI channels: discord",
    );
  });
});
