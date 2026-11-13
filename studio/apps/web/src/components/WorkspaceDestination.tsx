import type { WorkspaceCollabContext } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { useT } from '../i18n';
import { useTeamMembers, currentUserDirectoryEntry } from '../collab/useTeamMembers';
import type { Project } from '../types';
import { openExternalUrl } from '../providers/registry';
import styles from './WorkspaceDestination.module.css';

/** Legacy deep links use the same workspace identity and cloud management URL. */
export function WorkspaceDestination({ view, context, projects, onOpen }: {
  view: 'members' | 'board' | 'workspace-settings';
  context: WorkspaceCollabContext | null;
  projects: Project[];
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const directory = useTeamMembers(currentUserDirectoryEntry(context), context);
  const self = currentUserDirectoryEntry(context);
  const members = directory.members.length ? directory.members : self ? [self] : [];
  const title = t(view === 'members' ? 'entry.navMembers' : view === 'board' ? 'entry.navBoard' : 'entry.navWorkspaceSettings');
  const consoleUrl = context?.workspaceSettingsUrl;
  return (
    <section className={`entry-section ${styles.root}`} data-testid="workspace-destination">
      <header><h1>{title}</h1><p>{context?.workspaceName || context?.teamName || context?.displayName}</p></header>
      {view === 'members' ? <ul className={styles.list}>
        {members.map((member) => <li key={member.memberId}><span>{member.displayName}</span><span>{member.role}</span></li>)}
      </ul> : null}
      {view === 'board' ? <>
        <p>{t('entry.navProjects')} · {projects.length}</p>
        <ul className={styles.list}>
          {projects.map((project) => <li key={project.id}><Button variant="ghost" onClick={() => onOpen(project.id)}>{project.name}</Button></li>)}
        </ul>
      </> : null}
      <p>{t('settings.workspaceLede')}</p>
      {consoleUrl ? <Button onClick={() => void openExternalUrl(consoleUrl)}>{t('entry.navWorkspaceSettings')}</Button> : <p>{t('workspaceInvite.errorNoSession')}</p>}
    </section>
  );
}
