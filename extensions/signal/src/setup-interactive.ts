import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  WizardCancelledError,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import {
  resolveSignalAccount,
  resolveSignalTransport,
  type ResolvedSignalTransport,
} from "./accounts.js";
import { spawnSignalDaemon } from "./daemon.js";
import { installSignalCli } from "./install-signal-cli.js";
import {
  normalizeSignalAccountInput,
  patchSignalSetupAccount,
  signalSetupStateKeys,
} from "./setup-core.js";
import { aliasesManagedSignalEndpoint } from "./setup-endpoint-identity.js";
import { resolveManagedSignalAccount } from "./setup-managed-account.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  resolveConfiguredSignalTransport,
  type SignalTransportProbeResult,
  writeSignalAccountTransport,
} from "./setup-transport.js";
import { buildSignalTransportHttpUrl } from "./transport-url.js";

type SignalSetupMode = "local" | "existing-server";
type SignalCliConfigLocation = "default" | "custom";
type SignalPrepareParams = Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0];
type SignalFinalizeParams = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0];
type SignalExistingTransport = Extract<
  SignalTransportConfig,
  { kind: "external-native" | "container" }
>;
type ExistingServerPromptParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  initialValue?: string;
};
type ManagedSignalTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;
type ResolvedManagedSignalTransport = Extract<ResolvedSignalTransport, { kind: "managed-native" }>;

