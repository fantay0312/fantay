import { useRef } from 'react';
import { RotateCcw, Shield, ShieldAlert, ShieldCheck, ShieldHalf } from 'lucide-react';
import {
  CHAT_EXECUTION_PERMISSIONS,
  isChatExecutionPermission,
  type ChatExecutionPermission,
} from '@open-design/contracts';
import { useT } from '../i18n';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../fantay/ui';
import styles from './ExecutionPermissionPicker.module.css';

const labels = {
  'read-only': 'chat.permission.readOnly',
  'workspace-write': 'chat.permission.workspaceWrite',
  'danger-full-access': 'chat.permission.fullAccess',
} as const;

const icons = {
  'read-only': ShieldCheck,
  'workspace-write': ShieldHalf,
  'danger-full-access': ShieldAlert,
};

interface Props {
  value: ChatExecutionPermission | null;
  supported: boolean;
  saving: boolean;
  onChange: (value: ChatExecutionPermission | null) => void;
}

export function ExecutionPermissionPicker({ value, supported, saving, onChange }: Props) {
  const t = useT();
  const closedByPointerRef = useRef(false);
  const label = t(value ? labels[value] : 'chat.permission.label');
  const accessibleLabel = value ? `${t('chat.permission.label')} · ${label}` : label;
  const Glyph = value ? icons[value] : Shield;
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) closedByPointerRef.current = false;
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(styles.trigger, 'od-tooltip')}
          data-permission={value ?? 'default'}
          loading={saving}
          aria-label={accessibleLabel}
          data-tooltip={accessibleLabel}
        >
          <Glyph aria-hidden size={15} className={styles.glyph} />
          <span className={styles.label}>{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={styles.menu}
        aria-label={t('chat.permission.label')}
        onPointerDown={() => {
          closedByPointerRef.current = true;
        }}
        onPointerDownOutside={() => {
          closedByPointerRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (closedByPointerRef.current) {
            closedByPointerRef.current = false;
            event.preventDefault();
          }
        }}
      >
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(next) => {
          if (isChatExecutionPermission(next)) onChange(next);
        }}>
          {CHAT_EXECUTION_PERMISSIONS.map((permission) => {
            const PermissionIcon = icons[permission];
            return (
              <DropdownMenuRadioItem
                key={permission}
                value={permission}
                disabled={!supported}
                textValue={t(labels[permission])}
                className={styles.item}
                data-permission={permission}
              >
                <span className={styles.itemIcon} aria-hidden>
                  <PermissionIcon size={16} />
                </span>
                <span className={styles.itemLabel}>{t(labels[permission])}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {value && (
          <>
            <DropdownMenuSeparator className={styles.separator} />
            <DropdownMenuItem className={cn(styles.item, styles.resetItem)} onSelect={() => onChange(null)}>
              <span className={styles.itemIcon} aria-hidden>
                <RotateCcw size={15} />
              </span>
              <span className={styles.itemLabel}>{t('chat.permission.reset')}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
