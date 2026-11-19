import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractFromMessage,
  listMemoryEntries,
  memoryDir,
  readMemoryConfig,
  readMemoryEntry,
  readMemoryIndex,
  upsertMemoryEntry,
  writeMemoryConfig,
} from '../src/memory.js';
import { runAutoExtractionCleanup } from '../src/memory-cleanup.js';

let dataDir = '';

// Verbatim replicas of entries the retired heuristic regex pack wrote in
// production (real garbage observed on a stable-channel install).
const HEURISTIC_GARBAGE = [
  {
    id: 'user_n19fd1zz',
    name: '用户所在地',
    description: '用户所在地：开做：',
    type: 'user',
    body: '- 所在地：开做：\n\n何时适用：在时区、货币、文化语境相关的回答里把这一点纳入考虑。',
  },
  {
    id: 'user_hero',
    name: '用户所在地',
    description: '用户所在地：补一张决定性 hero 图',
    type: 'user',
    body: '- 所在地：补一张决定性 hero 图\n\n何时适用：在时区、货币、文化语境相关的回答里把这一点纳入考虑。',
  },
  {
    id: 'project_n1ckt8ze',
    name: '用户目标',
    description: '用户希望：先和你确认，避免返工：',
    type: 'project',
    body: '- 目标：先和你确认，避免返工：\n\n何时适用：当对话靠近这一目标时主动呼应它，并把建议与目标对齐。',
  },
  {
    id: 'project_ship_course',
    name: 'User goal',
    description: 'User wants to ship a course',
    type: 'project',
    body: '- Goal: ship a course\n\nWhen to apply: surface relevance to this goal whenever the conversation drifts close to it.',
  },
  {
    id: 'reference_scratch',
    name: '速记备忘',
    description: '发布窗口是周四',
    type: 'reference',
    body: '- 发布窗口是周四',
  },
] as const;

// Entries the cleanup must PRESERVE: LLM-extracted project facts (product
// decision: keep), connector/brand output, and anything a user typed by hand.
const KEEP_ENTRIES = [
  {
    id: 'project_meridian_launch_deck',
    name: 'Meridian launch deck',
    description: '10-slide product launch deck for Meridian sleep-tracking ring.',
    type: 'project',
    body: 'The user is creating a 10-slide product launch/pitch deck for Meridian, a sleep-tracking ring. Audience is tech press.',
  },
  {
    id: 'rule_brand_ai_palette',
    name: '钉钉 palette only',
    description: "Only 钉钉's registered palette is used for color.",
    type: 'rule',
    body: '- Palette: Background #000000, Accent #007fff.',
  },
  {
    id: 'feedback_n1q6pme',
    name: '体制内材料风格偏好',
    description: '做体制内演讲/PPT时偏好说人话、逻辑清楚。',
    type: 'feedback',
    body: '用户在制作档案工作会议演讲配套PPT时明确偏好：说人话、逻辑清楚，突出基层真实感。',
  },
] as const;

const MIXED_PROFILE_BODY = [
  '- Role: 产品经理',
  '- Domain: design tools',
  '- 要做什么？: Prototype',
  '- 目标用户是谁？: 宝可梦粉丝',
  '- 目标平台: iOS App',
  '- What should I build?: Prototype',
].join('\n');

