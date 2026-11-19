// SPDX-License-Identifier: Apache-2.0
// The Personal Agent on the memory engine: what each kind of turn reads, what a finished task writes back, how a
// changed memory stops answers built on it, persona mount, conflicts and background distillation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PaAttempt,
  type PaEpisode,
  type PaMemoryCandidate,
  type PaMessage,
  type PaTask,
  paTaskInputSchema,
  type PersonalAgent,
} from "@open-design/contracts";

import { closeDatabase, openDatabase, type SqliteDb } from "../src/db.js";
import type { PaModelResult, PaModelRuntime } from "../src/runtimes/personal-agent.js";
import { PersonalAgentService } from "../src/services/personal-agent-service.js";

let dir: string, db: SqliteDb, service: PersonalAgentService;
const execute = vi.fn<PaModelRuntime["execute"]>();
const result = (text: string): PaModelResult => ({ text, usage: { visibility: "unknown" } });
function create(extra: { memoryLearnDelayMs?: number } = {}) {
  return new PersonalAgentService({
    db, dataDir: dir, projectsDir: join(dir, "projects"), runtime: { models: async () => [], execute }, ...extra,
  });
}
const agents = () => service.store.list<PersonalAgent>("agents");
const fantay = () => agents().find((agent) => agent.avatar === "fantay")!;
const reviewer = () => agents().find((agent) => agent.name === "审阅者")!;
const direct = () => service.snapshot().conversations.find((item) => item.agentId === fantay().id && !item.groupId)!;
function submit(conversationId: string, goal: string, extra: Record<string, unknown> = {}): PaTask {
  return service.submit(paTaskInputSchema.parse({ requestId: crypto.randomUUID(), conversationId, goal, ...extra }));
}
async function done(task: PaTask): Promise<PaTask> {
  await vi.waitFor(() => expect(["completed", "failed", "waiting", "cancelled"]).toContain(
    service.store.require<PaTask>("tasks", task.id).status,
  ));
  const settled = service.store.require<PaTask>("tasks", task.id);
  expect(settled.status, settled.waitingReason ?? settled.error ?? "").toBe("completed");
  return settled;
}
const lastPrompt = () => execute.mock.lastCall![1];
const prompts = () => execute.mock.calls.map((call) => call[1]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pa-memory-"));
  db = openDatabase(dir, { dataDir: dir });
  execute.mockReset();
  execute.mockResolvedValue(result("A useful answer"));
  service = create();
});
afterEach(async () => {
  await service.shutdown();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

describe("PA memory on the engine", () => {
  it("keeps an answer in context when its memory is pinned and drops it once the text is corrected", async () => {
    const memory = service.saveMemory({ content: "The brand colour is teal", source: "owner", scope: "agent", scopeId: fantay().id });
    execute.mockResolvedValueOnce(result("TEAL_ANSWER use teal"));
    await done(submit(direct().id, "What is the brand colour?"));
    const answer = service.store.listConversationMessages<PaMessage>(direct().id).find((m) => m.content.includes("TEAL_ANSWER"))!;
    expect(answer.memoryRefs?.map((ref) => ref.id)).toContain(memory.id);

    const pinned = service.saveMemory({ content: memory.content, source: "owner", scope: "agent", scopeId: fantay().id, pinned: true }, memory.id, memory.revision);
    expect(pinned.revision).toBeGreaterThan(memory.revision);
    expect(service.memoryRefsCurrent(answer.memoryRefs)).toBe(true);
    await done(submit(direct().id, "Next step"));
    expect(lastPrompt()).toContain("TEAL_ANSWER");

    service.saveMemory({ content: "The brand colour is navy", source: "owner", scope: "agent", scopeId: fantay().id }, memory.id, pinned.revision);
    expect(service.memoryRefsCurrent(answer.memoryRefs)).toBe(false);
    await done(submit(direct().id, "Next step again"));
    expect(lastPrompt()).not.toContain("TEAL_ANSWER");
    expect(lastPrompt()).toContain("The brand colour is navy");
    // The episode that quoted the old answer is still listed, with its text, but no longer recalled.
    const episode = service.memory.listItems({ scope: { kind: "bot", id: fantay().id }, kind: "episode" }).items
      .find((item) => item.content.includes("TEAL_ANSWER"))!;
    expect(episode.validUntil).not.toBeNull();
    expect(episode.status).toBe("active");
  });

  it("pauses a task's record while the memory it read is archived, resumes it on restore, and leaves it alone when a pinned memory is edited", async () => {
    const pinned = service.saveMemory({ content: "The studio motto is OCEAN_FIRST", source: "owner", scope: "agent", scopeId: fantay().id, pinned: true });
    execute.mockResolvedValueOnce(result("MOTTO_ANSWER we follow the motto"));
    const task = await done(submit(direct().id, "Draft the poster headline"));
    const recordId = `pa-episode-${task.id}-${fantay().id}`;
    const record = () => service.memory.getRow(recordId)!;
    expect(record()).toMatchObject({ status: "active", validUntil: null });
    const answer = service.store.listConversationMessages<PaMessage>(direct().id).find((m) => m.content.includes("MOTTO_ANSWER"))!;
    // The pinned memory was in the prompt because it is always included, not because this request recalled it.
    expect(answer.memoryRefs).toContainEqual({ id: pinned.id, revision: pinned.revision, standing: true });

    // Correcting a pinned memory does not silence the bot's records of what it did.
    const edited = service.saveMemory({ content: "The studio motto is OCEAN_FIRST, always", source: "owner", scope: "agent", scopeId: fantay().id }, pinned.id, pinned.revision);
    expect(record().validUntil).toBeNull();

    // Putting it away pauses them, and says why on the record's own history.
    service.deleteMemory(edited.id);
    expect(record()).toMatchObject({ status: "active", content: expect.stringContaining("MOTTO_ANSWER") });
    expect(record().validUntil).not.toBeNull();
    const paused = service.memory.history(recordId).events.at(-1)!;
    expect(paused).toMatchObject({ type: "meta_changed", actor: "system" });
    expect(String(paused.data.note)).toContain("归档");

    // Restoring it resumes them.
    const archived = service.memories().find((item) => item.id === edited.id)!;
    service.saveMemory({ content: archived.content, source: "owner", scope: "agent", scopeId: fantay().id, status: "active" }, archived.id, archived.revision);
    expect(record().validUntil).toBeNull();

    // A validity the owner set afterwards is theirs: restoring the memory again does not overwrite it.
    service.deleteMemory(edited.id);
    const ownEnd = Date.now() + 86_400_000;
    service.memory.revise(recordId, { validUntil: ownEnd, actor: "owner" });
    const again = service.memories().find((item) => item.id === edited.id)!;
    service.saveMemory({ content: again.content, source: "owner", scope: "agent", scopeId: fantay().id, status: "active" }, again.id, again.revision);
    expect(record().validUntil).toBe(ownEnd);

    // An end the owner had set before the pause comes back when recalling resumes.
    service.deleteMemory(edited.id);
    expect(record().validUntil).toBeLessThan(ownEnd);
    const once = service.memories().find((item) => item.id === edited.id)!;
    service.saveMemory({ content: once.content, source: "owner", scope: "agent", scopeId: fantay().id, status: "active" }, once.id, once.revision);
    expect(record().validUntil).toBe(ownEnd);
  });

  it("resumes a memory shared by two tasks only when neither still stands on something archived", async () => {
    const first = service.saveMemory({ content: "ALPHA_FACT the launch is in Taipei", source: "owner", scope: "agent", scopeId: fantay().id });
    const second = service.saveMemory({ content: "BETA_FACT the venue seats two hundred", source: "owner", scope: "agent", scopeId: fantay().id });
    execute.mockResolvedValueOnce(result("ok one"));
    const taskA = await done(submit(direct().id, "Where is the launch ALPHA_FACT"));
    execute.mockResolvedValueOnce(result("ok two"));
    const taskB = await done(submit(direct().id, "How many seats BETA_FACT venue"));
    // One memory learned from both tasks together, as background learning produces.
    const shared = service.memory.remember({ scope: { kind: "bot", id: fantay().id }, content: "SHARED the launch in Taipei seats two hundred", origin: "llm_inferred", actor: "system" }).item;
    for (const task of [taskA, taskB]) {
      const record = service.store.require<PaEpisode & { memoryItemIds?: string[] }>("episodes", task.id);
      service.store.update<PaEpisode & { memoryItemIds?: string[] }>("episodes", task.id, { memoryItemIds: [...(record.memoryItemIds ?? []), shared.id] });
    }
    const until = () => service.memory.getRow(shared.id)!.validUntil;

    service.deleteMemory(first.id);
    expect(until()).not.toBeNull();
    service.deleteMemory(second.id);
    const restore = (id: string) => {
      const memory = service.memories().find((item) => item.id === id)!;
      service.saveMemory({ content: memory.content, source: "owner", scope: "agent", scopeId: fantay().id, status: "active" }, id, memory.revision);
    };
    // The other source is still archived: the shared memory stays paused.
    restore(first.id);
    expect(until()).not.toBeNull();
    // Both stand again: it is recalled again.
    restore(second.id);
    expect(until()).toBeNull();
  });

  it("writes a group task back into each bot with where it was learned, without leaking one bot's or the owner's memory", async () => {
    const group = service.snapshot().groups[0]!;
    service.updateGroup(group.id, { ...group, mode: "collaboration" }, group.revision);
    service.saveMemory({ content: "OWNER_PROFILE_FACT the owner is left-handed", source: "owner", scope: "private", scopeId: null, pinned: true });
    service.saveMemory({ content: "FANTAY_OWN_NOTE keep answers brief", source: "owner", scope: "agent", scopeId: fantay().id, pinned: true });
    service.saveMemory({ content: "GROUP_RULE launches happen on Fridays", source: "owner", scope: "group", scopeId: group.id, pinned: true });
    execute.mockImplementation(async (_model, prompt) =>
      result(prompt.includes("Identity: Fantay") ? "Fantay drafts the agenda" : "Reviewer drafts the guest list"));
    const task = await done(submit(group.conversationId, "Plan the launch event"));
    expect(task.participantIds).toEqual([fantay().id, reviewer().id]);
    const fantayTurn = prompts().find((prompt) => prompt.includes("Identity: Fantay"))!;
    const reviewerTurn = prompts().find((prompt) => prompt.includes("Identity: 审阅者"))!;
    // A group turn reads the speaking bot's own memory, never another bot's and never the owner's profile.
    expect(fantayTurn).toContain("GROUP_RULE");
    expect(fantayTurn).toContain("FANTAY_OWN_NOTE");
    expect(reviewerTurn).not.toContain("FANTAY_OWN_NOTE");
    expect(reviewerTurn).toContain("Fantay drafts the agenda");
    for (const prompt of [fantayTurn, reviewerTurn]) expect(prompt).not.toContain("OWNER_PROFILE_FACT");

    const via = { groupId: group.id, groupName: "协作工作室", conversationId: group.conversationId };
    const own = (agentId: string) => service.memory.getRow(`pa-episode-${task.id}-${agentId}`)!;
    expect(own(reviewer().id)).toMatchObject({
      scopeKind: "bot", scopeId: reviewer().id, kind: "episode", origin: "tool_verified", source: "群聊 · 协作工作室",
      via: expect.objectContaining(via),
    });
    // Answers built only on group and bot memory are written back in full, so nothing needs keeping elsewhere.
    expect(own(reviewer().id).content).toContain("Reviewer drafts the guest list");
    expect(own(fantay().id).content).toContain("Fantay drafts the agenda");
    expect(service.memory.getRow(`pa-episode-${task.id}-group`)).toMatchObject({
      scopeKind: "group", scopeId: group.id, content: expect.stringMatching(/结果：(Fantay drafts the agenda|Reviewer drafts the guest list)/),
    });
    expect(service.memory.getRow(`pa-episode-${task.id}-conversation`)).toBeNull();

    const reviewerChat = service.createConversation(reviewer().id);
    await done(submit(reviewerChat.id, "Remind me of the launch event plan"));
    expect(lastPrompt()).toContain("Reviewer drafts the guest list");
    expect(lastPrompt()).toContain("learned in group 协作工作室");
    expect(lastPrompt()).not.toContain("FANTAY_OWN_NOTE");
    expect(lastPrompt()).toContain("OWNER_PROFILE_FACT");
  });

  it("mounts a character's persona instead of the owner profile, in chat and in work", async () => {
    const agent = service.createAgent({
      name: "小月", role: "陪伴聊天的朋友", avatar: "", enabled: true, tools: ["respond"], model: { runtime: "claude", modelId: "sonnet" },
    });
    service.soul.saveCharacter(agent.id, { description: "住在窗边工作室。" });
    const persona = service.soul.savePersona({ name: "阿树", description: "喜欢爬山的程序员" });
    expect(service.memoryAccessFor({ surface: "pa", agentId: agent.id })).toMatchObject({
      profileMount: "persona_only", personaId: persona.id,
    });
    expect(service.memoryAccessFor({ surface: "pa", agentId: fantay().id }).profileMount).toBe("owner_profile");
    expect(service.memoryAccessFor({ surface: "pa", agentId: fantay().id, groupId: service.snapshot().groups[0]!.id }).profileMount).toBe("none");
    service.memory.remember({ scope: { kind: "persona", id: persona.id }, content: "PERSONA_FACT 阿树周末去爬山", pinned: true, actor: "owner" });
    service.saveMemory({ content: "OWNER_PROFILE_FACT", source: "owner", scope: "private", scopeId: null, pinned: true });
    const conversation = service.createConversation(agent.id);
    await done(submit(conversation.id, "周末做什么", { kind: "chat" }));
    expect(lastPrompt()).toContain("PERSONA_FACT");
    expect(lastPrompt()).not.toContain("OWNER_PROFILE_FACT");
    await done(submit(conversation.id, "plan the weekend"));
    expect(lastPrompt()).toContain("PERSONA_FACT");
    expect(lastPrompt()).not.toContain("OWNER_PROFILE_FACT");
    service.updateAgent(agent.id, { ...agent, memoryPolicy: { profileMount: "owner_profile" } }, service.store.require<PersonalAgent>("agents", agent.id).revision);
    expect(service.memoryAccessFor({ surface: "pa", agentId: agent.id }).profileMount).toBe("owner_profile");
  });

  it("opens a conflict for contradicting memories, keeps both recalled with the CONFLICT line, and challenges on request", async () => {
    const likes = service.saveMemory({ content: "Owner likes coffee in the morning", source: "owner", scope: "private", scopeId: null });
    const dislikes = service.saveMemory({ content: "Owner does not like coffee in the morning", source: "owner", scope: "private", scopeId: null });
    expect(service.memories().filter((item) => [likes.id, dislikes.id].includes(item.id)).map((item) => item.status))
      .toEqual(["challenged", "challenged"]);
    expect(service.memory.listConflicts({ status: "open" })).toHaveLength(1);
    await done(submit(direct().id, "Should I make coffee in the morning?"));
    expect(lastPrompt()).toContain("CONFLICT (unresolved");
    expect(lastPrompt()).toContain("Owner likes coffee in the morning");
    expect(lastPrompt()).toContain("Owner does not like coffee in the morning");

    const tea = service.saveMemory({ content: "Green tea at noon", source: "owner", scope: "agent", scopeId: fantay().id });
    const challenger = service.saveMemory({
      content: "Black tea after lunch", source: "owner", scope: "agent", scopeId: fantay().id,
      evolves: { targetId: tea.id, relation: "challenges" },
    });
    expect(service.memories().find((item) => item.id === tea.id)!.status).toBe("challenged");
    expect(service.memory.listConflicts({ status: "open" }).some((c) => c.incoming.id === challenger.id && c.existing.id === tea.id)).toBe(true);
    expect(() => service.saveMemory({
      content: "x", source: "owner", scope: "private", scopeId: null, evolves: { targetId: tea.id, relation: "supersedes" },
    })).toThrow(expect.objectContaining({ code: "PA_CROSS_SCOPE_EVOLUTION" }));
  });

  it("distils finished tasks in the background with the bot's own model and its auto-memory mode", async () => {
    await service.shutdown();
    service = create({ memoryLearnDelayMs: 0 });
    const proposal = (scope: string, content: string, quote: string) => JSON.stringify({
      memories: [{ scope, kind: "fact", content, quote, eventDate: null, dueDate: null }],
    });
    execute.mockImplementation(async (_model, prompt) => {
      if (!prompt.includes("<transcript>")) return result("Noted.");
      if (prompt.includes("用户: I adopted a cat")) return result(proposal(`bot:${fantay().id}`, "The owner adopted a cat named Mochi", "I adopted a cat named Mochi"));
      return result(proposal(`bot:${fantay().id}`, "The owner moved to Hangzhou last month", "I moved to Hangzhou last month"));
    });
    const distilCalls = () => prompts().filter((prompt) => prompt.includes("<transcript>")).length;
    const facts = (statuses: Array<"active" | "pending">) =>
      service.memory.listItems({ scope: { kind: "bot", id: fantay().id }, kind: "fact", statuses }).items;

    await done(submit(direct().id, "I moved to Hangzhou last month"));
    await vi.waitFor(() => expect(facts(["active"])).toHaveLength(1));
    expect(facts(["active"])[0]).toMatchObject({ content: "The owner moved to Hangzhou last month", origin: "llm_inferred", source: "对话 · Fantay" });

    const agent = fantay();
    service.updateAgent(agent.id, { ...agent, memoryPolicy: { autoMemoryMode: "candidate" } }, agent.revision);
    await done(submit(direct().id, "I adopted a cat named Mochi"));
    await vi.waitFor(() => expect(facts(["pending"])).toHaveLength(1));
    expect(distilCalls()).toBe(2);

    const current = fantay();
    service.updateAgent(current.id, { ...current, memoryPolicy: { autoMemoryMode: "off" } }, current.revision);
    await done(submit(direct().id, "I started learning the cello"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(distilCalls()).toBe(2);
  });

  it("keeps an answer built on the owner's profile out of the bot's and the group's memory, so no group turn or channel reads it", async () => {
    const group = service.snapshot().groups[0]!;
    service.updateGroup(group.id, { ...group, mode: "collaboration" }, group.revision);
    const profile = service.saveMemory({ content: "OWNER_PROFILE_FACT the owner has diabetes", source: "owner", scope: "private", scopeId: null, pinned: true });
    execute.mockResolvedValueOnce(result("DIABETES_ANSWER the owner has diabetes, so plan the week around the check-up"));
    // A group turn that saw the one-to-one answer would repeat it.
    execute.mockImplementation(async (_model, prompt) =>
      result(prompt.includes("DIABETES_ANSWER") ? "TEAM_PLAN repeats DIABETES_ANSWER" : "TEAM_PLAN split the week"));
    const task = await done(submit(direct().id, "Plan my week"));
    const answer = service.store.listConversationMessages<PaMessage>(direct().id).find((m) => m.content.includes("DIABETES_ANSWER"))!;
    // Pinned, so in the prompt without being recalled; the answer says what it says, so it was built on it.
    expect(answer.memoryRefs).toContainEqual({ id: profile.id, revision: profile.revision, standing: true });

    // The bot keeps what the owner asked; the whole record stays with the conversation.
    const own = service.memory.getRow(`pa-episode-${task.id}-${fantay().id}`)!;
    expect(own.content).toContain("Plan my week");
    expect(own.content).not.toContain("DIABETES_ANSWER");
    expect(service.memory.getRow(`pa-episode-${task.id}-conversation`)).toMatchObject({
      scopeKind: "conversation", scopeId: direct().id, kind: "episode", content: expect.stringContaining("DIABETES_ANSWER"),
    });
    // The conversation's raw windows are keyed to the bot as well: they quote the request, not the answer.
    const windows = () => service.memory.listChunks({ conversationId: direct().id }).chunks.map((chunk) => chunk.content).join("\n");
    await vi.waitFor(() => expect(windows()).toContain("Plan my week"));
    expect(windows()).not.toContain("DIABETES_ANSWER");

    const teamTask = await done(submit(group.conversationId, "Plan my week with the team"));
    const groupTurns = prompts().filter((prompt) => prompt.includes("Plan my week with the team"));
    expect(groupTurns.some((prompt) => prompt.includes("Identity: Fantay") && prompt.includes("完成任务：Plan my week"))).toBe(true);
    for (const prompt of groupTurns) expect(prompt).not.toContain("DIABETES_ANSWER");
    expect(service.memory.getRow(`pa-episode-${teamTask.id}-group`)!.content).not.toContain("DIABETES_ANSWER");
    // An external channel bound to the group reads the group's memory, which holds nothing built on the profile.
    const channel = await service.memory.recall({
      query: "Plan my week with the team", access: { surface: "pa", groupId: group.id, channel: { sharedGroupMemory: true } },
    });
    expect(channel.promptBlock).toContain("TEAM_PLAN");
    expect(channel.promptBlock).not.toContain("DIABETES_ANSWER");
  });

  it("keeps an ordinary answer in the bot's own memory when a pinned profile memory was merely in the prompt", async () => {
    // A standing style rule is in every prompt; it is not what the answer is about.
    const style = service.saveMemory({ content: "STYLE_RULE answer with the conclusion first, then the reasons", source: "owner", scope: "private", scopeId: null, pinned: true });
    execute.mockResolvedValueOnce(result("WEEK_PLAN_ANSWER Monday design review, Wednesday client call, Friday release"));
    const task = await done(submit(direct().id, "Plan my week"));
    const answer = service.store.listConversationMessages<PaMessage>(direct().id).find((m) => m.content.includes("WEEK_PLAN_ANSWER"))!;
    expect(answer.memoryRefs).toContainEqual({ id: style.id, revision: style.revision, standing: true });
    // The bot remembers what it did, in full, and its conversation can be quoted back to it.
    expect(service.memory.getRow(`pa-episode-${task.id}-${fantay().id}`)!.content).toContain("WEEK_PLAN_ANSWER");
    expect(service.memory.getRow(`pa-episode-${task.id}-conversation`)).toBeNull();
    const windows = () => service.memory.listChunks({ conversationId: direct().id }).chunks.map((chunk) => chunk.content).join("\n");
    await vi.waitFor(() => expect(windows()).toContain("WEEK_PLAN_ANSWER"));
  });

  it("distils the owner's words but not an answer built on the profile", async () => {
    await service.shutdown();
    service = create({ memoryLearnDelayMs: 0 });
    service.saveMemory({ content: "OWNER_PROFILE_FACT the owner has diabetes", source: "owner", scope: "private", scopeId: null, pinned: true });
    execute.mockImplementation(async (_model, prompt) =>
      result(prompt.includes("<transcript>") ? JSON.stringify({ memories: [] }) : "DIABETES_ANSWER the owner has diabetes, so walk after dinner"));
    await done(submit(direct().id, "I moved to Hangzhou last month"));
    const distils = () => prompts().filter((prompt) => prompt.includes("<transcript>"));
    await vi.waitFor(() => expect(distils()).toHaveLength(1));
    expect(distils()[0]).toContain("用户: I moved to Hangzhou last month");
    expect(distils()[0]).not.toContain("DIABETES_ANSWER");
  });

  it("shows the distilling bot's model only what that bot reads, never another bot's memories", async () => {
    await service.shutdown();
    service = create({ memoryLearnDelayMs: 0 });
    const group = service.snapshot().groups[0]!;
    service.updateGroup(group.id, { ...group, mode: "collaboration" }, group.revision);
    service.saveMemory({ content: "NOTE_OF_FANTAY from a private chat", source: "owner", scope: "agent", scopeId: fantay().id });
    service.saveMemory({ content: "NOTE_OF_REVIEWER from a private chat", source: "owner", scope: "agent", scopeId: reviewer().id });
    service.saveMemory({ content: "NOTE_OF_GROUP shared by everyone", source: "owner", scope: "group", scopeId: group.id });
    execute.mockImplementation(async (_model, prompt) =>
      result(prompt.includes("<transcript>") ? JSON.stringify({ memories: [] }) : "A plan for the launch"));
    const task = await done(submit(group.conversationId, "Plan the launch event"));
    const distils = () => prompts().filter((prompt) => prompt.includes("<transcript>"));
    await vi.waitFor(() => expect(distils()).toHaveLength(1));
    const producer = service.store.list<PaAttempt>("attempts").filter((a) => a.taskId === task.id && a.phase !== "review").at(-1)!;
    const [mine, theirs] = producer.agentSnapshot.id === fantay().id ? ["NOTE_OF_FANTAY", "NOTE_OF_REVIEWER"] : ["NOTE_OF_REVIEWER", "NOTE_OF_FANTAY"];
    expect(distils()[0]).toContain(mine);
    expect(distils()[0]).toContain("NOTE_OF_GROUP");
    expect(distils()[0]).not.toContain(theirs);
  });

  it("leaves a chat's suggestions for the owner when the chat drew on a persona, and saves them by itself otherwise", async () => {
    const created = service.createAgent({
      name: "小月", role: "陪伴聊天的朋友", avatar: "", enabled: true, tools: ["respond"], model: { runtime: "claude", modelId: "sonnet" },
    });
    service.soul.saveCharacter(created.id, { description: "住在窗边工作室。" });
    const agent = service.updateAgent(created.id, { ...created, memoryPolicy: { autoMemoryMode: "explicit_auto" } }, created.revision);
    const persona = service.soul.savePersona({ name: "阿树", description: "喜欢爬山的程序员" });
    const fact = service.memory.remember({ scope: { kind: "persona", id: persona.id }, content: "PERSONA_FACT 阿树周末去爬山", pinned: true, actor: "owner" }).item;
    const conversation = service.createConversation(agent.id);
    const botTexts = () => service.memory.listItems({ scope: { kind: "bot", id: agent.id }, statuses: ["active", "pending"] }).items.map((item) => item.content);

    execute.mockResolvedValueOnce(result("好呀。\n\n<turn_meta>\nremember: fact | 阿树这周末要去爬山\n</turn_meta>"));
    await done(submit(conversation.id, "周末做什么", { kind: "chat" }));
    expect(lastPrompt()).toContain("PERSONA_FACT");
    expect(botTexts()).not.toContain("阿树这周末要去爬山");
    expect(service.store.list<PaMemoryCandidate>("memory_candidates").filter((item) => item.conversationId === conversation.id))
      .toMatchObject([{ status: "pending", content: "阿树这周末要去爬山", targetScope: "agent", targetScopeId: agent.id }]);
    const inGroup = await service.memory.recall({
      query: "阿树这周末要去爬山", access: service.memoryAccessFor({ surface: "pa", agentId: agent.id, groupId: service.snapshot().groups[0]!.id }),
    });
    expect(inGroup.promptBlock).not.toContain("阿树");

    // Drawing on nothing but the character's own memory, the suggestion is saved as the owner chose.
    service.memory.archive(fact.id, "owner");
    execute.mockResolvedValueOnce(result("好的。\n\n<turn_meta>\nremember: preference | 喜欢茉莉花\n</turn_meta>"));
    await done(submit(conversation.id, "我喜欢茉莉花", { kind: "chat" }));
    expect(botTexts()).toContain("喜欢茉莉花");
  });
});