function resolveExplicitSignalCliDataDirectory(configPath: string | undefined): string | undefined {
  const configured = normalizeOptionalString(configPath);
  if (!configured) {
    return undefined;
  }
  const absolute = path.resolve(resolveUserPath(configured));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

type SignalCliDataDirectoryRelationship = "same" | "different" | "unknown";

function compareSignalCliDataDirectories(
  active: ResolvedManagedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): SignalCliDataDirectoryRelationship {
  const activeDirectory = resolveExplicitSignalCliDataDirectory(active.configPath);
  const candidateDirectory = resolveExplicitSignalCliDataDirectory(candidate.configPath);
  if (!activeDirectory || !candidateDirectory) {
    // signal-cli can source its implicit dataDir from system or user config.
    // Two omitted paths share that resolution; one omitted path cannot be
    // proven distinct from an explicit store while the daemon owns its lock.
    return !activeDirectory && !candidateDirectory ? "same" : "unknown";
  }
  const same =
    process.platform === "win32"
      ? activeDirectory.toLowerCase() === candidateDirectory.toLowerCase()
      : activeDirectory === candidateDirectory;
  return same ? "same" : "different";
}

export async function prepareSignalInteractiveSetup(params: SignalPrepareParams) {
  const resolvedAccount = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const originalAccount = normalizeSignalAccountInput(resolvedAccount.config.account) ?? undefined;
  const initialMode: SignalSetupMode =
    resolvedAccount.configured && resolvedAccount.transport.kind !== "managed-native"
      ? "existing-server"
      : "local";

  const mode = await params.prompter.select<SignalSetupMode>({
    message: "How do you want to set up Signal for OpenClaw?",
    initialValue: initialMode,
    options: [
      {
        value: "local",
        label: "Use local signal-cli",
        hint: "OpenClaw starts the local signal-cli daemon for this account.",
      },
      {
        value: "existing-server",
        label: "Connect to an existing Signal server",
        hint: "OpenClaw detects and stores the server protocol for this account.",
      },
    ],
  });

  const prepared =
    mode === "local"
      ? await prepareManagedNativeSetup(params, resolvedAccount.transport)
      : await prepareExistingServerSetup(params, resolvedAccount.transport);
  return {
    ...prepared,
    credentialValues: {
      ...prepared.credentialValues,
      ...(originalAccount ? { [signalSetupStateKeys.originalAccount]: originalAccount } : {}),
    },
  };
}

export async function finalizeSignalInteractiveSetup(params: SignalFinalizeParams) {
  const kind = params.credentialValues[signalSetupStateKeys.transportKind];
  let cfg = params.cfg;
  const resolvedAccount = resolveSignalAccount({
    cfg,
    accountId: params.accountId,
  });
  const configuredAccount =
    normalizeSignalAccountInput(resolvedAccount.config.account) ?? undefined;
  const originalAccount = normalizeSignalAccountInput(
    params.credentialValues[signalSetupStateKeys.originalAccount],
  );
  if (originalAccount && originalAccount !== configuredAccount) {
    cfg = patchSignalSetupAccount({
      cfg,
      accountId: params.accountId,
      patch: { accountUuid: undefined },
    });
  }
  let account = configuredAccount;
  let managedAccountLinked = true;
  let transport: SignalTransportConfig;
  let resolvedManagedTransport: ResolvedManagedSignalTransport | undefined;
  let useTemporaryManagedValidationPort = false;
  if (kind === "managed-native") {
    let cliPath = params.credentialValues[signalSetupStateKeys.cliPath] ?? "signal-cli";
    if (
      params.options?.allowSignalInstall &&
      params.credentialValues[signalSetupStateKeys.installRequested] === "true"
    ) {
      cliPath = await installRequestedSignalCli(params, cliPath);
    }
    const hasConfigPathChoice = Object.hasOwn(
      params.credentialValues,
      signalSetupStateKeys.cliConfigPath,
    );
    const configPath = normalizeOptionalString(
      params.credentialValues[signalSetupStateKeys.cliConfigPath],
    );
    const preparedTransport = prepareSignalManagedNativeTransport({
      cfg,
      accountId: params.accountId,
      overrides: {
        cliPath,
        ...(hasConfigPathChoice ? { configPath: configPath ?? "" } : {}),
      },
    });
    if (hasConfigPathChoice && !configPath) {
      const { configPath: _clearedConfigPath, ...defaultConfigTransport } = preparedTransport;
      transport = defaultConfigTransport;
    } else {
      transport = preparedTransport;
    }
  } else if (kind === "external-native" || kind === "container") {
    const url = params.credentialValues[signalSetupStateKeys.serverUrl];
    if (!url) {
      throw new Error("Signal setup is missing its prepared transport candidate.");
    }
    transport = { kind, url };
  } else {
    throw new Error("Signal setup is missing its prepared transport candidate.");
  }

  if (transport.kind === "managed-native") {
    const resolvedTransport = resolveSignalTransport(transport);
    if (resolvedTransport.kind !== "managed-native") {
      throw new Error("Signal setup did not resolve a managed signal-cli transport.");
    }
    resolvedManagedTransport = resolvedTransport;
    const configuredTransport = resolveConfiguredSignalTransport(cfg, params.accountId);
    if (
      resolvedAccount.transport.kind === "managed-native" &&
      (account || configuredTransport?.kind === "managed-native")
    ) {
      const existingTransport = configuredTransport ?? {
        kind: "managed-native",
      };
      const existingProbe = await probeSignalTransport({
        cfg,
        accountId: params.accountId,
        transport: existingTransport,
        ...(account ? { account } : {}),
        timeoutMs: 1_000,
      }).catch((error: unknown) => ({ ok: false, error: String(error) }));
      if (existingProbe.ok) {
        const activeManagedTransport = resolvedAccount.transport;
        if (isSameResolvedManagedTransport(activeManagedTransport, resolvedTransport)) {
          if (!account) {
            throw new Error(
              "The running Signal daemon is using this signal-cli config directory. Stop the OpenClaw gateway before discovering or linking an account, then retry setup.",
            );
          }
          return {
            cfg: writeSignalAccountTransport({
              cfg,
              accountId: params.accountId,
              transport,
            }),
          };
        }
        if (
          compareSignalCliDataDirectories(activeManagedTransport, resolvedTransport) !== "different"
        ) {
          throw new Error(
            "The running Signal daemon may be using this signal-cli config directory. Stop the OpenClaw gateway before changing its signal-cli settings, then retry setup.",
          );
        }
        useTemporaryManagedValidationPort = true;
      }
    }
    const resolution = await resolveManagedSignalAccount({
      transport: resolvedTransport,
      configuredAccount: account,
      selectionMode: "reuse-only-account",
      prompter: params.prompter,
      beforePersistentEffect: params.options?.beforePersistentEffect,
      ...(params.options?.abortSignal ? { abortSignal: params.options.abortSignal } : {}),
      deferDeviceLinkToClient: params.options?.deferDeviceLinkToClient,
      remoteWizard: params.options?.remoteWizard,
    });
    account = resolution.account;
    managedAccountLinked = resolution.linked;
    cfg = patchSignalSetupAccount({
      cfg,
      accountId: params.accountId,
      patch: {
        account,
        ...(account === configuredAccount ? {} : { accountUuid: undefined }),
      },
    });
  }

  let shouldPromptAccount = !account && transport.kind !== "managed-native";

  while (true) {
    // Account or URL recovery re-enters here so every probe sees matching candidate state.
    if (shouldPromptAccount) {
      account = await promptSignalAccount(params.prompter);
      cfg = patchSignalSetupAccount({
        cfg,
        accountId: params.accountId,
        patch: {
          account,
          ...(account === configuredAccount ? {} : { accountUuid: undefined }),
        },
      });
      shouldPromptAccount = false;
    }

    if (transport.kind === "managed-native" && !managedAccountLinked) {
      break;
    }
    const probe =
      transport.kind === "managed-native" && resolvedManagedTransport && account
        ? await probeManagedSignalSetup({
            cfg,
            accountId: params.accountId,
            transport,
            resolvedTransport: resolvedManagedTransport,
            account,
            runtime: params.runtime,
            prompter: params.prompter,
            useTemporaryPort: useTemporaryManagedValidationPort,
            ...(params.options?.abortSignal ? { abortSignal: params.options.abortSignal } : {}),
          })
        : await probeSignalTransport({
            cfg,
            accountId: params.accountId,
            transport,
            account,
          }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (probe.ok) {
      break;
    }

    await params.prompter.note(
      `OpenClaw could not validate this Signal setup.\n\n${probe.error ?? "Signal transport probe failed."}`,
      "Signal setup",
    );
    const recovery = await params.prompter.select<"retry" | "account" | "url" | "stop">({
      message: "How should Signal setup continue?",
      options: [
        { value: "retry", label: "Retry this setup" },
        { value: "account", label: "Try another Signal account" },
        ...(transport.kind === "managed-native"
          ? []
          : [{ value: "url" as const, label: "Try another Signal server URL" }]),
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "retry",
    });
    if (recovery === "stop") {
      throw new WizardCancelledError("Signal setup stopped");
    }
    if (recovery === "account") {
      if (transport.kind === "managed-native" && resolvedManagedTransport) {
        const resolution = await resolveManagedSignalAccount({
          transport: resolvedManagedTransport,
          selectionMode: "choose",
          prompter: params.prompter,
          beforePersistentEffect: params.options?.beforePersistentEffect,
          ...(params.options?.abortSignal ? { abortSignal: params.options.abortSignal } : {}),
          deferDeviceLinkToClient: params.options?.deferDeviceLinkToClient,
          remoteWizard: params.options?.remoteWizard,
        });
        account = resolution.account;
        managedAccountLinked = resolution.linked;
        cfg = patchSignalSetupAccount({
          cfg,
          accountId: params.accountId,
          patch: {
            account,
            ...(account === configuredAccount ? {} : { accountUuid: undefined }),
          },
        });
      } else {
        shouldPromptAccount = true;
      }
      continue;
    }
    if (recovery === "url" && transport.kind !== "managed-native") {
      transport = await promptExistingSignalTransport({
        cfg,
        prompter: params.prompter,
        initialValue: transport.url,
      });
      shouldPromptAccount = !account;
    }
  }

  if (!managedAccountLinked) {
    await params.prompter.note(
      [
        "Signal is not linked yet.",
        "After this wizard finishes, run `openclaw configure --section channels` in a terminal to link the account.",
        "Signal will not be ready until that linking step succeeds.",
      ].join("\n"),
      "Signal next steps",
    );
  }
  return {
    cfg: writeSignalAccountTransport({
      cfg,
      accountId: params.accountId,
      transport,
    }),
    ...(!managedAccountLinked
      ? {
          credentialValues: {
            [signalSetupStateKeys.linkDeferred]: "true",
          },
        }
      : {}),
  };
}

async function probeManagedSignalSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: ManagedSignalTransport;
  resolvedTransport: ResolvedManagedSignalTransport;
  account: string;
  runtime: SignalFinalizeParams["runtime"];
  prompter: WizardPrompter;
  useTemporaryPort: boolean;
  abortSignal?: AbortSignal;
}): Promise<SignalTransportProbeResult> {
  const progress = params.prompter.progress("Validating Signal setup...");
  let transport = params.transport;
  let resolvedTransport = params.resolvedTransport;
  let daemon: ReturnType<typeof spawnSignalDaemon> | undefined;
  let successfulProbe: SignalTransportProbeResult | undefined;
  let result: SignalTransportProbeResult;
  try {
    if (params.useTemporaryPort) {
      const httpPort = await allocateSignalValidationPort(resolvedTransport.httpHost);
      const baseUrl = buildSignalTransportHttpUrl(resolvedTransport.httpHost, httpPort);
      transport = { ...transport, httpPort, url: baseUrl };
      resolvedTransport = { ...resolvedTransport, httpPort, baseUrl };
    }
    const spawnedDaemon = spawnSignalDaemon({
      cliPath: resolvedTransport.cliPath,
      ...(resolvedTransport.configPath ? { configPath: resolvedTransport.configPath } : {}),
      account: params.account,
      httpHost: resolvedTransport.httpHost,
      httpPort: resolvedTransport.httpPort,
      // Validation must not drain queued messages before the real monitor installs its handler.
      receiveMode: "manual",
      ...(typeof resolvedTransport.ignoreStories === "boolean"
        ? { ignoreStories: resolvedTransport.ignoreStories }
        : {}),
    });
    daemon = spawnedDaemon;
    const startupTimeoutMs = Math.min(120_000, Math.max(1_000, resolvedTransport.startupTimeoutMs));
    await waitForTransportReady({
      label: "signal-cli setup daemon",
      timeoutMs: startupTimeoutMs,
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      runtime: params.runtime,
      check: async () => {
        if (spawnedDaemon.isExited()) {
          throw new Error("signal-cli exited before its HTTP server became ready.");
        }
        const probe = await probeSignalTransport({
          cfg: params.cfg,
          accountId: params.accountId,
          transport,
          account: params.account,
          timeoutMs: 1_000,
        }).catch((error: unknown) => ({ ok: false, error: String(error) }));
        if (probe.ok) {
          successfulProbe = probe;
        }
        return probe;
      },
    });
    params.abortSignal?.throwIfAborted();
    result = successfulProbe ?? { ok: false, error: "Signal transport probe failed." };
  } catch (error) {
    if (params.abortSignal?.aborted) {
      throw params.abortSignal.reason;
    }
    result = { ok: false, error: String(error) };
  } finally {
    await daemon?.stop();
  }
  progress.stop(result.ok ? "Signal setup validated." : "Signal setup validation failed.");
  return result;
}

async function allocateSignalValidationPort(host: string): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not allocate a temporary Signal validation port.");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

function isSameResolvedManagedBind(
  existing: ResolvedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): boolean {
  return (
    existing.kind === "managed-native" &&
    existing.httpHost === candidate.httpHost &&
    existing.httpPort === candidate.httpPort
  );
}

function isSameResolvedManagedTransport(
  existing: ResolvedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): boolean {
  if (existing.kind !== "managed-native") {
    return false;
  }
  return (
    isSameResolvedManagedBind(existing, candidate) &&
    existing.baseUrl === candidate.baseUrl &&
    existing.cliPath === candidate.cliPath &&
    compareSignalCliDataDirectories(existing, candidate) === "same" &&
    existing.startupTimeoutMs === candidate.startupTimeoutMs &&
    existing.receiveMode === candidate.receiveMode &&
    existing.ignoreStories === candidate.ignoreStories
  );
}

async function promptSignalAccount(prompter: WizardPrompter) {
  const raw = await prompter.text({
    message: "Signal phone number",
    placeholder: "+15555550123",
    validate: (value) =>
      normalizeSignalAccountInput(value)
        ? undefined
        : "Enter a Signal phone number in international format, for example +15555550123.",
  });
  const account = normalizeSignalAccountInput(raw);
  if (!account) {
    throw new Error("Signal phone number is required.");
  }
  return account;
}

async function installRequestedSignalCli(params: SignalFinalizeParams, initialCliPath: string) {
  await params.options?.beforePersistentEffect?.();

  let cliPath = initialCliPath;
  try {
    const result = await installSignalCli(params.runtime);
    if (result.ok && result.cliPath) {
      cliPath = result.cliPath;
      await params.prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
    } else {
      await params.prompter.note(result.error ?? "signal-cli install failed.", "Signal");
    }
  } catch (error) {
    await params.prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
  }

  if (await detectBinary(cliPath)) {
    return cliPath;
  }
  return (
    normalizeOptionalString(
      await params.prompter.text({
        message: "signal-cli path",
        initialValue: cliPath,
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    ) ?? cliPath
  );
}

async function prepareManagedNativeSetup(
  params: SignalPrepareParams,
  resolvedTransport: ResolvedSignalTransport,
) {
  let cliPath =
    resolvedTransport.kind === "managed-native" ? resolvedTransport.cliPath : "signal-cli";
  const cliDetected = await detectBinary(cliPath);
  let installRequested = false;

  if (params.options?.allowSignalInstall) {
    installRequested = await params.prompter.confirm({
      message: cliDetected ? "Reinstall signal-cli? (not normally needed)" : "Install signal-cli?",
      initialValue: !cliDetected,
    });
  }

  if (!cliDetected && !installRequested) {
    cliPath =
      normalizeOptionalString(
        await params.prompter.text({
          message: "signal-cli path",
          initialValue: cliPath,
          validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
        }),
      ) ?? cliPath;
  }

  const existingConfigPath =
    resolvedTransport.kind === "managed-native" ? resolvedTransport.configPath : undefined;
  const configLocation = await params.prompter.select<SignalCliConfigLocation>({
    message: "Where should signal-cli store its configuration?",
    options: [
      { value: "default", label: "Use the default location" },
      { value: "custom", label: "Choose a custom directory" },
    ],
    initialValue: existingConfigPath ? "custom" : "default",
  });
  const configPath =
    configLocation === "custom"
      ? normalizeOptionalString(
          await params.prompter.text({
            message: "signal-cli config directory",
            initialValue: existingConfigPath,
            placeholder: "~/.local/share/signal-cli",
            validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
          }),
        )
      : undefined;

  // Validate account-owned port allocation now, while keeping the candidate ephemeral until probe.
  prepareSignalManagedNativeTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    overrides: { cliPath, ...(configPath ? { configPath } : {}) },
  });

  return {
    credentialValues: {
      [signalSetupStateKeys.transportKind]: "managed-native",
      [signalSetupStateKeys.cliPath]: cliPath,
      [signalSetupStateKeys.cliConfigPath]: configPath ?? "",
      ...(installRequested ? { [signalSetupStateKeys.installRequested]: "true" } : {}),
    },
  };
}

async function promptSignalServerUrl(prompter: WizardPrompter, initialValue: string) {
  return (
    normalizeOptionalString(
      await prompter.text({
        message: "Signal server URL",
        initialValue,
        placeholder: "http://127.0.0.1:8080",
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    ) ?? initialValue
  );
}

async function promptExistingSignalTransport(
  params: ExistingServerPromptParams,
): Promise<SignalExistingTransport> {
  let url = await promptSignalServerUrl(
    params.prompter,
    params.initialValue ?? "http://127.0.0.1:8080",
  );
  while (true) {
    const detection = await detectSignalTransport({ url }).then(
      (transport) => ({ ok: true as const, transport }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!detection.ok) {
      await params.prompter.note(
        `OpenClaw could not detect a working Signal server at ${url}.\nError: ${String(detection.error)}`,
        "Signal server URL",
      );
      const recovery = await params.prompter.select<"retry" | "url" | "stop">({
        message: "How should Signal server setup continue?",
        options: [
          { value: "retry", label: "Retry this Signal server URL" },
          { value: "url", label: "Try another Signal server URL" },
          { value: "stop", label: "Stop Signal setup" },
        ],
        initialValue: "retry",
      });
      if (recovery === "stop") {
        throw new WizardCancelledError("Signal setup stopped");
      }
      if (recovery === "url") {
        url = await promptSignalServerUrl(params.prompter, url);
      }
      continue;
    }

    const transport = detection.transport;
    if (transport.kind === "managed-native") {
      throw new Error("Signal transport detection returned a managed-native transport");
    }
    if (!(await aliasesManagedSignalEndpoint(params.cfg, transport.url))) {
      return transport;
    }

    await params.prompter.note(
      [
        "That URL is an OpenClaw-managed Signal daemon.",
        "It stops when its account switches away from local signal-cli.",
        "Enter the URL of an independently operated Signal server instead.",
      ].join("\n"),
      "Signal server URL",
    );
    const recovery = await params.prompter.select<"url" | "stop">({
      message: "How should Signal server setup continue?",
      options: [
        { value: "url", label: "Try another Signal server URL" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "url",
    });
    if (recovery === "stop") {
      throw new WizardCancelledError("Signal setup stopped");
    }
    url = await promptSignalServerUrl(params.prompter, url);
  }
}

async function prepareExistingServerSetup(
  params: SignalPrepareParams,
  resolvedTransport: ResolvedSignalTransport,
) {
  const transport = await promptExistingSignalTransport({
    cfg: params.cfg,
    prompter: params.prompter,
    initialValue:
      resolvedTransport.kind === "external-native" || resolvedTransport.kind === "container"
        ? resolvedTransport.baseUrl
        : "http://127.0.0.1:8080",
  });
  return {
    credentialValues: {
      [signalSetupStateKeys.transportKind]: transport.kind,
      [signalSetupStateKeys.serverUrl]: transport.url,
    },
  };
}
