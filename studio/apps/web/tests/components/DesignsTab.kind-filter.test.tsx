// @vitest-environment jsdom
// The 全部项目 kind filter: one list narrowed to design systems or video and animation, with that kind's
// create action and a door to its full library in the toolbar.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignsTab } from '../../src/components/DesignsTab';
import type { Project } from '../../src/types';

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: null, loading: false, failure: null, refresh: vi.fn() }),
  useWorkspaceBilling: () => null,
}));

vi.mock('../../src/providers/registry', () => ({
  deleteLiveArtifact: vi.fn(),
  fetchLiveArtifacts: vi.fn(async () => []),
  fetchProjectFiles: vi.fn(async () => []),
  liveArtifactPreviewUrl: (projectId: string, artifactId: string) =>
    `/api/projects/${projectId}/live-artifacts/${artifactId}/preview`,
  projectFileUrl: (projectId: string, fileName: string) => `/api/projects/${projectId}/files/${fileName}`,
}));

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, skillId: null, designSystemId: null, createdAt: 1, updatedAt: 2, status: { value: 'not_started' }, ...extra };
}

const PROJECTS = [
  project('plain-site'),
  project('film-reel', { skillId: 'fantay-movie' }),
  project('brand-kit', { metadata: { kind: 'brand' } }),
];

function renderTab(projects: Project[] = PROJECTS) {
  const props = { onNewProject: vi.fn(), onNewDesignSystem: vi.fn(), onNewMotion: vi.fn(), onOpenLibrary: vi.fn() };
  render(
    <DesignsTab
      projects={projects}
      skills={[]}
      designSystems={[]}
      onOpen={vi.fn()}
      onOpenLiveArtifact={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />,
  );
  return props;
}

const cards = () => ['plain-site', 'film-reel', 'brand-kit'].filter((name) => screen.queryByTitle(name) !== null);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DesignsTab kind filter', () => {
  it('shows every kind by default and narrows the list per filter', () => {
    renderTab();
    expect(cards()).toEqual(['plain-site', 'film-reel', 'brand-kit']);
    expect(screen.getByTestId('designs-kind-all')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('designs-kind-designSystem'));
    expect(cards()).toEqual(['brand-kit']);
    fireEvent.click(screen.getByTestId('designs-kind-motion'));
    expect(cards()).toEqual(['film-reel']);
    expect(screen.getByTestId('designs-kind-motion')).toHaveAttribute('aria-pressed', 'true');
  });

  it('swaps the toolbar for the kind’s create action and full library', () => {
    const props = renderTab();
    expect(screen.getByTestId('designs-new-project')).toBeInTheDocument();
    expect(screen.queryByTestId('designs-open-library')).toBeNull();

    fireEvent.click(screen.getByTestId('designs-kind-designSystem'));
    expect(screen.queryByTestId('designs-new-project')).toBeNull();
    fireEvent.click(screen.getByTestId('designs-new-design-system'));
    expect(props.onNewDesignSystem).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('designs-open-library'));
    expect(props.onOpenLibrary).toHaveBeenLastCalledWith('design-systems');

    fireEvent.click(screen.getByTestId('designs-kind-motion'));
    fireEvent.click(screen.getByTestId('designs-new-motion'));
    expect(props.onNewMotion).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('designs-open-library'));
    expect(props.onOpenLibrary).toHaveBeenLastCalledWith('movies');
  });

  it('explains an empty filter while keeping the create action and library', () => {
    renderTab([project('plain-site')]);
    fireEvent.click(screen.getByTestId('designs-kind-designSystem'));
    expect(screen.getByText('No design systems of your own yet')).toBeInTheDocument();
    expect(screen.getByTestId('designs-new-design-system')).toBeInTheDocument();
    expect(screen.getByTestId('designs-open-library')).toBeInTheDocument();
  });
});
