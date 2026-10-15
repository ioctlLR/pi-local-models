// ~/.pi/agent/extensions/local-models.ts
// Pi extension for local models integration
//
// Configure per-project via .pi/agent/local-models.json:
//   { "url": "http://127.0.0.1:8000", "apiKey": "1234" }
// Or globally: {homedir}/.pi/agent/local-models.json
// - Windows: %USERPROFILE%/.pi/agent/local-models.json
// - macOs/Linux: ~/.pi/agent/local-models.json

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "os";
import { join } from "node:path";

const PROVIDER = "local-model";
const DEFAULT_CTX_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_INPUT: Modality[] = ["text"];

// Pi's thinking levels above "off", least to most intensive
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];
type Modality = "text" | "image";

// Config values are fallbacks: anything the server reports per model takes priority
interface LocalModelsConfig {
    url: string;
    apiKey?: string;
    contextWindow?: number,
    maxTokens?: number,
    reasoning?: boolean,
    input?: Modality[],
}

interface LoadingPayload {
    current?: string;
    stage?: string;
    value?: number;
}

// Reasoning capabilities, as reported by llama-server-router
interface ServerReasoningEffort {
    levels?: string[];
    // How thinking is turned off: "none" -> reasoning_effort "none",
    // "lowest" -> the lowest level, "qwen" -> chat_template_kwargs.enable_thinking false.
    // Absent: thinking cannot be turned off.
    disable?: "none" | "lowest" | "qwen";
    default?: string;
}

// OpenRouter-style per-token prices, as decimal strings
interface ServerPricing {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    cache_write?: string;
}

interface ServerModel {
    id: string;
    state?: string;
    context_length?: number;
    max_model_len?: number;
    max_output_tokens?: number;
    meta?: { n_ctx?: number };
    architecture?: { input_modalities?: string[] };
    reasoning_effort?: ServerReasoningEffort;
    pricing?: ServerPricing;
    payload?: LoadingPayload;
    status?: {
        value?: string;
        failed?: boolean;
        exit_code?: number;
    };
}

function readConfig(cwd: string): LocalModelsConfig {
    // First check home directory
    let file = join(cwd, ".pi", "agent", "local-models.json");
    if (!existsSync(file)) {
        file = join(homedir(), ".pi", "agent", "local-models.json");
    }
    if (!existsSync(file)) {
        throw new Error(`no local-models.json found in ${file}`);
    }

    const raw = readFileSync(file, "utf-8");
    const cfg = JSON.parse(raw);
    let url: string = '';
    let apiKey: string | undefined = undefined;
    let contextWindow: number | undefined = undefined;
    let maxTokens: number | undefined = undefined;
    let input: Modality[] | undefined = undefined;
    let reasoning: boolean | undefined = undefined;
    if (cfg.url) {
        // Remove trailing v1
        url = cfg.url;
        if (url.endsWith('/v1')) {
            url = url.slice(0, -3);
        } else if (url.endsWith('v1')) {
            url = url.slice(0, -2);
        }
    }

    if (cfg.apiKey)
        apiKey = cfg.apiKey;

    if (cfg.contextWindow)
        contextWindow = cfg.contextWindow;

    if (cfg.maxTokens)
        maxTokens = cfg.maxTokens;

    if (cfg.reasoning !== undefined)
        reasoning = !!cfg.reasoning;

    if (cfg.input)
        input = cfg.input;

    return {
        url: url,
        apiKey: apiKey,
        contextWindow: contextWindow,
        maxTokens: maxTokens,
        reasoning: reasoning,
        input: input
    };
}

function openAiApiCall(config: LocalModelsConfig, endpoint: string, method: string, body?: Record<string, unknown>) {
    const hasApiKey = config.apiKey ? true : false;
    const postHeaders = { "Content-Type": "application/json" } as HeadersInit
    const postHeadersWithApiKey = { "Content-Type": "application/json", "x-api-key": config.apiKey } as HeadersInit
    const getHeaders = {} as HeadersInit
    const getHeadersWithApiKey = { "x-api-key": config.apiKey } as HeadersInit

    let headers: HeadersInit;
    headers = getHeaders;
    if (hasApiKey) {
        headers = getHeadersWithApiKey;
    }
    if (method === 'POST') {
        if (hasApiKey)
            headers = postHeadersWithApiKey;
        else
            headers = postHeaders
    }

    return fetch(`${config.url}${endpoint}`, {
        method: method,
        headers: headers,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json();
    });
}

async function listModels(config: LocalModelsConfig): Promise<ServerModel[]> {
    const data = (await openAiApiCall(config, "/v1/models", "GET")) as {
        data?: ServerModel[];
    };
    return (data.data ?? []);
}

