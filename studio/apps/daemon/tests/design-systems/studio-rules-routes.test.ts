// Design-system rules and the on-demand screen-review skill, observed at the
// HTTP boundary of the real `registerDesignSystemRoutes`:
//
//   - GET/POST /api/design-systems/:id/rules and DELETE /rules/:ruleId edit the
//     `rules` of a personal design system's system/studio.json and regenerate
//     the DESIGN.md handbook the same way an editor save does.
//   - Built-in ids are read-only; an empty rule is rejected.
//   - POST /editor of system/studio.json writes system/skills/screen-review/SKILL.md
//     (workspace project and canonical package) while reviewChecks is non-empty
//     and removes it from both when the list is emptied; DESIGN.md keeps only a
//     pointer to the staged copy.
//   - The route service `appendDesignSystemRules` (the seam the correction pass
//     uses) reports `read-only` for a built-in id without touching disk.
//
// The harness mirrors asset-sync.test.ts: real SQLite, real design-system and
// project file functions, and the real `createDesignSystemServerServices`, so the
// workspace project <-> canonical package sync is exercised for real. Only the
// routes this file never calls are stubbed.

import type http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyStudioDocument,
  STUDIO_DOCUMENT_PATH,
  STUDIO_SCREEN_REVIEW_SKILL_PATH,
  STUDIO_SCREEN_REVIEW_STAGED_PATH,
  type StudioRule,
} from '@open-design/contracts';

import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';
import {
  createUserDesignSystem,
  LEGACY_DESIGN_SYSTEM_ARTIFACTS,
  linkUserDesignSystemProject,
  listDesignSystems,
  listUserDesignSystemFiles,
  readDesignSystem,
  readDesignSystemPackageInfo,
  readDesignSystemStaticFile,
  readUserDesignSystemFile,
  readUserDesignSystemFileBytes,
  syncUserDesignSystemAssetsFromFiles,
  updateUserDesignSystem,
} from '../../src/design-systems/index.js';
import { createDesignSystemServerServices } from '../../src/design-systems/server-services.js';
import {
  closeDatabase,
  getProject,
  insertProject,
  openDatabase,
  updateProject,
} from '../../src/db.js';
import {
  deleteProjectFile,
  isSafeId,
  listFiles,
  readProjectFile,
  resolveProjectDir,
  writeProjectFile,
} from '../../src/projects.js';

const SKILL_POINTER = STUDIO_SCREEN_REVIEW_STAGED_PATH;
const CHECKS = [
  'Every interactive element shows a visible focus ring',
  'No screen has more than one primary action',
];

