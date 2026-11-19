import { readFileSync } from "node:fs";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { paModelSchema } from "@open-design/contracts";
import { SOUL_LIMITS, paStateOpInputSchema } from "@open-design/contracts/soul";
import type { PersonalAgentService } from "../services/personal-agent-service.js";
import { PaError } from "../storage/personal-agent-store.js";

/** One byte range of `size` bytes from a `Range` header: null for no header, 'bad' for a range that cannot be served. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "bad" | null {
  if (header === undefined) return null;
  const open = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  const suffix = /^bytes=-(\d+)$/.exec(header.trim());
  let start: number, end: number;
  if (open) {
    start = Number(open[1]);
    end = open[2] ? Math.min(Number(open[2]), size - 1) : size - 1;
  } else if (suffix) {
    const length = Number(suffix[1]);
    if (!length) return "bad";
    start = Math.max(0, size - length);
    end = size - 1;
  } else return "bad";
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "bad";
  return { start, end };
}

/** Soul routes under /api/pa/soul. Registered from the end of registerPersonalAgentRoutes, so the loopback and origin
 *  gate and the enterprise allowlist run first. */
export function registerPersonalAgentSoulRoutes(app: Express, deps: {
  service: PersonalAgentService;
  handle: (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response) => Promise<void>;
  revision: { parse(value: unknown): number };
}): void {
  const { service, handle, revision } = deps;
  const soul = service.soul;
  const id = z.string().min(1).max(100);
  const requestId = z.string().min(8).max(100);
  const conversationId = z.string().min(1).max(100);
  const respond = z.boolean().optional();
  const base64Max = Math.ceil(SOUL_LIMITS.assetBytes / 3) * 4 + 64;
  const assetBody = z.object({
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    data: z.string().min(1).max(base64Max),
  }).strict();
  const revisionOnly = z.object({ revision: z.unknown() }).strict();
  const empty = z.object({}).strict();

  const param = (req: Request, name: string): string => id.parse(req.params[name]);
  const body = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  /** Splits `revision` off a record body (the record schemas are strict). */
  const split = (req: Request): { version: unknown; rest: Record<string, unknown> } => {
    const { revision: version, ...rest } = body(req);
    return { version, rest };
  };
  const optionalRevision = (value: unknown): number | undefined => (value === undefined ? undefined : revision.parse(value));
  const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
    (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
  /** Enterprise mode: the member the access gate authenticated. Their id scopes personas and new conversations. */
  const principalOf = (req: Request): string | undefined => (req.res?.locals.paMember as { id: string } | undefined)?.id;

  app.get("/api/pa/soul", handle(req => {
    const snapshot = soul.snapshot(principalOf(req));
    // Characters the organization published for other groups are not part of this member's library.
    const member = req.res?.locals.paMember as { role: string; groups: string[] } | undefined;
    const hidden = member && member.role !== "admin" ? service.hiddenAgents(member.groups) : null;
    return hidden?.size ? { ...snapshot, characters: snapshot.characters.filter(character => !hidden.has(character.id)) } : snapshot;
  }));

  // ---- characters ------------------------------------------------------------------------------------------------
  app.post("/api/pa/soul/characters/import", handle(req => {
    const input = z.object({
      card: z.unknown(),
      fileName: z.string().max(255).optional(),
      portrait: assetBody.optional(),
      model: paModelSchema.optional(),
      agentId: id.optional(),
      revision: z.unknown().optional(),
      sprites: z.record(z.string().max(100)).optional(),
    }).strict().parse(body(req));
    return soul.importCard({
      card: input.card,
      ...optional("fileName", input.fileName),
      ...optional("portrait", input.portrait),
      ...optional("model", input.model),
      ...optional("agentId", input.agentId),
      ...optional("revision", optionalRevision(input.revision)),
      ...optional("sprites", input.sprites),
      ...optional("principalId", principalOf(req)),
    });
  }));
  app.put("/api/pa/soul/characters/:agentId", handle(req => {
    const { version, rest } = split(req);
    return soul.saveCharacter(param(req, "agentId"), rest, optionalRevision(version));
  }));
  app.delete("/api/pa/soul/characters/:agentId", handle(req => {
    const input = z.object({ revision: z.unknown(), forgetMemories: z.boolean().optional() }).strict().parse(body(req));
    return soul.removeCharacter(param(req, "agentId"), revision.parse(input.revision), input.forgetMemories === true);
  }));
  app.get("/api/pa/soul/characters/:agentId/export", handle(req =>
    soul.exportCard(param(req, "agentId"), req.query.quarantine === "1")));
  app.post("/api/pa/soul/starters/:id/install", handle(req => {
    empty.parse(body(req));
    return soul.installStarter(param(req, "id"), principalOf(req));
  }));

  // ---- lorebooks -------------------------------------------------------------------------------------------------
  app.post("/api/pa/soul/lorebooks/import", handle(req => {
    const input = z.object({
      world: z.unknown(),
      name: z.string().max(SOUL_LIMITS.lorebookName).optional(),
      fileName: z.string().max(255).optional(),
      agentId: id.optional(),
    }).strict().parse(body(req));
    return soul.importWorld({
      world: input.world,
      ...optional("name", input.name),
      ...optional("fileName", input.fileName),
      ...optional("agentId", input.agentId),
    });
  }));
  app.post("/api/pa/soul/lorebooks/test", handle(req => {
    const input = z.object({
      lorebook: z.unknown().optional(),
      lorebookId: id.optional(),
      messages: z.array(z.string().max(SOUL_LIMITS.loreRegexInput)).max(20),
      index: z.number().int().min(0).max(1_000_000).optional(),
      names: z.object({ char: z.string().max(200), user: z.string().max(200) }).strict().optional(),
    }).strict().parse(body(req));
    return soul.testLorebook({
      messages: input.messages,
      ...optional("lorebook", input.lorebook),
      ...optional("lorebookId", input.lorebookId),
      ...optional("index", input.index),
      ...optional("names", input.names),
    });
  }));
  app.post("/api/pa/soul/lorebooks", handle(req => soul.saveLorebook(body(req))));
  app.get("/api/pa/soul/lorebooks/:id", handle(req => soul.lorebook(param(req, "id"))));
  app.patch("/api/pa/soul/lorebooks/:id", handle(req => {
    const { version, rest } = split(req);
    return soul.saveLorebook(rest, param(req, "id"), revision.parse(version));
  }));
  app.delete("/api/pa/soul/lorebooks/:id", handle(req =>
    soul.removeLorebook(param(req, "id"), revision.parse(revisionOnly.parse(body(req)).revision))));
  app.get("/api/pa/soul/lorebooks/:id/export", handle(req => soul.exportWorld(param(req, "id"))));

  // ---- personas and presets --------------------------------------------------------------------------------------
  app.post("/api/pa/soul/personas", handle(req => soul.savePersona(body(req), undefined, undefined, principalOf(req))));
  app.patch("/api/pa/soul/personas/:id", handle(req => {
    const { version, rest } = split(req);
    return soul.savePersona(rest, param(req, "id"), revision.parse(version), principalOf(req));
  }));
  app.delete("/api/pa/soul/personas/:id", handle(req =>
    soul.removePersona(param(req, "id"), revision.parse(revisionOnly.parse(body(req)).revision), principalOf(req))));
  app.post("/api/pa/soul/presets", handle(req => soul.savePreset(body(req))));
  app.patch("/api/pa/soul/presets/:id", handle(req => {
    const { version, rest } = split(req);
    return soul.savePreset(rest, param(req, "id"), revision.parse(version));
  }));
  app.delete("/api/pa/soul/presets/:id", handle(req =>
    soul.removePreset(param(req, "id"), revision.parse(revisionOnly.parse(body(req)).revision))));

  // ---- chats -----------------------------------------------------------------------------------------------------
  app.put("/api/pa/soul/chats/:conversationId", handle(req => {
    const { version, rest } = split(req);
    return soul.saveChat(param(req, "conversationId"), rest, optionalRevision(version));
  }));
  app.post("/api/pa/soul/chat/state", handle(req => {
    const input = z.object({
      conversationId,
      ops: z.array(paStateOpInputSchema).min(1).max(SOUL_LIMITS.stateOpsPerCall),
    }).strict().parse(body(req));
    return soul.applyStateOps(input.conversationId, input.ops);
  }));
  app.post("/api/pa/soul/chat/regenerate", handle(req => {
    const input = z.object({ conversationId, messageId: id, requestId }).strict().parse(body(req));
    return soul.regenerate(input.conversationId, input.messageId, input.requestId);
  }));
  app.post("/api/pa/soul/chat/continue", handle(req => {
    const input = z.object({
      conversationId, requestId, agentId: id.optional(), directive: z.enum(["continue", "reachout"]).optional(),
    }).strict().parse(body(req));
    return soul.continueChat(input.conversationId, input.requestId, input.agentId, input.directive ?? "continue");
  }));
  app.post("/api/pa/soul/chat/roll", handle(req => {
    const input = z.object({
      conversationId, requestId, respond,
      notation: z.string().min(1).max(20),
      label: z.string().max(40).optional(),
      dc: z.number().int().min(1).max(999).optional(),
    }).strict().parse(body(req));
    return soul.roll(input.conversationId, {
      notation: input.notation, requestId: input.requestId,
      ...optional("label", input.label),
      ...optional("dc", input.dc),
      ...optional("respond", input.respond),
    });
  }));
  app.post("/api/pa/soul/chat/draw", handle(req => {
    const input = z.object({ conversationId, requestId, respond, deckId: z.string().min(1).max(40) }).strict().parse(body(req));
    return soul.draw(input.conversationId, { deckId: input.deckId, requestId: input.requestId, ...optional("respond", input.respond) });
  }));
  app.post("/api/pa/soul/chat/event", handle(req => {
    const input = z.object({
      conversationId, requestId, respond, action: z.enum(["draw", "accept", "skip", "stop"]),
    }).strict().parse(body(req));
    return soul.eventAction(input.conversationId, { action: input.action, requestId: input.requestId, ...optional("respond", input.respond) });
  }));
  app.post("/api/pa/soul/chat/preview", handle(req => {
    const input = z.object({
      conversationId, draft: z.string().max(SOUL_LIMITS.messageContent).optional(), agentId: id.optional(),
    }).strict().parse(body(req));
    return soul.preview(input.conversationId, { ...optional("draft", input.draft), ...optional("agentId", input.agentId) });
  }));
  app.get("/api/pa/soul/trace/:messageId", handle(req => soul.trace(param(req, "messageId"))));
  app.post("/api/pa/soul/conversations/:id/branch", handle(req => {
    const input = z.object({ messageId: id }).strict().parse(body(req));
    return soul.branch(param(req, "id"), input.messageId);
  }));

  // ---- messages --------------------------------------------------------------------------------------------------
  app.patch("/api/pa/soul/messages/:id", handle(req => {
    const input = z.object({
      revision: z.unknown(),
      content: z.string().min(1).max(SOUL_LIMITS.messageContent).optional(),
      hidden: z.boolean().optional(),
    }).strict().parse(body(req));
    return soul.editMessage(param(req, "id"), {
      ...optional("content", input.content), ...optional("hidden", input.hidden),
    }, revision.parse(input.revision));
  }));
  app.delete("/api/pa/soul/messages/:id", handle(req => {
    const input = z.object({ revision: z.unknown(), forget: z.boolean().optional() }).strict().parse(body(req));
    return soul.deleteMessage(param(req, "id"), revision.parse(input.revision), input.forget === true);
  }));
  app.post("/api/pa/soul/messages/:id/variant", handle(req => {
    const input = z.union([
      z.object({ messageId: id }).strict(),
      z.object({ greetingIndex: z.number().int().min(0).max(SOUL_LIMITS.alternateGreetings) }).strict(),
    ]).parse(body(req));
    return soul.selectVariant(param(req, "id"), input);
  }));
  app.post("/api/pa/soul/messages/:id/reveal", handle(req => {
    empty.parse(body(req));
    return soul.revealDraw(param(req, "id"));
  }));

  // ---- speech (read aloud) ---------------------------------------------------------------------------------------
  app.get("/api/pa/soul/speech/status", handle(() => soul.speechStatus()));
  app.get("/api/pa/soul/speech/voices", handle(req =>
    soul.speechVoices(z.string().min(1).max(120).parse(req.query.model))));
  app.get("/api/pa/soul/speech", handle(async req => {
    const conversation = conversationId.parse(req.query.conversationId);
    // The status read brings the default voice, which decides whether the audio of a character without one is current.
    await soul.speechStatus().catch(() => undefined);
    return { items: soul.listSpeech(conversation) };
  }));
  app.post("/api/pa/soul/speech", handle(req =>
    soul.speak(z.object({ messageId: id }).strict().parse(body(req)).messageId)));
  // 试听: registered before `/speech/:id`; previewSpeech parses the body with paSpeechPreviewInputSchema.
  app.post("/api/pa/soul/speech/preview", handle(req => soul.previewSpeech(body(req))));
  app.get("/api/pa/soul/speech/:id", handle((req, res) => {
    // readSpeech validates the id with paSpeechIdSchema before any path join.
    const audio = soul.readSpeech(String(req.params.id ?? ""));
    let bytes: Buffer;
    try {
      bytes = readFileSync(audio.file);
    } catch {
      throw new PaError("语音不存在", 404, "PA_NOT_FOUND");
    }
    res.setHeader("Content-Type", audio.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Accept-Ranges", "bytes");
    const range = byteRange(req.get("range"), bytes.length);
    if (range === "bad") {
      res.status(416).setHeader("Content-Range", `bytes */${bytes.length}`);
      res.end();
    } else if (range) {
      res.status(206).setHeader("Content-Range", `bytes ${range.start}-${range.end}/${bytes.length}`);
      res.send(bytes.subarray(range.start, range.end + 1));
    } else res.send(bytes);
  }));

  // ---- assets ----------------------------------------------------------------------------------------------------
  app.post("/api/pa/soul/assets", handle(req => soul.saveAsset(assetBody.parse(body(req)))));
  app.get("/api/pa/soul/assets/:id", handle((req, res) => {
    // readAsset validates the id with paAssetIdSchema before any path join.
    const asset = soul.readAsset(String(req.params.id ?? ""));
    res.setHeader("Content-Type", asset.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(asset.bytes);
  }));
}