export default async function (pi: ExtensionAPI) {
    const config = readConfig(process.cwd());
    const serverModels = await listModels(config).catch((): ServerModel[] => []);
    if (serverModels.length === 0) {
        console.log("\x1b[31m", "local-models: " + "No local models were discovered");
        return;
    }

    console.log('\x1b[36m%s\x1b[0m', "local-models: " + serverModels.length + " local models were discovered, type /model to select a [local-model]");

    const models = serverModels.map((m) => ({
        id: String(m.id),
        name: String(m.id),
        input: inputModalities(m) ?? config.input ?? DEFAULT_INPUT,
        contextWindow: m.context_length ?? m.max_model_len ?? m.meta?.n_ctx ?? config.contextWindow ?? DEFAULT_CTX_WINDOW,
        maxTokens: m.max_output_tokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
        cost: cost(m.pricing),
        ...reasoning(m, config),
    }));

    pi.registerProvider(PROVIDER, {
        baseUrl: `${config.url}/v1`,
        api: "openai-completions",
        apiKey: config.apiKey ?? "not-needed",
        models
    });

    // Apply the server's default effort when a local model is picked or a fresh session starts on one.
    // It ranks below anything the user chose: --thinking, a "model:level" suffix, or a per-model
    // level saved in pi settings. Restored sessions keep their own level.
    const defaults = new Map<string, EffortLevel>();
    for (const m of serverModels) {
        const level = m.reasoning_effort?.default;
        if (isEffortLevel(level) && m.reasoning_effort?.levels?.includes(level))
            defaults.set(String(m.id), level);
    }
    const applyDefault = (modelId: string, ctx: ExtensionContext) => {
        const level = defaults.get(modelId);
        if (level && !userThinkingLevelFor(ctx, modelId))
            pi.setThinkingLevel(level);
    };
    pi.on("model_select", (event, ctx) => {
        if (event.source !== "restore" && event.model.provider === PROVIDER)
            applyDefault(event.model.id, ctx);
    });
    pi.on("session_start", (event, ctx) => {
        if ((event.reason !== "startup" && event.reason !== "new") || ctx.model?.provider !== PROVIDER)
            return;
        if (thinkingLevelFromArgs() || ctx.sessionManager.getEntries().some((e) => e.type === "message"))
            return;
        applyDefault(ctx.model.id, ctx);
    });
};

function isEffortLevel(level: unknown): level is EffortLevel {
    return EFFORT_LEVELS.includes(level as EffortLevel);
}

// A thinking level given on the command line, via --thinking or a --model "id:level" suffix
function thinkingLevelFromArgs(): string | undefined {
    const args = process.argv;
    for (let i = 0; i < args.length - 1; i++) {
        const value = args[i + 1];
        if (args[i] === "--thinking")
            return value;
        if (args[i] === "--model") {
            const suffix = value.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
            if (suffix)
                return suffix[1];
        }
    }
    return undefined;
}

// The per-model thinking level saved in pi settings. Project settings win over global ones,
// and count only when pi trusts the project.
function userThinkingLevelFor(ctx: ExtensionContext, modelId: string): string | undefined {
    const key = `${PROVIDER}/${modelId}`;
    const files = [join(homedir(), ".pi", "agent", "settings.json")];
    if (ctx.isProjectTrusted())
        files.unshift(join(ctx.cwd, ".pi", "settings.json"));
    for (const file of files) {
        try {
            const level = JSON.parse(readFileSync(file, "utf-8")).modelThinkingLevels?.[key];
            if (typeof level === "string")
                return level;
        } catch {
            // Missing or unreadable settings: nothing saved there
        }
    }
    return undefined;
}

function inputModalities(m: ServerModel): Modality[] | undefined {
    const reported = m.architecture?.input_modalities;
    if (!reported)
        return undefined;
    const input = reported.filter((x): x is Modality => x === "text" || x === "image");
    return input.length > 0 ? input : undefined;
}

// Server prices are per token; pi wants per million tokens
function cost(pricing?: ServerPricing) {
    const perMillion = (price?: string) => {
        const n = Number(price);
        return Number.isFinite(n) && n > 0 ? Number((n * 1e6).toPrecision(12)) : 0;
    };
    return {
        input: perMillion(pricing?.prompt),
        output: perMillion(pricing?.completion),
        cacheRead: perMillion(pricing?.input_cache_read),
        cacheWrite: perMillion(pricing?.cache_write),
    };
}

// Without a server-reported reasoning surface, fall back to the config's on/off flag with pi's default levels
function reasoning(m: ServerModel, config: LocalModelsConfig) {
    const levels = (m.reasoning_effort?.levels ?? []).filter(isEffortLevel);
    if (levels.length === 0) {
        return {
            reasoning: config.reasoning ?? false,
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
            }
        };
    }

    // Only the server's levels are offered; null hides a level from pi's selector
    const thinkingLevelMap: Record<string, string | null> = {};
    for (const level of EFFORT_LEVELS)
        thinkingLevelMap[level] = levels.includes(level) ? level : null;

    const disable = m.reasoning_effort?.disable;
    if (disable === "none")
        thinkingLevelMap.off = "none";
    else if (disable === "lowest")
        thinkingLevelMap.off = levels[0];
    else if (disable !== "qwen")
        thinkingLevelMap.off = null;

    if (disable === "qwen") {
        // Thinking is toggled through the chat template; the effort level is not sent
        return {
            reasoning: true,
            thinkingLevelMap,
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
                thinkingFormat: "chat-template" as const,
                chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" as const } },
            }
        };
    }

    return {
        reasoning: true,
        thinkingLevelMap,
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            thinkingFormat: "openai" as const,
        }
    };
}