async function seedStore() {
  for (const entry of [...HEURISTIC_GARBAGE, ...KEEP_ENTRIES]) {
    await upsertMemoryEntry(dataDir, entry, { silent: true });
  }
  await upsertMemoryEntry(
    dataDir,
    {
      id: 'user_profile',
      name: 'Work profile',
      description: 'Role, audience, domain, and delivery defaults captured at onboarding.',
      type: 'profile',
      body: MIXED_PROFILE_BODY,
    },
    { silent: true },
  );
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-memory-cleanup-'));
  await seedStore();
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('one-time auto-extraction cleanup', () => {
  async function listIds() {
    return (await listMemoryEntries(dataDir)).map((e) => e.id).sort();
  }

  it('moves, deletes and rewrites nothing: retired-pipeline entries and the profile stay as they are', async () => {
    const before = await listIds();
    const result = await runAutoExtractionCleanup(dataDir);
    expect(result.ran).toBe(true);
    expect(result.deletedIds).toEqual([]);
    expect(result.profilePruned).toBe(false);

    expect(await listIds()).toEqual(before);
    expect(before).toEqual(
      [...[...HEURISTIC_GARBAGE, ...KEEP_ENTRIES].map((e): string => e.id), 'user_profile'].sort(),
    );
    // The mixed profile, form residue included, is byte-for-byte what the person had.
    const profile = await readMemoryEntry(dataDir, 'user_profile');
    expect(profile!.body.trim()).toBe(MIXED_PROFILE_BODY);
    for (const garbage of HEURISTIC_GARBAGE) {
      expect((await readMemoryEntry(dataDir, garbage.id))!.body.trim()).toBe(garbage.body);
    }
    // Nothing was moved to .trash and nothing was copied to .history.
    for (const dir of ['.trash', '.history']) {
      await expect(fsp.access(path.join(memoryDir(dataDir), dir))).rejects.toThrow();
    }
  });

  it('keeps every index bullet', async () => {
    const before = await readMemoryIndex(dataDir);
    await runAutoExtractionCleanup(dataDir);
    expect(await readMemoryIndex(dataDir)).toBe(before);
    for (const entry of [...HEURISTIC_GARBAGE, ...KEEP_ENTRIES]) {
      expect(before).toContain(`(${entry.id}.md)`);
    }
  });

  it('forces chatExtractionEnabled off exactly once, then respects a re-opt-in', async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    const first = await runAutoExtractionCleanup(dataDir);
    expect(first.extractionSwitchedOff).toBe(true);
    expect((await readMemoryConfig(dataDir)).chatExtractionEnabled).toBe(false);

    // A user who consciously re-enables extraction after the migration must
    // not be flipped back by later boots.
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    const second = await runAutoExtractionCleanup(dataDir);
    expect(second.ran).toBe(false);
    expect((await readMemoryConfig(dataDir)).chatExtractionEnabled).toBe(true);
  });

  it('leaves a data dir with extraction already off without a config file', async () => {
    const result = await runAutoExtractionCleanup(dataDir);
    expect(result.extractionSwitchedOff).toBe(false);
    await expect(fsp.access(path.join(memoryDir(dataDir), '.config.json'))).rejects.toThrow();
  });

  it('is idempotent: the second run is a no-op', async () => {
    const first = await runAutoExtractionCleanup(dataDir);
    expect(first.ran).toBe(true);
    const second = await runAutoExtractionCleanup(dataDir);
    expect(second.ran).toBe(false);
    expect(await readMemoryEntry(dataDir, HEURISTIC_GARBAGE[0].id)).not.toBeNull();
  });

  it('records a marker file inside the memory dir', async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    await runAutoExtractionCleanup(dataDir);
    const markerRaw = await fsp.readFile(
      path.join(memoryDir(dataDir), '.cleanup_auto_extracted_v1.json'),
      'utf8',
    );
    const marker = JSON.parse(markerRaw);
    expect(marker.extractionSwitchedOff).toBe(true);
    expect(typeof marker.ranAt).toBe('number');
  });
});

describe('source provenance on new writes', () => {
  it('persists the writer source into frontmatter so future audits are precise', async () => {
    await upsertMemoryEntry(
      dataDir,
      {
        id: 'feedback_from_llm',
        name: 'LLM extracted preference',
        description: 'prefers dark noir palettes',
        type: 'feedback',
        body: 'Prefers dark noir palettes.',
      },
      { silent: true, source: 'llm' },
    );
    const raw = await fsp.readFile(
      path.join(memoryDir(dataDir), 'feedback_from_llm.md'),
      'utf8',
    );
    expect(raw).toContain('source: llm');
    const entry = await readMemoryEntry(dataDir, 'feedback_from_llm');
    expect(entry!.source).toBe('llm');
  });

  it('defaults source to manual for direct API writes', async () => {
    // Third arg mirrors the HTTP routes, which pass `undefined` options.
    await upsertMemoryEntry(
      dataDir,
      {
        id: 'user_hand_written',
        name: 'Hand written fact',
        description: 'typed in settings',
        type: 'user',
        body: 'I ship decks on Fridays.',
      },
      undefined,
    );
    const entry = await readMemoryEntry(dataDir, 'user_hand_written');
    expect(entry!.source).toBe('manual');
  });
});