describe('design-system rules routes and the screen-review skill', () => {
  let workRoot = '';
  let userDir = '';
  let projectsDir = '';
  let builtInDir = '';
  let db: ReturnType<typeof openDatabase>;
  let server: http.Server | null = null;
  let baseUrl = '';
  let routeServices: ReturnType<typeof registerDesignSystemRoutes>;
  let writeSpy: ReturnType<typeof vi.fn>;
  let ensureSpy: ReturnType<typeof vi.fn>;
  let dsId = '';
  let dirId = '';
  let projectId = '';

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'od-ds-rules-routes-'));
    userDir = path.join(workRoot, 'design-systems');
    builtInDir = path.join(workRoot, 'built-in-design-systems');
    projectsDir = path.join(workRoot, 'projects');
    await mkdir(userDir, { recursive: true });
    await mkdir(builtInDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
    db = openDatabase(workRoot, { dataDir: workRoot });

    const services = createDesignSystemServerServices({
      roots: { SKILL_ROOTS: [], DESIGN_TEMPLATE_ROOTS: [], ALL_SKILL_LIKE_ROOTS: [] },
      paths: {
        PROJECTS_DIR: projectsDir,
        DESIGN_SYSTEMS_DIR: builtInDir,
        USER_DESIGN_SYSTEMS_DIR: userDir,
      },
      skills: { listSkills: async () => [], findSkillById: () => undefined },
      designSystems: {
        listDesignSystems,
        readDesignSystem,
        readDesignSystemPackageInfo,
        readDesignSystemStaticFile,
        listUserDesignSystemFiles,
        readUserDesignSystemFile,
        readUserDesignSystemFileBytes,
        linkUserDesignSystemProject,
        syncUserDesignSystemAssetsFromFiles,
        LEGACY_DESIGN_SYSTEM_ARTIFACTS,
        // Same widening cast as asset-sync.test.ts: the real module's types are
        // strictly narrower than the factory's locally declared option shapes.
      } as unknown as Parameters<typeof createDesignSystemServerServices>[0]['designSystems'],
      projects: {
        getProject,
        insertProject,
        updateProject,
        readProjectFile,
        writeProjectFile,
        listFiles,
        resolveProjectDir,
        isSafeId,
      },
    });

    // Spies wrap the real functions so a "never writes" claim is observable.
    writeSpy = vi.fn(writeProjectFile);
    ensureSpy = vi.fn(services.ensureUserDesignSystemWorkspaceProject);

    const app = express();
    app.use(express.json());
    routeServices = registerDesignSystemRoutes(app, {
      db,
      paths: {
        CRAFT_DIR: '',
        PROJECTS_DIR: projectsDir,
        USER_DESIGN_SYSTEMS_DIR: userDir,
      } as never,
      projectFiles: {
        readProjectFile,
        writeProjectFile: writeSpy,
        deleteProjectFile,
      } as never,
      projectStore: {} as never,
      // Headerless requests never reach the verifier (no workspace context), but
      // the dependency is required by the registrar.
      verifyWorkspaceRequestAuthority: async () => { throw new Error('unexpected workspace verification'); },
      workspaceResources: {
        getWorkspaceResource: () => null,
        getWorkspaceResourceByResourceId: () => null,
      },
      designSystems: {
        buildUserDesignSystemArchive: async () => null,
        canMutateUserDesignSystem: async () => true,
        createUserDesignSystem: async (root: string, input: never) => createUserDesignSystem(root, input),
        deleteUserDesignSystem: async () => true,
        ensureUserDesignSystemWorkspaceProject: ensureSpy,
        listAllDesignSystems: services.listAllDesignSystems,
        listUserDesignSystemFiles: async () => null,
        listUserDesignSystemRevisions: async () => null,
        prepareDesignTokenContractRebuild: async () => ({ decision: { available: false } }) as never,
        readAvailableDesignSystem: services.readAvailableDesignSystem,
        readAvailableDesignSystemPackageInfo: services.readAvailableDesignSystemPackageInfo,
        readAvailableDesignSystemStaticFile: services.readAvailableDesignSystemStaticFile,
        readDesignSystemWorkspaceTextFile: services.readDesignSystemWorkspaceTextFile,
        readUserDesignSystemFile: async () => null,
        renderDesignSystemPreview: () => '<!doctype html>',
        renderDesignSystemShowcase: () => '<!doctype html>',
        syncUserDesignSystemAssetsFromWorkspace: services.syncUserDesignSystemAssetsFromWorkspace,
        unshareTeamDesignSystemIfShared: async () => false,
        updateUserDesignSystem,
        updateUserDesignSystemRevisionStatus: async () => null,
      } as never,
      generationJobs: {
        get: () => null,
        rebuildTokenContract: () => ({}) as never,
        revise: () => ({}) as never,
        start: () => ({}) as never,
      },
    });

    baseUrl = await new Promise<string>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`);
      });
    });

    const created = await createUserDesignSystem(userDir, {
      title: 'Acme Brand',
      body: '# Acme Brand\n\nBrand body copy.',
    });
    dsId = created.id;
    dirId = dsId.replace(/^user:/, '');
    projectId = `ds-${dirId}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    closeDatabase();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  const url = (suffix = '') => `${baseUrl}/api/design-systems/${encodeURIComponent(dsId)}${suffix}`;
  const json = (method: string, target: string, body?: unknown) => fetch(target, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const projectFile = (rel: string) => path.join(resolveProjectDir(projectsDir, projectId), ...rel.split('/'));
  const canonicalFile = (rel: string) => path.join(userDir, dirId, ...rel.split('/'));
  const readOptional = async (file: string): Promise<string | null> => {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const listRules = async (): Promise<StudioRule[]> => {
    const response = await fetch(url('/rules'));
    expect(response.status).toBe(200);
    return ((await response.json()) as { rules: StudioRule[] }).rules;
  };
  /** The "Rules" section of the DESIGN.md handbook (it sits one heading level down inside DESIGN.md). */
  const rulesSection = (designMd: string): string => {
    const start = designMd.indexOf('### Rules');
    if (start < 0) return '';
    const rest = designMd.slice(start + '### Rules'.length);
    const next = rest.search(/\n#{2,3} /);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const saveStudioJson = async (doc: ReturnType<typeof emptyStudioDocument>, expected: string | null) => {
    const content = JSON.stringify(doc, null, 2);
    const response = await json('POST', url('/editor'), { path: STUDIO_DOCUMENT_PATH, content, expected });
    return { response, content };
  };

  describe('POST/GET/DELETE /api/design-systems/:id/rules', () => {
    it('appends a rule, lists it, writes it under the DESIGN.md Rules section, ignores a re-worded duplicate, and removes it', async () => {
      expect(await listRules()).toEqual([]);

      const rule = 'Never use gradients on buttons.';
      const post = await json('POST', url('/rules'), { rule, reason: 'Flat surfaces keep the brand calm.' });
      expect(post.status).toBe(200);
      const { added } = (await post.json()) as { added: StudioRule[] };
      expect(added).toHaveLength(1);
      expect(added[0]!.id).toMatch(/^rule-/);
      expect(added[0]).toMatchObject({ rule, reason: 'Flat surfaces keep the brand calm.' });
      expect(added[0]!.source).toBeUndefined();

      // GET reads the canonical package, so this also proves the sync back from the workspace project.
      const listed = await listRules();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: added[0]!.id, rule });
      expect(JSON.parse((await readFile(canonicalFile(STUDIO_DOCUMENT_PATH), 'utf8'))).rules).toHaveLength(1);

      // The handbook lists the rule, with its reason, under the Rules heading, in the workspace copy and canonical.
      for (const designMd of [await readFile(projectFile('DESIGN.md'), 'utf8'), await readFile(canonicalFile('DESIGN.md'), 'utf8')]) {
        expect(designMd).toContain('Brand body copy.');
        const section = rulesSection(designMd);
        expect(section).toContain(`- ${rule} Why: Flat surfaces keep the brand calm.`);
      }
      expect(await readFile(projectFile('system/studio-guide.md'), 'utf8')).toContain(`- ${rule}`);

      // Same sentence, other case and punctuation: nothing is added and nothing is rewritten.
      const before = await readFile(projectFile(STUDIO_DOCUMENT_PATH), 'utf8');
      const dup = await json('POST', url('/rules'), { rule: 'never USE gradients, on buttons!' });
      expect(dup.status).toBe(200);
      expect(((await dup.json()) as { added: StudioRule[] }).added).toEqual([]);
      expect(await listRules()).toHaveLength(1);
      expect(await readFile(projectFile(STUDIO_DOCUMENT_PATH), 'utf8')).toBe(before);

      // A different rule is appended after the first.
      const second = await json('POST', url('/rules'), { rule: 'Use the accent colour once per screen.' });
      const secondAdded = ((await second.json()) as { added: StudioRule[] }).added;
      expect(secondAdded).toHaveLength(1);
      expect((await listRules()).map((entry) => entry.id)).toEqual([added[0]!.id, secondAdded[0]!.id]);

      // DELETE removes exactly that rule, from the list and from the handbook.
      const del = await json('DELETE', url(`/rules/${added[0]!.id}`));
      expect(del.status).toBe(200);
      expect(((await del.json()) as { removed: StudioRule }).removed).toMatchObject({ id: added[0]!.id, rule });
      expect((await listRules()).map((entry) => entry.id)).toEqual([secondAdded[0]!.id]);
      const afterDelete = rulesSection(await readFile(projectFile('DESIGN.md'), 'utf8'));
      expect(afterDelete).not.toContain('gradients');
      expect(afterDelete).toContain('Use the accent colour once per screen.');

      // Removing the last rule drops the section altogether.
      expect((await json('DELETE', url(`/rules/${secondAdded[0]!.id}`))).status).toBe(200);
      expect(await listRules()).toEqual([]);
      expect(await readFile(projectFile('DESIGN.md'), 'utf8')).not.toContain('### Rules');
    });

    it('answers 404 RULE_NOT_FOUND for an unknown rule id and leaves the document alone', async () => {
      const post = await json('POST', url('/rules'), { rule: 'Keep corner radii at 8px.' });
      expect(post.status).toBe(200);
      const before = await readFile(projectFile(STUDIO_DOCUMENT_PATH), 'utf8');

      const del = await json('DELETE', url('/rules/rule-does-not-exist'));
      expect(del.status).toBe(404);
      expect(await del.json()).toMatchObject({ error: 'RULE_NOT_FOUND' });
      expect(await listRules()).toHaveLength(1);
      expect(await readFile(projectFile(STUDIO_DOCUMENT_PATH), 'utf8')).toBe(before);
    });

    it('rejects an empty or malformed rule with 400 INVALID_RULE before touching any file', async () => {
      for (const body of [{ rule: '' }, { rule: '   \n ' }, {}, { rule: 42 }, { rule: 'ok', reason: 7 }, { rule: 'x'.repeat(1001) }]) {
        const response = await json('POST', url('/rules'), body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'INVALID_RULE' });
      }
      expect(ensureSpy).not.toHaveBeenCalled();
      expect(await readdir(projectsDir)).toEqual([]);
      expect(await readOptional(canonicalFile(STUDIO_DOCUMENT_PATH))).toBeNull();
    });

    it('treats a built-in id (no user: prefix) as read-only: 409 DESIGN_SYSTEM_READ_ONLY on POST and DELETE', async () => {
      const post = await json('POST', `${baseUrl}/api/design-systems/linear/rules`, { rule: 'Anything.' });
      expect(post.status).toBe(409);
      expect(await post.json()).toMatchObject({ error: 'DESIGN_SYSTEM_READ_ONLY' });

      const del = await json('DELETE', `${baseUrl}/api/design-systems/linear/rules/rule-abc`);
      expect(del.status).toBe(409);
      expect(await del.json()).toMatchObject({ error: 'DESIGN_SYSTEM_READ_ONLY' });

      // Read-only wins even over an invalid body, and nothing was written.
      const empty = await json('POST', `${baseUrl}/api/design-systems/linear/rules`, { rule: '' });
      expect(empty.status).toBe(409);
      expect(ensureSpy).not.toHaveBeenCalled();
      expect(await readdir(projectsDir)).toEqual([]);
    });

    it('answers 404 for a personal id that does not exist', async () => {
      const response = await json('POST', `${baseUrl}/api/design-systems/${encodeURIComponent('user:missing')}/rules`, { rule: 'A rule.' });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'design system not found' });
    });
  });

  describe('screen-review skill', () => {
    it('writes the skill on save when reviewChecks is non-empty, keeps only a pointer in DESIGN.md, and removes the skill when the list is emptied', async () => {
      const withChecks = { ...emptyStudioDocument(), reviewChecks: CHECKS };
      const first = await saveStudioJson(withChecks, null);
      expect(first.response.status).toBe(200);
      expect(((await first.response.json()) as { synced: string[] }).synced).toContain(STUDIO_DOCUMENT_PATH);

      // The skill exists in the workspace project and in the canonical package, with the checks in it.
      for (const file of [projectFile(STUDIO_SCREEN_REVIEW_SKILL_PATH), canonicalFile(STUDIO_SCREEN_REVIEW_SKILL_PATH)]) {
        const skill = await readFile(file, 'utf8');
        expect(skill).toContain('name: screen-review');
        expect(skill).toContain('1. ' + CHECKS[0]);
        expect(skill).toContain('2. ' + CHECKS[1]);
      }

      // DESIGN.md (workspace and canonical) points at the staged skill and never inlines the checks.
      for (const designMd of [await readFile(projectFile('DESIGN.md'), 'utf8'), await readFile(canonicalFile('DESIGN.md'), 'utf8')]) {
        expect(designMd).toContain(SKILL_POINTER);
        expect(designMd).toContain(STUDIO_SCREEN_REVIEW_SKILL_PATH);
        for (const check of CHECKS) expect(designMd).not.toContain(check);
      }
      const guide = await readFile(projectFile('system/studio-guide.md'), 'utf8');
      expect(guide).toContain(SKILL_POINTER);
      for (const check of CHECKS) expect(guide).not.toContain(check);

      // Saving with an empty list removes the skill from both places and the pointer from DESIGN.md.
      const without = await saveStudioJson({ ...withChecks, reviewChecks: [] }, first.content);
      expect(without.response.status).toBe(200);
      expect(await readOptional(projectFile(STUDIO_SCREEN_REVIEW_SKILL_PATH))).toBeNull();
      expect(await readOptional(canonicalFile(STUDIO_SCREEN_REVIEW_SKILL_PATH))).toBeNull();
      expect(await readFile(projectFile('DESIGN.md'), 'utf8')).not.toContain(SKILL_POINTER);
      expect(await readFile(canonicalFile('DESIGN.md'), 'utf8')).not.toContain(SKILL_POINTER);

      // And a later save with checks writes it again (the delete left nothing that blocks a rewrite).
      const again = await saveStudioJson({ ...withChecks, reviewChecks: [CHECKS[1]!] }, without.content);
      expect(again.response.status).toBe(200);
      expect(await readFile(canonicalFile(STUDIO_SCREEN_REVIEW_SKILL_PATH), 'utf8')).toContain('1. ' + CHECKS[1]);
    });

    it('never writes the skill for a document without checks', async () => {
      const saved = await saveStudioJson(emptyStudioDocument(), null);
      expect(saved.response.status).toBe(200);
      expect(await readOptional(projectFile(STUDIO_SCREEN_REVIEW_SKILL_PATH))).toBeNull();
      expect(await readOptional(canonicalFile(STUDIO_SCREEN_REVIEW_SKILL_PATH))).toBeNull();
      expect(await readFile(projectFile('DESIGN.md'), 'utf8')).not.toContain(SKILL_POINTER);
    });

    it('keeps the skill when a rule is added through the rules endpoint to a document that has checks', async () => {
      const saved = await saveStudioJson({ ...emptyStudioDocument(), reviewChecks: CHECKS }, null);
      expect(saved.response.status).toBe(200);

      const post = await json('POST', url('/rules'), { rule: 'Icons are 20px on dense rows.' });
      expect(post.status).toBe(200);

      expect(await readFile(projectFile(STUDIO_SCREEN_REVIEW_SKILL_PATH), 'utf8')).toContain('1. ' + CHECKS[0]);
      expect(await readFile(canonicalFile(STUDIO_SCREEN_REVIEW_SKILL_PATH), 'utf8')).toContain('1. ' + CHECKS[0]);
      const designMd = await readFile(projectFile('DESIGN.md'), 'utf8');
      expect(rulesSection(designMd)).toContain('- Icons are 20px on dense rows.');
      expect(designMd).toContain(SKILL_POINTER);
      for (const check of CHECKS) expect(designMd).not.toContain(check);
    });
  });

  describe('route service appendDesignSystemRules', () => {
    it('returns read-only for a built-in id without writing anything', async () => {
      const outcome = await routeServices.appendDesignSystemRules('linear', [{ rule: 'Never use drop shadows.' }], { root: userDir });
      expect(outcome).toEqual({ status: 'read-only' });
      expect(ensureSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(await readdir(projectsDir)).toEqual([]);
      expect(await readOptional(canonicalFile(STUDIO_DOCUMENT_PATH))).toBeNull();
      // The personal system that exists is untouched.
      expect((await stat(canonicalFile('DESIGN.md'))).isFile()).toBe(true);
      expect(await readFile(canonicalFile('DESIGN.md'), 'utf8')).not.toContain('### Rules');
    });

    it('returns not-found for a personal id with no design system', async () => {
      const outcome = await routeServices.appendDesignSystemRules('user:ghost', [{ rule: 'Never use drop shadows.' }], { root: userDir });
      expect(outcome).toEqual({ status: 'not-found' });
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('persists a learnt rule with its correction provenance and surfaces it through GET', async () => {
      const outcome = await routeServices.appendDesignSystemRules(dsId, [{
        rule: 'Primary buttons are never full width on desktop.',
        reason: 'The user corrected a full-width submit button.',
        source: 'correction',
        createdAt: '2026-11-03T08:00:00.000Z',
        context: 'Rendered a full-width Save button',
      }], { root: userDir });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.added).toHaveLength(1);
      expect(outcome.added[0]).toMatchObject({ source: 'correction', createdAt: '2026-11-03T08:00:00.000Z', context: 'Rendered a full-width Save button' });

      const listed = await listRules();
      expect(listed).toEqual(outcome.added);
      expect(rulesSection(await readFile(projectFile('DESIGN.md'), 'utf8'))).toContain('- Primary buttons are never full width on desktop. Why: The user corrected a full-width submit button.');

      // Re-learning the same correction is a no-op.
      const again = await routeServices.appendDesignSystemRules(dsId, [{ rule: 'primary buttons are never full width on desktop', source: 'correction' }], { root: userDir });
      expect(again).toEqual({ status: 'ok', added: [] });
      expect(await listRules()).toHaveLength(1);
    });
  });
});
