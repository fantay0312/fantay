import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tokenToSeaMediaAssets, type PaSpeechMime, type PaSpeechModel, type PaSpeechStatus, type PaVoice } from "@open-design/contracts";
import type { TokenToSeaModel } from "../integrations/tokentosea-runtime.js";

/** Read-aloud for companion replies. The soul service talks to this port only; the production port renders through
 *  the existing media pipeline and is attached by the server, so tests attach a fake. */
export interface PaSpeechPort {
  status(): Promise<PaSpeechStatus>;
  voices(model: string): Promise<Array<{ id: string; name: string }>>;
  synthesize(input: { model: string; voice: string; language: string; text: string }):
    Promise<{ bytes: Buffer; ext: "mp3" | "wav" | "ogg" | "m4a"; mime: PaSpeechMime }>;
}

/** Providers for which `generateMediaInternal` (../media/index.ts) has a speech renderer. */
export const PA_SPEECH_PROVIDERS: ReadonlySet<string> = new Set([
  "openai", "aihubmix", "grok", "elevenlabs", "minimax", "senseaudio", "fishaudio",
]);

/** The audio container by magic bytes; null for anything else (a stub placeholder, an error page, garbage). */
export function sniffPaAudio(bytes: Uint8Array): { ext: "mp3" | "wav" | "ogg" | "m4a"; mime: PaSpeechMime } | null {
  const at = (index: number) => bytes[index] ?? -1;
  const ascii = (from: number, text: string) => [...text].every((char, index) => at(from + index) === char.charCodeAt(0));
  if (ascii(0, "ID3") || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0)) return { ext: "mp3", mime: "audio/mpeg" };
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return { ext: "wav", mime: "audio/wav" };
  if (ascii(0, "OggS")) return { ext: "ogg", mime: "audio/ogg" };
  if (ascii(4, "ftyp")) return { ext: "m4a", mime: "audio/mp4" };
  return null;
}

// ---- TokenToSea ------------------------------------------------------------------------------------------------------
// The signed-in TokenToSea account brings speech models of its own (MiniMax Speech, CosyVoice, Qwen-Audio TTS …), so
// read-aloud works without a provider key. A model is offered when the account catalogue publishes a verified JSON
// speech operation for it; the request is that operation's own example with the text and the voice replaced.

