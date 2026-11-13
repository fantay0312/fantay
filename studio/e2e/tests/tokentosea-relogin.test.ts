// @vitest-environment node

/**
 * A TokenToSea run started without a signed-in TokenToSea session must
 * converge rather than hang or spawn the bundled pi: the daemon refuses the
 * inference lease, the run fails with `TOKENTOSEA_AUTHORIZATION_REQUIRED`, and
 * the turn's assistant message settles as failed so the UI can ask the user to
 * sign in again. The lease is refused before any upstream TokenToSea call, so
 * the real tools-dev daemon drives this without network access.
 *
 * The retired AMR agent id must take the same path: `/api/runs` canonicalizes
 * `amr` to `tokentosea`, so an old client cannot reach a removed runtime.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { requestJson } from '@/vitest/http';
import { listMessages } from '@/vitest/messages';
import { readRunEvents, startRun, waitForRunTerminal } from '@/vitest/runs';
import { createSmokeSuite } from '@/vitest/suite';

type ProjectResponse = {
  conversationId: string;
  project: { id: string; name: string };
};

const AUTHORIZATION_REQUIRED = 'TOKENTOSEA_AUTHORIZATION_REQUIRED';

describe('TokenToSea sign-in required', () => {
  test('[P1] fails the run and its assistant message when no TokenToSea session is signed in', { timeout: 180_000 }, async () => {
    const suite = await createSmokeSuite('tokentosea-relogin');

    await suite.with.toolsDev(async ({ webUrl }) => {
      await requestJson<{ config: Record<string, unknown> }>(webUrl, '/api/app-config', {
        body: {
          agentId: 'tokentosea',
          agentModels: { tokentosea: { model: 'default', reasoning: 'default' } },
          designSystemId: null,
          onboardingCompleted: true,
          skillId: null,
          telemetry: { artifactManifest: true, content: false, metrics: false },
        },
        method: 'PUT',
      });

      for (const requestedAgentId of ['tokentosea', 'amr']) {
        const project = await requestJson<ProjectResponse>(webUrl, '/api/projects', {
          body: {
            designSystemId: null,
            id: randomUUID(),
            metadata: { kind: 'prototype' },
            name: `TokenToSea sign-in required (${requestedAgentId})`,
            pendingPrompt: null,
            skillId: null,
          },
        });
        const assistantMessageId = `assistant-${requestedAgentId}-${Date.now()}`;
        const run = await startRun(webUrl, {
          agentId: requestedAgentId,
          assistantMessageId,
          clientRequestId: `req-${requestedAgentId}-${Date.now()}`,
          conversationId: project.conversationId,
          designSystemId: null,
          message: 'This run has no TokenToSea session and must ask for sign-in.',
          model: 'default',
          projectId: project.project.id,
          reasoning: 'default',
          skillId: null,
        });

        const terminal = await waitForRunTerminal(webUrl, run.runId, { timeoutMs: 20_000 });
        expect(terminal.status, `${requestedAgentId} run status`).toBe('failed');
        expect(terminal.agentId, `${requestedAgentId} is recorded under the TokenToSea runtime`).toBe('tokentosea');
        expect(terminal.errorCode, `${requestedAgentId} failure code`).toBe(AUTHORIZATION_REQUIRED);
        await expect(readRunEvents(webUrl, run.runId)).resolves.toContain(AUTHORIZATION_REQUIRED);

        const messages = await listMessages(webUrl, project.project.id, project.conversationId);
        const assistant = messages.find((message) => message.id === assistantMessageId);
        expect(assistant?.runStatus, `${requestedAgentId} assistant message`).toBe('failed');
      }
    });
  });
});
