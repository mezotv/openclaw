// Qa Lab helper module supports run config behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { defaultQaModelForMode as defaultStaticQaModelForMode } from "./model-selection.js";
import { defaultQaRuntimeModelForMode } from "./model-selection.runtime.js";
import {
  resolveQaRunProfileExecutionSelection,
  resolveQaRunProfileMembership,
} from "./profile-planning.js";
import {
  DEFAULT_QA_LIVE_PROVIDER_MODE,
  getQaProvider,
  isQaProviderModeInput,
  normalizeQaProviderMode as normalizeQaProviderModeInput,
  type QaProviderMode,
} from "./providers/index.js";
import {
  resolveQaRuntimePairLaneScenarioIds,
  resolveQaRuntimePairScenarioSupport,
} from "./runtime-pair-lane-selection.js";
import type { RuntimeId } from "./runtime-parity.js";
import {
  qaRuntimePairLaneSchema,
  type QaRuntimePairLane,
  type QaSeedScenario,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import {
  qaScorecardChannelDriverSchema,
  qaScorecardEvidenceModeSchema,
  type QaScorecardChannelDriver,
  type QaScorecardEvidenceMode,
  type QaScorecardTaxonomyReport,
} from "./scorecard-taxonomy.js";
import { resolveQaSuiteScenarioChannels } from "./suite-planning.js";

export type { QaProviderMode } from "./model-selection.js";
export type { QaProviderModeInput } from "./providers/index.js";

type QaLabRunSelection = {
  profile: string;
  channel: string | null;
  channelDriver: QaScorecardChannelDriver;
  evidenceMode: QaScorecardEvidenceMode;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  runtimePair: [RuntimeId, RuntimeId] | null;
  runtimePairLane: QaRuntimePairLane | null;
  scenarioIds: string[] | null;
};

type QaLabResolvedRunPlan = {
  status: "ready" | "invalid";
  profile: string;
  explicitScenarioSelection: boolean;
  selectedScenarios: Array<{
    id: string;
    title: string;
    executionKind: "flow" | "playwright" | "script" | "vitest";
    declaredChannel: string | null;
    effectiveChannel: string | null;
  }>;
  executionKinds: Array<"flow" | "playwright" | "script" | "vitest">;
  exclusions: Array<{
    scenarioId: string;
    executionKind: "flow" | "playwright" | "script" | "vitest";
    reasons: string[];
  }>;
  errors: string[];
};

type QaLabRunProfileOption = QaScorecardTaxonomyReport["profiles"][number];

type QaLabRunArtifacts = {
  outputDir: string;
  evidencePath: string;
  reportPath: string;
  summaryPath: string;
  watchUrl: string;
};

type QaLabRunnerSnapshot = {
  status: "idle" | "running" | "completed" | "failed";
  selection: QaLabRunSelection;
  plan: QaLabResolvedRunPlan | null;
  startedAt?: string;
  finishedAt?: string;
  artifacts: QaLabRunArtifacts | null;
  error: string | null;
};

export function defaultQaModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultQaRuntimeModelForMode(mode, alternate ? { alternate: true } : undefined);
}

type QaDefaultModelResolver = (mode: QaProviderMode, alternate?: boolean) => string;

function defaultStaticModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultStaticQaModelForMode(mode, alternate ? { alternate: true } : undefined);
}

function defaultQaRunProfile(profiles: readonly QaLabRunProfileOption[]) {
  return profiles.find((profile) => profile.id === "smoke-ci") ?? profiles[0];
}

function createDefaultQaRunSelection(
  profiles: readonly QaLabRunProfileOption[],
  options?: { resolveDefaultModel?: QaDefaultModelResolver },
): QaLabRunSelection {
  const profile = defaultQaRunProfile(profiles);
  const profileId = profile?.id ?? "smoke-ci";
  const providerMode: QaProviderMode =
    profileId === "smoke-ci" ? "mock-openai" : DEFAULT_QA_LIVE_PROVIDER_MODE;
  const resolveDefaultModel = options?.resolveDefaultModel ?? defaultQaModelForMode;
  return {
    profile: profileId,
    channel: null,
    channelDriver: profile?.channelDriver ?? "qa-channel",
    evidenceMode: profile?.evidenceMode ?? "full",
    providerMode,
    primaryModel: resolveDefaultModel(providerMode),
    alternateModel: resolveDefaultModel(providerMode, true),
    fastMode: getQaProvider(providerMode).kind === "live",
    runtimePair: null,
    runtimePairLane: null,
    scenarioIds: null,
  };
}

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  if (input === undefined || input === null || input === "") {
    return DEFAULT_QA_LIVE_PROVIDER_MODE;
  }
  if (isQaProviderModeInput(input)) {
    return normalizeQaProviderModeInput(input);
  }
  const details = typeof input === "string" ? `: ${input}` : "";
  throw new Error(`unknown QA provider mode${details}`);
}