/** The slice of TokenToSeaRuntime this port uses (a test passes a fake). */
export interface PaSpeechAccount {
  current(): { user: unknown } | null;
  identityKey?(): string;
  models(): Promise<TokenToSeaModel[]>;
  json<T>(resource: string, method?: "GET" | "POST", body?: unknown, query?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  authorizationBudget(): Promise<number>;
}
export interface PaTokenToSeaSpeechOperation {
  model: TokenToSeaModel; path: string; body: Record<string, unknown>;
  textField: "input" | "text"; voiceField: "voice" | "voice_id" | null; voices: string[];
}

const TOKENTOSEA_PREFIX = "tokentosea/";
const TOKENTOSEA_SPEECH_PATHS: readonly string[] = ["/v1/audio/speech", "/v1/tools/tts"];
/** The default voice of a character that has none: the first of these the account offers, else its first speech model. */
const TOKENTOSEA_DEFAULT_SPEECH: readonly string[] = ["cosyvoice-v3-flash", "cosyvoice-v2", "qwen-audio-3.0-tts-flash", "speech-2.8-turbo", "speech-02-turbo"];
const TOKENTOSEA_SPEECH_WAIT_MS = 80000;
const TOKENTOSEA_SPEECH_MAX_USD = 1;                       // a reply of SOUL_LIMITS.speechChars costs a fraction of this
const TOKENTOSEA_SPEECH_MAX_BYTES = 40 * 1024 * 1024;
const TOKENTOSEA_STATUS_TTL_MS = 10 * 60000;               // the speech status is read every minute; the catalogue is large

/** The verified speech operation of a catalogue model, or null: a model that needs a cloned voice or a prompt-style
 *  request (an example with requirements or `{{PLACEHOLDER}}`s, or without a plain text field) is not offered. */
export function tokenToSeaSpeechOperation(model: TokenToSeaModel): PaTokenToSeaSpeechOperation | null {
  if (model.modality !== "speech" || model.executionKind !== "official" || model.available === false) return null;
  if (typeof model.status === "string" && model.status !== "active") return null;
  for (const example of model.examples ?? []) {
    const body = example.body;
    if (!TOKENTOSEA_SPEECH_PATHS.includes(example.path) || example.mode !== "json" || !body || typeof body !== "object") continue;
    const requirements = (example as { requirements?: unknown }).requirements;
    if ((Array.isArray(requirements) && requirements.length > 0) || /\{\{[A-Z_]+\}\}/.test(JSON.stringify(body))) continue;
    const textField = (["input", "text"] as const).find(key => typeof body[key] === "string");
    if (!textField) continue;
    const voiceField = (["voice", "voice_id"] as const).find(key => typeof body[key] === "string") ?? null;
    const listed = Array.isArray(model.systemVoices) ? model.systemVoices.filter((voice): voice is string => typeof voice === "string" && voice.length > 0 && voice.length <= 200) : [];
    return { model, path: example.path, body, textField, voiceField, voices: voiceField ? listed.slice(0, 500) : [] };
  }
  return null;
}

/** The account's speech models as the editor lists them, and the voice a character without one is read with. */
export async function tokenToSeaSpeechStatus(account: PaSpeechAccount | undefined): Promise<{ models: PaSpeechModel[]; default: PaVoice | null }> {
  if (!account?.current()?.user) return { models: [], default: null };
  const operations = (await account.models().catch(() => [])).map(tokenToSeaSpeechOperation)
    .filter((operation): operation is PaTokenToSeaSpeechOperation => operation !== null);
  const models = operations.map(operation => ({
    id: `${TOKENTOSEA_PREFIX}${operation.model.model}`,
    label: `TokenToSea · ${operation.model.name ?? operation.model.model}`,
    provider: "tokentosea",
    configured: true,
    // One published voice is the service's default; with more, the editor shows them as a list.
    voices: operation.voices.length > 1 ? "list" as const : "free" as const,
  }));
  const preferred = TOKENTOSEA_DEFAULT_SPEECH.map(id => operations.find(operation => operation.model.model === id)).find(Boolean) ?? operations[0];
  return { models, default: preferred ? { model: `${TOKENTOSEA_PREFIX}${preferred.model.model}`, voice: "", language: "" } : null };
}

async function tokenToSeaOperation(account: PaSpeechAccount, modelId: string): Promise<PaTokenToSeaSpeechOperation> {
  const name = modelId.slice(TOKENTOSEA_PREFIX.length);
  const operation = (await account.models()).filter(model => model.model === name).map(tokenToSeaSpeechOperation).find(Boolean);
  if (!operation) throw new Error("this TokenToSea speech model is not available to the account");
  return operation;
}

/** One speech generation billed to the TokenToSea account: prepare, invoke, wait, then download the archived audio. */
export async function synthesizeTokenToSeaSpeech(account: PaSpeechAccount, input: { model: string; voice: string; text: string }): Promise<Buffer> {
  const operation = await tokenToSeaOperation(account, input.model);
  const signal = AbortSignal.timeout(TOKENTOSEA_SPEECH_WAIT_MS);
  const body: Record<string, unknown> = { ...structuredClone(operation.body), [operation.textField]: input.text };
  if ("model" in body) body.model = operation.model.model;
  if (input.voice && operation.voiceField) body[operation.voiceField] = input.voice;
  const budget = await account.authorizationBudget();
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("the TokenToSea balance or authorization is used up");
  const payload = { input: body };
  const prepared = await account.json<{ id: string }>("official/prepare", "POST", {
    model: operation.model.model, priceVersion: operation.model.priceVersion, path: operation.path, mode: "json",
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), requestKey: randomUUID(),
    maxCostUsd: Math.min(budget, TOKENTOSEA_SPEECH_MAX_USD).toFixed(6),
  }, {}, signal);
  if (!/^[\w-]+$/.test(String(prepared.id ?? ""))) throw new Error("TokenToSea answered with an invalid speech run");
  const resource = `official/runs/${prepared.id}`;
  try {
    await account.json(`${resource}/invoke`, "POST", payload, {}, signal);
    for (;;) {
      const run = await account.json<{ status: string; output?: unknown }>(resource, "GET", undefined, {}, signal);
      if (run.status === "succeeded") {
        const [asset] = tokenToSeaMediaAssets(run.output, ["audio/"]);
        if (!asset) throw new Error("the TokenToSea speech run returned no audio");
        const signed = await account.json<{ url: string }>(`${resource}/assets/${asset}`, "GET", undefined, {}, signal);
        const url = new URL(signed.url);
        if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.endsWith(".myqcloud.com"))
          throw new Error("unexpected TokenToSea audio origin");
        const response = await fetch(url, { redirect: "error", signal });
        if (!response.ok || !response.body) throw new Error("the TokenToSea audio could not be downloaded");
        const reader = response.body.getReader(), chunks: Buffer[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > TOKENTOSEA_SPEECH_MAX_BYTES) throw new Error("the TokenToSea audio is too large");
            chunks.push(Buffer.from(chunk.value));
          }
        } finally { await reader.cancel().catch(() => undefined); }
        return Buffer.concat(chunks);
      }
      if (["failed", "needs_review", "canceled", "cancelled", "expired"].includes(run.status))
        throw new Error(`the TokenToSea speech run ${run.status}`);
      await delay(500, undefined, { signal });
    }
  } finally {
    if (signal.aborted) await account.json(`${resource}/cancel`, "POST", {}).catch(() => undefined);
  }
}

