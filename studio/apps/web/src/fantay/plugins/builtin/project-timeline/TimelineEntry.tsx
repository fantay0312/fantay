// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { ArrowUpRight, BellPlus, BellRing, Bot, ChevronRight, File, Folder, Image, Play, UserRound } from 'lucide-react';

import { workspaceResourceUrl } from '../../../../collab/workspace-identity';
import { projectFileUrl } from '../../../../providers/registry';
import { navigate } from '../../../../router';
import { exactAgentDisplayName } from '../../../../utils/agentLabels';
import { Button } from '../../../ui/button';
import type { TimelineCopy } from './copy';
import { fileName, mediaKind, timelineFollowTarget, type TimelineEntry } from './timeline-model';
import styles from './timeline.module.css';

interface EntryProps {
  entry: TimelineEntry;
  copy: TimelineCopy;
  clock: Intl.DateTimeFormat;
  context: WorkspaceCollabContext | null;
  followed: boolean;
  onToggleFollow(): void;
}

function FollowButton({ entry, copy, followed, onToggleFollow }: Pick<EntryProps, 'entry' | 'copy' | 'followed' | 'onToggleFollow'>) {
  const { kind } = timelineFollowTarget(entry);
  const label = followed ? copy[`unfollow_${kind}`] : copy[`follow_${kind}`];
  const Icon = followed ? BellRing : BellPlus;
  return (
    <Button type="button" variant="bare" size="sm" className={styles.followButton}
      aria-label={label} title={label} aria-pressed={followed} onClick={onToggleFollow}>
      <Icon size={13} aria-hidden />{followed ? copy.followed : copy.follow}
    </Button>
  );
}