describe('automatic writers never replace what they did not write', () => {
  const HAND_WRITTEN = {
    id: 'rule_avoid_gradients',
    name: 'Avoid gradients',
    description: 'my own rule',
    type: 'rule',
    body: 'No gradients anywhere, ever.',
  } as const;
  // Same derived id as HAND_WRITTEN: the trailing dot normalizes away.
  const COLLIDING = {
    name: 'Avoid gradients.',
    description: 'model-written rule',
    type: 'rule',
    body: 'Prefer flat fills.',
  } as const;

  async function seedHandWritten() {
    await upsertMemoryEntry(dataDir, HAND_WRITTEN, undefined);
  }

  async function historyFiles(id: string) {
    try {
      return await fsp.readdir(path.join(memoryDir(dataDir), '.history', id));
    } catch {
      return [];
    }
  }

  it.each(['llm', 'annotation', 'heuristic', 'connector', 'brand'] as const)(
    'a %s write whose derived id is a person\'s entry lands under a fresh id',
    async (source) => {
      await seedHandWritten();
      const written = await upsertMemoryEntry(dataDir, COLLIDING, { silent: true, source });

      expect(written.id).not.toBe(HAND_WRITTEN.id);
      expect(written.id.startsWith(`${HAND_WRITTEN.id}_`)).toBe(true);
      expect(written.source).toBe(source);
      expect(written.body.trim()).toBe(COLLIDING.body);

      const mine = await readMemoryEntry(dataDir, HAND_WRITTEN.id);
      expect(mine).toMatchObject({
        name: HAND_WRITTEN.name,
        description: HAND_WRITTEN.description,
        source: 'manual',
      });
      expect(mine!.body.trim()).toBe(HAND_WRITTEN.body);
      // Nothing was overwritten, so nothing needed copying to .history either.
      expect(await historyFiles(HAND_WRITTEN.id)).toEqual([]);
      expect(await readMemoryIndex(dataDir)).toContain(`(${written.id}.md)`);
    },
  );

  it('repeating the same automatic write updates its own fresh entry instead of adding another', async () => {
    await seedHandWritten();
    const first = await upsertMemoryEntry(dataDir, COLLIDING, { silent: true, source: 'llm' });
    const second = await upsertMemoryEntry(
      dataDir,
      { ...COLLIDING, body: 'Prefer flat fills and solid colours.' },
      { silent: true, source: 'llm' },
    );
    expect(second.id).toBe(first.id);
    expect(second.body.trim()).toBe('Prefer flat fills and solid colours.');
    const ours = (await listMemoryEntries(dataDir)).filter((e) => e.id.startsWith(HAND_WRITTEN.id));
    expect(ours).toHaveLength(2);
    expect((await readMemoryEntry(dataDir, HAND_WRITTEN.id))!.body.trim()).toBe(HAND_WRITTEN.body);
  });

  it('an automatic writer still refreshes its own earlier entry of the same name in place', async () => {
    const first = await upsertMemoryEntry(dataDir, COLLIDING, { silent: true, source: 'llm' });
    expect(first.id).toBe(HAND_WRITTEN.id);
    const second = await upsertMemoryEntry(
      dataDir,
      { ...COLLIDING, body: 'Prefer flat fills, always.' },
      { silent: true, source: 'llm' },
    );
    expect(second.id).toBe(first.id);
    expect(second.body.trim()).toBe('Prefer flat fills, always.');
    expect(await historyFiles(first.id)).toHaveLength(1);
  });

  it('a different automatic writer does not take over another writer\'s entry of the same name', async () => {
    const llm = await upsertMemoryEntry(dataDir, COLLIDING, { silent: true, source: 'llm' });
    const annotation = await upsertMemoryEntry(
      dataDir,
      { ...COLLIDING, body: 'From a review comment.' },
      { silent: true, source: 'annotation' },
    );
    expect(annotation.id).not.toBe(llm.id);
    expect((await readMemoryEntry(dataDir, llm.id))!.body.trim()).toBe(COLLIDING.body);
  });

  it('a same-named entry from a person is not replaced either', async () => {
    await seedHandWritten();
    const written = await upsertMemoryEntry(
      dataDir,
      { ...COLLIDING, name: HAND_WRITTEN.name },
      { silent: true, source: 'llm' },
    );
    expect(written.id).not.toBe(HAND_WRITTEN.id);
    expect((await readMemoryEntry(dataDir, HAND_WRITTEN.id))!.body.trim()).toBe(HAND_WRITTEN.body);
  });

  it('a file with no source marker (written before provenance) counts as a person\'s', async () => {
    await fsp.mkdir(memoryDir(dataDir), { recursive: true });
    const legacy = '---\nname: Avoid gradients\ndescription: old\ntype: rule\n---\n\nOld rule body.\n';
    await fsp.writeFile(path.join(memoryDir(dataDir), 'rule_avoid_gradients.md'), legacy);
    const written = await upsertMemoryEntry(dataDir, COLLIDING, { silent: true, source: 'llm' });
    expect(written.id).not.toBe('rule_avoid_gradients');
    expect(await fsp.readFile(path.join(memoryDir(dataDir), 'rule_avoid_gradients.md'), 'utf8')).toBe(legacy);
  });

  it('an explicit id held by a person\'s entry is not reused by the heuristic pack', async () => {
    const mine = await upsertMemoryEntry(
      dataDir,
      { id: 'user_hand_fact', name: 'Hand fact', description: '', type: 'user', body: 'Mine.' },
      undefined,
    );
    const written = await upsertMemoryEntry(
      dataDir,
      { id: 'user_hand_fact', name: 'User role', description: 'auto', type: 'user', body: '- auto' },
      { silent: true, source: 'heuristic' },
    );
    expect(written.id).not.toBe(mine.id);
    expect((await readMemoryEntry(dataDir, mine.id))!.body.trim()).toBe('Mine.');
  });

  it('keeps the project scope of the file actually written, not of the entry it avoided', async () => {
    await upsertMemoryEntry(
      dataDir,
      { id: 'user_scoped', name: 'Scoped', description: '', type: 'project', body: 'Mine.', projectId: 'proj-a' },
      undefined,
    );
    const written = await upsertMemoryEntry(
      dataDir,
      { id: 'user_scoped', name: 'Other', description: '', type: 'project', body: 'Auto.' },
      { silent: true, source: 'llm' },
    );
    expect(written.id).not.toBe('user_scoped');
    expect(written.projectId).toBeUndefined();
  });

  it('a person editing an entry in Settings still replaces it, with the old text kept in .history', async () => {
    await seedHandWritten();
    const edited = await upsertMemoryEntry(
      dataDir,
      { ...HAND_WRITTEN, name: 'Avoid gradients.', body: 'Gradients only on hero art.' },
      undefined,
    );
    expect(edited.id).toBe(HAND_WRITTEN.id);
    expect(edited.body.trim()).toBe('Gradients only on hero art.');
    const history = await historyFiles(HAND_WRITTEN.id);
    expect(history).toHaveLength(1);
    const kept = await fsp.readFile(
      path.join(memoryDir(dataDir), '.history', HAND_WRITTEN.id, history[0]!),
      'utf8',
    );
    expect(kept).toContain(HAND_WRITTEN.body);
  });

  describe('profile capture from a form', () => {
    const FORM = '[form answers — discovery]\n- Role: 设计师\n- Domain: fintech\n';

    beforeEach(async () => {
      await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    });

    it('does not merge into or replace a profile a person wrote', async () => {
      // seedStore already wrote a person's `user_profile`.
      const before = await readMemoryEntry(dataDir, 'user_profile');
      const changed = await extractFromMessage(dataDir, FORM);

      const after = await readMemoryEntry(dataDir, 'user_profile');
      expect(after!.body.trim()).toBe(before!.body.trim());
      expect(after!.source).toBe('manual');

      const profileIds = changed.map((c) => c.id);
      expect(profileIds).toHaveLength(1);
      expect(profileIds[0]).not.toBe('user_profile');
      const captured = await readMemoryEntry(dataDir, profileIds[0]!);
      expect(captured).toMatchObject({ type: 'profile', source: 'heuristic' });
      // Only the form's answers, not a copy of the person's fields.
      expect(captured!.body.trim()).toBe('- Role: 设计师\n- Domain: fintech');
    });

    it('later forms merge into the same automatic profile', async () => {
      const first = await extractFromMessage(dataDir, FORM);
      const second = await extractFromMessage(
        dataDir,
        '[form answers — discovery]\n- Primary audience: 财务团队\n- Role: 产品设计师\n',
      );
      expect(second[0]!.id).toBe(first[0]!.id);
      const captured = await readMemoryEntry(dataDir, first[0]!.id);
      expect(captured!.body.trim()).toBe(
        '- Role: 产品设计师\n- Domain: fintech\n- Primary audience: 财务团队',
      );
      expect((await readMemoryEntry(dataDir, 'user_profile'))!.body.trim()).toBe(MIXED_PROFILE_BODY);
    });

    it('still writes user_profile when no person has one', async () => {
      await fsp.rm(path.join(memoryDir(dataDir), 'user_profile.md'));
      const changed = await extractFromMessage(dataDir, FORM);
      expect(changed.map((c) => c.id)).toEqual(['user_profile']);
      expect((await readMemoryEntry(dataDir, 'user_profile'))!.source).toBe('heuristic');
    });
  });
});
