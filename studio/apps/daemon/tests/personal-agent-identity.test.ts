import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaConversation, PersonalAgent } from "@open-design/contracts";
import { closeDatabase, openDatabase, type SqliteDb } from "../src/db.js";
import { PersonalAgentService } from "../src/services/personal-agent-service.js";

let dir: string, db: SqliteDb;
const services: PersonalAgentService[] = [];
function create() {
  const service = new PersonalAgentService({
    db,
    dataDir: dir,
    projectsDir: join(dir, "projects"),
    runtime: { models: async () => [], execute: async () => ({ text: "", usage: { visibility: "unknown" } }) },
  });
  services.push(service);
  return service;
}
const MARKER = "identity-fantay-v1";
beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".tmp-pa-"));
  db = openDatabase(dir, { dataDir: dir });
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

describe("Fantay identity", () => {
  it("seeds Fantay on a fresh install", () => {
    const s = create();
    const agent = s.store.list<PersonalAgent>("agents")[0]!;
    expect(agent.name).toBe("Fantay");
    expect(agent.avatar).toBe("fantay");
    expect(s.store.list<PaConversation>("conversations")[0]!.title).toBe("Fantay");
  });

  it("migrates a legacy 主助手 once and idempotently", () => {
    const first = create();
    const agent = first.store.list<PersonalAgent>("agents")[0]!;
    const conversation = first.store.list<PaConversation>("conversations")[0]!;
    first.store.update<PersonalAgent>("agents", agent.id, { name: "主助手", avatar: "PA" });
    first.store.update<PaConversation>("conversations", conversation.id, { title: "主助手" });
    first.store.remove("settings", MARKER);

    const second = create();
    const migrated = second.store.require<PersonalAgent>("agents", agent.id);
    expect(migrated.name).toBe("Fantay");
    expect(migrated.avatar).toBe("fantay");
    expect(second.store.require<PaConversation>("conversations", conversation.id).title).toBe("Fantay");
    expect(second.store.get("settings", MARKER)).not.toBeNull();

    const third = create();
    expect(third.store.require<PersonalAgent>("agents", agent.id).revision).toBe(migrated.revision);
    expect(third.store.require<PaConversation>("conversations", conversation.id).revision).toBe(
      second.store.require<PaConversation>("conversations", conversation.id).revision,
    );
  });

  it("leaves a renamed agent alone", () => {
    const first = create();
    const agent = first.store.list<PersonalAgent>("agents")[0]!;
    first.store.update<PersonalAgent>("agents", agent.id, { name: "小月", avatar: "PA" });
    first.store.remove("settings", MARKER);
    const second = create();
    const same = second.store.require<PersonalAgent>("agents", agent.id);
    expect(same.name).toBe("小月");
    expect(same.avatar).toBe("PA");
  });

  it("drops the mascot when cloning Fantay", () => {
    const s = create();
    const fantay = s.store.list<PersonalAgent>("agents")[0]!;
    expect(s.cloneAgent(fantay.id).avatar).toBe("");
  });
});