function normalizeModel(input: unknown, fallback: string) {
  const value = typeof input === "string" ? input.trim() : "";
  return value || fallback;
}

function normalizeScenarioIds(input: unknown, scenarios: QaSeedScenario[]): string[] | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("QA runner scenarioIds must be a non-empty array");
  }
  const requestedIds = input.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("QA runner scenarioIds must contain non-empty strings");
    }
    return value.trim();
  });
  const selectedIds = uniqueStrings(requestedIds);
  const availableIds = new Set(scenarios.map((scenario) => scenario.id));
  const unknownIds = selectedIds.filter((id) => !availableIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`unknown QA scenario id(s): ${unknownIds.join(", ")}`);
  }
  return selectedIds;
}

function normalizeQaChannelDriver(
  input: unknown,
  fallback: QaScorecardChannelDriver,
): QaScorecardChannelDriver {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }
  const parsed = qaScorecardChannelDriverSchema.safeParse(input);
  if (!parsed.success) {
    const details = typeof input === "string" ? `: ${input}` : "";
    throw new Error(`unknown QA channel driver${details}`);
  }
  return parsed.data;
}

function normalizeQaProfile(
  input: unknown,
  profiles: readonly QaLabRunProfileOption[],
  fallbackProfile?: string,
) {
  const fallback = fallbackProfile ?? defaultQaRunProfile(profiles)?.id ?? "smoke-ci";
  // Match the other optional runner controls: null means no override, while any
  // concrete profile value must be a non-empty string or the request fails closed.
  if (input !== undefined && input !== null && (typeof input !== "string" || !input.trim())) {
    throw new Error("QA runner profile must be a non-empty string");
  }
  const profile = typeof input === "string" ? input.trim() : fallback;
  if (profiles.length > 0 && !profiles.some((entry) => entry.id === profile)) {
    throw new Error(
      `unknown QA run profile: ${profile}; expected one of ${profiles.map((entry) => entry.id).join(", ")}`,
    );
  }
  return profile;
}

function normalizeQaChannel(input: unknown): string | null {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("QA runner channel must be a non-empty string");
  }
  return input.trim().toLowerCase();
}

function normalizeQaEvidenceMode(
  input: unknown,
  fallback: QaScorecardEvidenceMode,
): QaScorecardEvidenceMode {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }
  const parsed = qaScorecardEvidenceModeSchema.safeParse(input);
  if (!parsed.success) {
    const details = typeof input === "string" ? `: ${input}` : "";
    throw new Error(`unknown QA evidence mode${details}`);
  }
  return parsed.data;
}

function normalizeQaRuntimePair(input: unknown): [RuntimeId, RuntimeId] | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (
    !Array.isArray(input) ||
    input.length !== 2 ||
    !input.every((runtime) => runtime === "openclaw" || runtime === "codex")
  ) {
    throw new Error('QA runner runtimePair must be ["openclaw", "codex"]');
  }
  if (input[0] === input[1]) {
    throw new Error("QA runner runtimePair must compare two different runtimes");
  }
  if (input[0] !== "openclaw" || input[1] !== "codex") {
    throw new Error('QA runner runtimePair must be ["openclaw", "codex"]');
  }
  return ["openclaw", "codex"];
}

function normalizeQaRuntimePairLane(input: unknown): QaRuntimePairLane | null {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  const parsed = qaRuntimePairLaneSchema.safeParse(input);
  if (!parsed.success) {
    const details = typeof input === "string" ? `: ${input}` : "";
    throw new Error(`unknown QA runtime-pair lane${details}`);
  }
  return parsed.data;
}

export function normalizeQaRunSelection(
  input: unknown,
  scenarios: QaSeedScenario[],
  profiles: readonly QaLabRunProfileOption[] = [],
): QaLabRunSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("QA runner request must be a JSON object");
  }
  const payload = input as Record<string, unknown>;
  const profile = normalizeQaProfile(
    payload.profile,
    profiles,
    Array.isArray(payload.scenarioIds) && profiles.some((entry) => entry.id === "all")
      ? "all"
      : undefined,
  );
  // A scenario-only API request uses `all` solely as its membership owner. Keep
  // the legacy execution defaults unless the caller explicitly chose a profile.
  const profileDefaults =
    Array.isArray(payload.scenarioIds) &&
    (payload.profile === undefined || payload.profile === null)
      ? undefined
      : profiles.find((entry) => entry.id === profile);
  const providerMode = normalizeQaProviderMode(
    payload.providerMode ?? (profile === "smoke-ci" ? "mock-openai" : undefined),
  );
  return {
    profile,
    channel: normalizeQaChannel(payload.channel),
    channelDriver: normalizeQaChannelDriver(
      payload.channelDriver,
      profileDefaults?.channelDriver ?? "qa-channel",
    ),
    evidenceMode: normalizeQaEvidenceMode(
      payload.evidenceMode,
      profileDefaults?.evidenceMode ?? "full",
    ),
    providerMode,
    primaryModel: normalizeModel(payload.primaryModel, defaultQaModelForMode(providerMode)),
    alternateModel: normalizeModel(
      payload.alternateModel,
      defaultQaModelForMode(providerMode, true),
    ),
    fastMode: getQaProvider(providerMode).kind === "live" || payload.fastMode === true,
    runtimePair: normalizeQaRuntimePair(payload.runtimePair),
    runtimePairLane: normalizeQaRuntimePairLane(payload.runtimePairLane),
    scenarioIds: normalizeScenarioIds(payload.scenarioIds, scenarios),
  };
}

