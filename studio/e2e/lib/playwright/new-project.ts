import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { UiScenario } from '@/playwright/resources';

type ScenarioCreate = UiScenario['create'];

/**
 * The New Project form makes only neutral, free-form projects (name, starting
 * point, design system; the agent decides what to build). A scenario that
 * names no type, or the old default `prototype`, still goes through the form.
 */
export function createsThroughForm(create: ScenarioCreate): boolean {
  return !create.tab || create.tab === 'prototype' || create.tab === 'other';
}

/**
 * The metadata (and Skill) the old typed New Project tabs wrote. Typed
 * scenarios — deck, media, live artifact — seed their project with exactly
 * this through the production HTTP API, since the form no longer offers types.
 */
export function typedScenarioProject(create: ScenarioCreate): {
  skillId: string | null;
  metadata: Record<string, unknown>;
} {
  switch (create.tab) {
    case 'deck':
      return { skillId: null, metadata: { kind: 'deck', speakerNotes: false } };
    case 'live-artifact':
      return {
        skillId: null,
        metadata: { kind: 'prototype', intent: 'live-artifact', fidelity: 'high-fidelity' },
      };
    case 'template':
      return { skillId: null, metadata: { kind: 'template' } };
    case 'media': {
      if (create.mediaSurface === 'video') {
        const videoModel = create.videoModel ?? 'hyperframes-html';
        return {
          skillId: videoModel === 'hyperframes-html' ? 'hyperframes' : null,
          metadata: { kind: 'video', videoModel, videoAspect: '16:9', videoLength: 5 },
        };
      }
      if (create.mediaSurface === 'audio') {
        return {
          skillId: null,
          metadata: { kind: 'audio', audioKind: create.audioKind ?? 'music', audioDuration: 10 },
        };
      }
      return { skillId: null, metadata: { kind: 'image', imageAspect: '1:1' } };
    }
    default:
      return { skillId: null, metadata: { kind: 'other' } };
  }
}

/**
 * Create a scenario's project and land in its workspace route.
 *
 * Free-form scenarios open the New Project form with `openForm`, type the
 * name and press Create. Typed scenarios POST `/api/projects` with the
 * metadata their old tab wrote, then open `/projects/<id>`.
 */
export async function createScenarioProject(
  page: Page,
  create: ScenarioCreate,
  openForm: (page: Page) => Promise<void>,
): Promise<void> {
  if (createsThroughForm(create)) {
    await openForm(page);
    await expect(page.getByTestId('new-project-panel')).toBeVisible();
    await page.getByTestId('new-project-name').fill(create.projectName);
    await page.getByTestId('create-project').click();
    return;
  }
  const projectId = `${create.tab}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const { skillId, metadata } = typedScenarioProject(create);
  const response = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name: create.projectName,
      skillId,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { ...metadata, nameSource: 'user' },
    },
  });
  expect(response.ok(), `create ${create.tab} project: ${await response.text()}`).toBeTruthy();
  await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
}