/** The production port. Every media import is dynamic, so constructing the PA service never loads the media stack.
 *  TokenToSea's speech models come first and give the default voice; the media providers set up in Settings follow. */
export function createPaSpeech(deps: { projectRoot: string; dataDir: string; account?: () => PaSpeechAccount | undefined }): PaSpeechPort {
  const { projectRoot, dataDir } = deps;
  const account = async (): Promise<PaSpeechAccount | undefined> =>
    deps.account ? deps.account() : (await import("../integrations/tokentosea-runtime.js")).optionalTokenToSeaRuntime();
  type CloudStatus = Awaited<ReturnType<typeof tokenToSeaSpeechStatus>>;
  let cloudCache: { key: string; at: number; value: CloudStatus } | null = null;
  /** The account's speech models, kept per signed-in identity for TOKENTOSEA_STATUS_TTL_MS (an empty answer is not kept). */
  const cloudStatus = async (): Promise<CloudStatus> => {
    const signedIn = await account();
    if (!signedIn?.current()?.user) return { models: [], default: null };
    const key = signedIn.identityKey?.() ?? "account";
    if (cloudCache && cloudCache.key === key && Date.now() - cloudCache.at < TOKENTOSEA_STATUS_TTL_MS) return cloudCache.value;
    const value = await tokenToSeaSpeechStatus(signedIn);
    if (value.models.length) cloudCache = { key, at: Date.now(), value };
    return value;
  };
  return {
    async status() {
      const [{ AUDIO_MODELS_BY_KIND, MEDIA_PROVIDERS }, { readMaskedConfig }] = await Promise.all([
        import("../media/models.js"), import("../media/config.js"),
      ]);
      const [config, cloud] = await Promise.all([readMaskedConfig(projectRoot), cloudStatus()]);
      const models = AUDIO_MODELS_BY_KIND.speech
        .filter(model => PA_SPEECH_PROVIDERS.has(model.provider))
        .map(model => ({
          id: model.id,
          label: `${MEDIA_PROVIDERS.find(provider => provider.id === model.provider)?.label ?? model.provider} · ${model.label}`,
          provider: model.provider,
          configured: Boolean(config.providers[model.provider]?.configured),
          voices: model.provider === "elevenlabs" ? "list" as const : "free" as const,
        }));
      const all = [...cloud.models, ...models];
      return { available: all.some(model => model.configured), models: all, default: cloud.default };
    },
    async voices(model) {
      if (model.startsWith(TOKENTOSEA_PREFIX)) {
        const signedIn = await account();
        if (!signedIn?.current()?.user) return [];
        return (await tokenToSeaOperation(signedIn, model)).voices.map(voice => ({ id: voice, name: voice }));
      }
      const { findMediaModel } = await import("../media/models.js");
      if (findMediaModel(model)?.provider !== "elevenlabs") return [];
      const [{ listElevenLabsVoiceOptions }, { proxyDispatcherRequestInit }] = await Promise.all([
        import("../integrations/elevenlabs-voices.js"), import("../connectionTest.js"),
      ]);
      const proxy = proxyDispatcherRequestInit(process.env);
      try {
        const options = await listElevenLabsVoiceOptions(projectRoot, { limit: 100, requestInit: proxy.requestInit });
        return options.map(option => ({ id: option.voiceId, name: option.name }));
      } finally {
        await proxy.close().catch(() => undefined);
      }
    },
    async synthesize({ model, voice, language, text }) {
      if (model.startsWith(TOKENTOSEA_PREFIX)) {
        const signedIn = await account();
        if (!signedIn?.current()?.user) throw new Error("sign in to TokenToSea to use its speech models");
        const bytes = await synthesizeTokenToSeaSpeech(signedIn, { model, voice, text });
        const kind = sniffPaAudio(bytes);
        if (!kind) throw new Error("unrecognised audio");
        return { bytes, ...kind };
      }
      const [{ generateMedia }, { proxyDispatcherRequestInit }] = await Promise.all([
        import("../media/index.js"), import("../connectionTest.js"),
      ]);
      const work = path.join(dataDir, "pa", "soul", "speech-work");
      const projectId = `s${randomUUID().replace(/-/g, "")}`;
      const proxy = proxyDispatcherRequestInit(process.env);
      try {
        const file = await generateMedia({
          projectRoot, projectsRoot: work, projectId, surface: "audio", audioKind: "speech",
          model, prompt: text, voice, language, output: "speech.mp3", requestInit: proxy.requestInit,
        });
        // A stub is never served as a voice, whatever OD_MEDIA_ALLOW_STUBS says.
        if (file.usedStubFallback || file.intentionalStub || file.providerError)
          throw new Error(file.providerError || "the speech service returned no audio");
        const bytes = await readFile(path.join(work, projectId, file.name));
        const kind = sniffPaAudio(bytes);
        if (!kind) throw new Error("unrecognised audio");
        return { bytes, ...kind };
      } finally {
        await proxy.close().catch(() => undefined);
        await rm(path.join(work, projectId), { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