function Media({ path, url, inline, errorText }: { path: string; url: string; inline?: boolean; errorText: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={styles.mediaFallback}>{errorText}</span>;
  if (mediaKind(path) === 'video') {
    return <span className={styles.video}>
      <video aria-label={fileName(path)} src={url} preload={inline ? 'none' : 'metadata'} controls={!inline}
        playsInline onError={() => setFailed(true)} />
      {inline ? <span className={styles.play}><Play aria-hidden size={20} /></span> : null}
    </span>;
  }
  return <img src={url} alt={fileName(path)} loading={inline ? 'lazy' : 'eager'} onError={() => setFailed(true)} />;
}

function artifactUrl(projectId: string, path: string, context: WorkspaceCollabContext | null) {
  return workspaceResourceUrl(projectFileUrl(projectId, path), context);
}

function openEntry(entry: TimelineEntry, file: string | null = null) {
  if (entry.project) {
    navigate({ kind: 'project', projectId: entry.project.id, conversationId: entry.conversationId, fileName: file });
  }
}

function Source({ entry, copy }: Pick<EntryProps, 'entry' | 'copy'>) {
  if (entry.kind === 'note') return <><UserRound size={13} aria-hidden />{copy.you}</>;
  if (entry.kind === 'created') return <><Folder size={13} aria-hidden />{entry.project?.name}</>;
  return <><Bot size={14} aria-hidden />{exactAgentDisplayName(entry.agentId) ?? copy.agent}</>;
}

export function TimelineCard({ entry, copy, clock, context, followed, onToggleFollow, selected, progress, onSelect }: EntryProps & {
  selected: boolean;
  progress?: boolean;
  onSelect(): void;
}) {
  const cover = entry.files.find(path => mediaKind(path));
  const firstFile = cover ?? entry.files[0];
  const at = progress ? entry.completedAt ?? entry.at : entry.at;
  return (
    <li className={styles.item} data-entry-id={entry.id} data-kind={entry.kind} data-selected={selected || undefined}>
      <article className={styles.card}>
        <div className={styles.cardMeta}>
          <span className={styles.projectName}>{entry.project?.name ?? copy.you}</span>
          <div className={styles.cardActions}>
            <time dateTime={new Date(at).toISOString()}>{clock.format(at)}</time>
            <FollowButton entry={entry} copy={copy} followed={followed} onToggleFollow={onToggleFollow} />
          </div>
        </div>
        <Button type="button" variant="bare" className={styles.entryAction} aria-pressed={selected}
          onClick={onSelect}>
          <span className={styles.entryTitle}>{copy[entry.kind]}</span>
          <ChevronRight aria-hidden size={15} />
        </Button>
        {cover && entry.project ? <Button variant="bare" className={styles.cover} onClick={onSelect}
          aria-label={`${copy.preview} · ${fileName(cover)}`}>
          <Media key={cover} path={cover} url={artifactUrl(entry.project.id, cover, context)} inline errorText={copy.fileUnavailable} />
        </Button> : null}
        {entry.text ? <p className={styles.summary}>{entry.text}</p> : null}
        {entry.kind !== 'created' && entry.project ? <div className={styles.cardFoot}>
          <span><Source entry={entry} copy={copy} /></span>
          {firstFile ? <span title={fileName(firstFile)}>
            {cover ? <Image aria-hidden size={14} /> : <File aria-hidden size={14} />}
            <span className={styles.ellipsis}>{fileName(firstFile)}</span>
            {entry.files.length > 1 ? <span>+{entry.files.length - 1}</span> : null}
          </span> : null}
        </div> : null}
      </article>
    </li>
  );
}

export function TimelineEntryDetails({ entry, copy, clock, context, followed, onToggleFollow }: EntryProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const preview = selectedFile && entry.files.includes(selectedFile)
    ? selectedFile
    : entry.files.find(path => mediaKind(path));
  const at = entry.completedAt ?? entry.at;
  return (
    <div className={styles.detailBody}>
      <div className={styles.detailHead}>
        {entry.project ? <p>{entry.project.name}</p> : null}
        <h3>{copy[entry.kind]}</h3>
        <div className={styles.detailMeta}>
          {entry.kind !== 'created' ? <span><Source entry={entry} copy={copy} /></span> : null}
          <time dateTime={new Date(at).toISOString()}>
            {new Intl.DateTimeFormat(clock.resolvedOptions().locale, {
              dateStyle: 'medium', timeStyle: 'short',
            }).format(at)}
          </time>
          <FollowButton entry={entry} copy={copy} followed={followed} onToggleFollow={onToggleFollow} />
        </div>
      </div>
      {preview && entry.project ? <>
        <div className={styles.detailMedia}>
          <Media key={preview} path={preview} url={artifactUrl(entry.project.id, preview, context)}
            errorText={copy.fileUnavailable} />
        </div>
        <p className={styles.fileHint}>{copy.currentFile}</p>
      </> : null}
      {entry.text ? <p className={styles.summary}>{entry.text}</p> : null}
      {entry.project && entry.files.length ? <div className={styles.fileSection}>
        <h4>{copy.files}</h4>
        <ul>
          {entry.files.map(path => (
            <li key={path}>
              {mediaKind(path) ? <Button variant="ghost" size="sm" className={styles.fileChoice}
                aria-pressed={preview === path} onClick={() => setSelectedFile(path)}>
                <Image size={14} aria-hidden /><span>{fileName(path)}</span>
              </Button> : <span className={styles.fileName}><File size={14} aria-hidden />{fileName(path)}</span>}
              <Button variant="ghost" size="sm" aria-label={`${copy.openProject} · ${fileName(path)}`}
                title={path} onClick={() => openEntry(entry, path)}><ArrowUpRight size={15} aria-hidden /></Button>
            </li>
          ))}
        </ul>
      </div> : null}
      {entry.project ? <Button variant="secondary" size="sm" className={styles.openSource} onClick={() => openEntry(entry)}>
        {entry.conversationId ? copy.openConversation : copy.openProject}<ArrowUpRight aria-hidden size={15} />
      </Button> : null}
    </div>
  );
}
