// SPDX-License-Identifier: AGPL-3.0-only
// What the owner's project groups add to the sidebar: the folder row's menu — rename, move up or down, delete with
// a confirmation that says the projects are kept — and the dialog that names a group, new or existing.
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Ellipsis, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { PROJECT_GROUP_NAME_MAX_LENGTH, type ProjectGroup } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { Button } from '../../ui/button';
import { ConfirmDialog, Modal, ModalActions, ModalLede, ModalTitle } from '../../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Input } from '../../ui/input';
import { useProjectOrganizationActions } from '../project-organization-store';
import { SECTION_ACTION_CLASS, SidebarSection, type SidebarSectionProps } from './SidebarSection';

interface GroupNameFormProps {
  initial: string;
  confirmLabel: string;
  testId: string;
  inputRef: RefObject<HTMLInputElement>;
  onCancel(): void;
  onSubmit(name: string): void;
}

/** Mounted with the dialog's content, so every opening starts from `initial`. A form: Enter submits, and an input
 *  method's Enter, which only ends its composition, does not. */
function GroupNameForm({ initial, confirmLabel, testId, inputRef, onCancel, onSubmit }: GroupNameFormProps) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const name = draft.trim();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name) onSubmit(name);
  };

  return (
    <form onSubmit={submit}>
      <Input
        ref={inputRef}
        inputSize="lg"
        aria-label={t('fantayShell.sidebar.groupNameLabel')}
        placeholder={t('fantayShell.sidebar.groupNameLabel')}
        value={draft}
        maxLength={PROJECT_GROUP_NAME_MAX_LENGTH}
        data-testid={testId}
        className="mt-4"
        onChange={(event) => setDraft(event.target.value)}
      />
      <ModalActions className="mt-4">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('fantay.ui.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={!name} data-testid={`${testId}-submit`}>
          {confirmLabel}
        </Button>
      </ModalActions>
    </form>
  );
}

export interface GroupNameDialogProps {
  open: boolean;
  /** The name being edited; a new group starts empty. */
  initial?: string;
  title: string;
  description?: string;
  confirmLabel: string;
  testId: string;
  onClose(): void;
  onSubmit(name: string): void;
}

export function GroupNameDialog({
  open,
  initial = '',
  title,
  description,
  confirmLabel,
  testId,
  onClose,
  onSubmit,
}: GroupNameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      {...(description ? {} : { 'aria-describedby': undefined })}
      onOpenAutoFocus={(event) => {
        // Radix would pick the × in the corner, the first control in the dialog.
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }}
    >
      <ModalTitle>{title}</ModalTitle>
      {description ? <ModalLede>{description}</ModalLede> : null}
      <GroupNameForm
        initial={initial}
        confirmLabel={confirmLabel}
        testId={testId}
        inputRef={inputRef}
        onCancel={onClose}
        onSubmit={onSubmit}
      />
    </Modal>
  );
}

/** The caption's 新建分组 button on the 项目 section. */
export function NewGroupButton({ onClick }: { onClick(): void }) {
  const t = useT();
  return (
    <IconButton
      size="sm"
      aria-label={t('fantayShell.sidebar.newGroup')}
      tooltipSide="right"
      data-testid="fantay-sidebar-new-group"
      className={SECTION_ACTION_CLASS}
      onClick={onClick}
    >
      <Icon icon={FolderPlus} size={14} />
    </IconButton>
  );
}

export interface SidebarGroupSectionProps extends Omit<SidebarSectionProps, 'id' | 'label' | 'folder' | 'actions' | 'add'> {
  group: ProjectGroup;
  first: boolean;
  last: boolean;
  onNewProject(): void;
  children: ReactNode;
}

export function SidebarGroupSection({ group, first, last, onNewProject, children, ...section }: SidebarGroupSectionProps) {
  const t = useT();
  const organization = useProjectOrganizationActions();
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const renameRequested = useRef(false);

  return (
    <>
      <SidebarSection
        {...section}
        id={`group:${group.id}`}
        label={group.name}
        folder
        add={{ label: t('fantayShell.sidebar.newProjectInGroup', { name: group.name }), onClick: onNewProject }}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="xs"
                aria-label={t('fantayShell.sidebar.groupActions', { name: group.name })}
                tooltipSide="right"
                data-testid={`fantay-sidebar-group-menu-${group.id}`}
                className="focus-visible:-outline-offset-2"
              >
                <Icon icon={Ellipsis} size={14} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              width="md"
              align="start"
              onCloseAutoFocus={(event) => {
                if (renameRequested.current) event.preventDefault();
                renameRequested.current = false;
              }}
            >
              <DropdownMenuItem
                icon={<Icon icon={Pencil} size={14} />}
                onSelect={() => {
                  renameRequested.current = true;
                  setRenaming(true);
                }}
              >
                {t('designs.menuRename')}
              </DropdownMenuItem>
              {first ? null : (
                <DropdownMenuItem icon={<Icon icon={ArrowUp} size={14} />} onSelect={() => organization.shiftGroup(group.id, -1)}>
                  {t('fantayShell.sidebar.moveGroupUp')}
                </DropdownMenuItem>
              )}
              {last ? null : (
                <DropdownMenuItem icon={<Icon icon={ArrowDown} size={14} />} onSelect={() => organization.shiftGroup(group.id, 1)}>
                  {t('fantayShell.sidebar.moveGroupDown')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                tone="danger"
                icon={<Icon icon={Trash2} size={14} />}
                data-testid={`fantay-sidebar-group-delete-${group.id}`}
                onSelect={() => setConfirmingDelete(true)}
              >
                {t('fantayShell.sidebar.deleteGroup')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        {children}
      </SidebarSection>
      <GroupNameDialog
        open={renaming}
        initial={group.name}
        title={t('fantayShell.sidebar.renameGroup')}
        confirmLabel={t('common.save')}
        testId={`fantay-sidebar-group-rename-${group.id}`}
        onClose={() => setRenaming(false)}
        onSubmit={(name) => {
          setRenaming(false);
          if (name !== group.name) organization.renameGroup(group.id, name);
        }}
      />
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('fantayShell.sidebar.deleteGroupTitle', { name: group.name })}
        description={t('fantayShell.sidebar.deleteGroupBody')}
        confirmLabel={t('fantayShell.sidebar.deleteGroup')}
        destructive
        onConfirm={() => organization.deleteGroup(group.id)}
      />
    </>
  );
}