function executionKindForScenario(
  scenario: QaSeedScenarioWithSource,
): "flow" | "playwright" | "script" | "vitest" {
  return scenario.execution.kind ?? "flow";
}

function effectiveChannelForScenario(params: {
  scenario: QaSeedScenarioWithSource;
  selection: QaLabRunSelection;
  defaultChannel?: string;
}): string | null {
  if (executionKindForScenario(params.scenario) !== "flow") {
    return null;
  }
  const fallbackChannel =
    params.defaultChannel ?? params.selection.channel ?? params.scenario.execution.channel;
  if (!fallbackChannel) {
    return null;
  }
  return (
    resolveQaSuiteScenarioChannels({
      defaultChannel: fallbackChannel,
      explicitChannel:
        params.selection.channelDriver === "qa-channel" ? null : params.selection.channel,
      scenarios: [params.scenario],
    })[0] ?? null
  );
}

export function resolveQaLabRunPlan(params: {
  selection: QaLabRunSelection;
  scenarios: QaSeedScenarioWithSource[];
  scorecardReport: QaScorecardTaxonomyReport;
  defaultChannel?: string;
  supportsChannel?: (channel: string) => boolean;
}): QaLabResolvedRunPlan {
  const { selection } = params;
  const explicitScenarioSelection = selection.scenarioIds !== null;
  const membership = resolveQaRunProfileMembership(
    {
      profile: selection.profile,
      scenarioIds: selection.scenarioIds ?? undefined,
    },
    { scenarios: params.scenarios, scorecardReport: params.scorecardReport },
  );
  const scenarioById = new Map(params.scenarios.map((scenario) => [scenario.id, scenario]));
  const exclusions: QaLabResolvedRunPlan["exclusions"] = membership.excludedScenarioIds.map(
    (scenarioId) => {
      const scenario = scenarioById.get(scenarioId);
      return {
        scenarioId,
        executionKind: scenario ? executionKindForScenario(scenario) : "flow",
        reasons: [`not a member of profile ${selection.profile}`],
      };
    },
  );
  let laneSelection: ReturnType<typeof resolveQaRuntimePairLaneScenarioIds>;
  const errors: string[] = [];
  try {
    laneSelection = resolveQaRuntimePairLaneScenarioIds({
      channel: selection.channel,
      channelDriver: selection.channelDriver,
      defaultChannel: selection.channelDriver === "crabline" ? params.defaultChannel : undefined,
      primaryModel: selection.primaryModel,
      providerMode: selection.providerMode,
      scenarioIds: selection.runtimePairLane
        ? []
        : membership.selectedScenarios.map((scenario) => scenario.id),
      scenarios: membership.profileScenarios,
      runtimePairLanes: selection.runtimePairLane ? [selection.runtimePairLane] : [],
      runtimePair: selection.runtimePair !== null,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    laneSelection = {
      scenarioIds: [],
      excludedLaneScenarios: [],
      excludedNonFlowScenarios: [],
    };
  }
  exclusions.push(
    ...laneSelection.excludedLaneScenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: executionKindForScenario(scenario),
      reasons: ["does not match the selected provider/model/channel lane"],
    })),
    ...laneSelection.excludedNonFlowScenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: executionKindForScenario(scenario),
      reasons: ["runtimePair requires execution.kind=flow"],
    })),
  );
  if (selection.runtimePairLane && explicitScenarioSelection) {
    const laneScenarioIds = new Set(laneSelection.scenarioIds);
    const alreadyExcludedIds = new Set(exclusions.map((exclusion) => exclusion.scenarioId));
    exclusions.push(
      ...membership.selectedScenarios
        .filter(
          (scenario) => !laneScenarioIds.has(scenario.id) && !alreadyExcludedIds.has(scenario.id),
        )
        .map((scenario) => ({
          scenarioId: scenario.id,
          executionKind: executionKindForScenario(scenario),
          reasons: [`runtimePairLane=${selection.runtimePairLane}`],
        })),
    );
    laneSelection = {
      ...laneSelection,
      scenarioIds: membership.selectedScenarios
        .filter((scenario) => laneScenarioIds.has(scenario.id))
        .map((scenario) => scenario.id),
    };
  }
  const laneScenarios = laneSelection.scenarioIds.flatMap((scenarioId) => {
    const scenario = scenarioById.get(scenarioId);
    return scenario ? [scenario] : [];
  });
  const profileExecution = resolveQaRunProfileExecutionSelection({
    scenarios: laneScenarios,
    providerMode: selection.providerMode,
    primaryModel: selection.primaryModel,
    channelDriver: selection.channelDriver,
    channel: selection.channel,
    defaultChannel: selection.channelDriver === "crabline" ? params.defaultChannel : undefined,
  });
  exclusions.push(
    ...profileExecution.excludedScenarios.map(({ scenario, reasons }) => ({
      scenarioId: scenario.id,
      executionKind: executionKindForScenario(scenario),
      reasons,
    })),
  );
  const runtimePairSupport = selection.runtimePair
    ? resolveQaRuntimePairScenarioSupport(profileExecution.selectedScenarios)
    : { selectedScenarios: profileExecution.selectedScenarios, excludedScenarios: [] };
  exclusions.push(
    ...runtimePairSupport.excludedScenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: executionKindForScenario(scenario),
      reasons: ["runtimePair requires execution.kind=flow"],
    })),
  );
  let selectedScenarios = runtimePairSupport.selectedScenarios;
  if (selection.channelDriver !== "qa-channel" && params.supportsChannel) {
    const unsupportedChannelScenarios = selectedScenarios.flatMap((scenario) => {
      const channel = effectiveChannelForScenario({
        scenario,
        selection,
        defaultChannel: params.defaultChannel,
      });
      if (executionKindForScenario(scenario) !== "flow") {
        return [];
      }
      return channel !== null && !params.supportsChannel?.(channel) ? [{ scenario, channel }] : [];
    });
    const unsupportedIds = new Set(unsupportedChannelScenarios.map(({ scenario }) => scenario.id));
    exclusions.push(
      ...unsupportedChannelScenarios.map(({ scenario, channel }) => ({
        scenarioId: scenario.id,
        executionKind: executionKindForScenario(scenario),
        reasons: [`unsupported ${selection.channelDriver} channel=${channel}`],
      })),
    );
    selectedScenarios = selectedScenarios.filter((scenario) => !unsupportedIds.has(scenario.id));
  }
  if (membership.categories.length === 0) {
    errors.push(`QA run profile ${selection.profile} did not resolve any taxonomy categories.`);
  }
  if (selection.channel && selection.channelDriver === "qa-channel") {
    errors.push("An execution channel requires channelDriver=crabline or channelDriver=live.");
  }
  const explicitScenarioIds = new Set(selection.scenarioIds ?? []);
  const explicitExclusions = exclusions.filter((exclusion) =>
    explicitScenarioIds.has(exclusion.scenarioId),
  );
  if (explicitScenarioSelection && explicitExclusions.length > 0) {
    errors.push(
      `Explicit QA scenario selection is not runnable: ${explicitExclusions
        .map((exclusion) => `${exclusion.scenarioId} (${exclusion.reasons.join(", ")})`)
        .join("; ")}.`,
    );
  }
  if (selectedScenarios.length === 0) {
    errors.push("QA run plan selected no runnable scenarios.");
  }
  const executionKinds = uniqueStrings(selectedScenarios.map(executionKindForScenario)) as Array<
    "flow" | "playwright" | "script" | "vitest"
  >;
  return {
    status: errors.length > 0 ? "invalid" : "ready",
    profile: selection.profile,
    explicitScenarioSelection,
    selectedScenarios: selectedScenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      executionKind: executionKindForScenario(scenario),
      declaredChannel: scenario.execution.channel ?? null,
      effectiveChannel: effectiveChannelForScenario({
        scenario,
        selection,
        defaultChannel: params.defaultChannel,
      }),
    })),
    executionKinds,
    exclusions,
    errors: uniqueStrings(errors),
  };
}

export function createIdleQaRunnerSnapshot(
  profiles: readonly QaLabRunProfileOption[] = [],
  plan: QaLabResolvedRunPlan | null = null,
): QaLabRunnerSnapshot {
  return {
    status: "idle",
    selection: createDefaultQaRunSelection(profiles, {
      resolveDefaultModel: defaultStaticModelForMode,
    }),
    plan,
    artifacts: null,
    error: null,
  };
}

export function createQaRunOutputDir(baseDir = process.cwd()) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
  return path.join(baseDir, ".artifacts", "qa-e2e", `lab-${stamp}-${randomUUID().slice(0, 8)}`);
}
