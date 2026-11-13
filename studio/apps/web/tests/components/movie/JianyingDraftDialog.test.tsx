// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMovieDocument } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { JianyingDraftDialog } from '../../../src/components/movie/JianyingDraftDialog';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../../src/providers/jianying', () => ({ jianyingRequest: request }));
const environment = { application: { installed: true, version: '11.6.0' }, compatibility: 'verified', capabilities: { editEncrypted: true } };
const inspection = { tracks: [{ id: 'text-track', name: 'Captions', type: 'text', segments: [{ id: 'text-id', start: 0, duration: 3, text: 'Old caption', volume: 1 }] }], duration: 3, encoding: 'plaintext' };
const result = { draft: { id: 'project:new-copy', path: '/project/jianying-drafts/new-copy' }, inspection, validation: { valid: true, errors: [], warnings: [] }, warnings: [], sourcePreserved: true };
beforeEach(() => { request.mockReset(); request.mockImplementation(async (_id, _context, route) => {
  if (route === 'status') return environment;
  if (route === 'drafts?local=true') return { drafts: [{ id: 'project:source', name: 'Source', origin: 'project' }] };
  if (route.startsWith('inspect')) return { inspection, validation: { valid: true, errors: [] } };
  return result;
}); });
afterEach(cleanup);
function setup(mode: 'create' | 'edit' = 'create') {
  const movie = createMovieDocument('Draft test', 'blank'); movie.revision = 7;
  return render(<I18nProvider initial="en"><JianyingDraftDialog open mode={mode} onClose={() => {}} projectId="fixed-project" context={null} document={movie} sources={[]} /></I18nProvider>);
}
it('detects the version and creates from the saved revision', async () => {
  setup();
  expect(await screen.findByText('Jianying 11.6.0')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Create Jianying draft' }));
  await screen.findByText('Draft saved');
  expect(request).toHaveBeenCalledWith('fixed-project', null, 'create', { source: 'timeline', name: 'Draft test', expectedRevision: 7, allowUnverified: false }, false, undefined);
  expect(screen.getByText('/project/jianying-drafts/new-copy')).toBeInTheDocument();
});
it('requires explicit consent before generating for an unverified installed version', async () => {
  request.mockResolvedValue({ ...environment, compatibility: 'unverified', application: { installed: true, version: '12.0.0' } });
  setup(); await screen.findByText('Jianying 12.0.0');
  expect(screen.getByRole('button', { name: 'Create Jianying draft' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Create Jianying draft' })).not.toBeDisabled();
});
it('inspects exact IDs and submits an edit that saves a new copy', async () => {
  setup('edit'); await screen.findByText('Jianying 11.6.0');
  fireEvent.click(screen.getByRole('combobox', { name: 'Source draft' }));
  fireEvent.click(await screen.findByRole('option', { name: /Source/ }));
  const text = await screen.findByLabelText('Text'); fireEvent.change(text, { target: { value: 'Corrected caption' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save new copy' }));
  await screen.findByText('Draft saved');
  expect(request).toHaveBeenCalledWith('fixed-project', null, 'edit', expect.objectContaining({ draftId: 'project:source', operations: [{ op: 'set_text', segmentId: 'text-id', text: 'Corrected caption' }] }), true, undefined);
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Second correction' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save new copy' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save new copy' }));
  await waitFor(() => expect(request).toHaveBeenLastCalledWith('fixed-project', null, 'edit', expect.objectContaining({ draftId: 'project:new-copy', operations: [{ op: 'set_text', segmentId: 'text-id', text: 'Second correction' }] }), true, undefined));
});
it('reports a real create failure without displaying a saved receipt', async () => {
  request.mockImplementation(async (_id, _context, route) => { if (route === 'status') return environment; throw new Error('Save the timeline first'); });
  setup(); await screen.findByText('Jianying 11.6.0'); fireEvent.click(screen.getByRole('button', { name: 'Create Jianying draft' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save the timeline first'); expect(screen.queryByText('Draft saved')).not.toBeInTheDocument();
});
