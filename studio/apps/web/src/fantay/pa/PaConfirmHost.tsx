// SPDX-License-Identifier: AGPL-3.0-only
// One stop confirmation for the whole workspace (spec §12.6). Every stop button calls usePaStopConfirm()(taskId);
// the root renders <PaConfirmHost /> once, which shows a single destructive ConfirmDialog. The request carries the
// caller's own stop action, so the host never has to guess which workspace instance asked.
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../../i18n';
import { ConfirmDialog, toast } from '../ui';
import { usePa } from './pa-context';

interface StopRequest {
  taskId: string;
  stop: () => Promise<void>;
}

let request: StopRequest | null = null;
const listeners = new Set<() => void>();
/** Mounted hosts, oldest first; only the newest renders the dialog. */
let hosts: string[] = [];

function emit() {
  listeners.forEach((listener) => listener());
}

function setRequest(next: StopRequest | null) {
  request = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readRequest = () => request;
const readHosts = () => hosts;

export function PaConfirmHost() {
  const t = useT();
  const id = useId();
  const current = useSyncExternalStore(subscribe, readRequest, readRequest);
  const mounted = useSyncExternalStore(subscribe, readHosts, readHosts);
  const [busy, setBusy] = useState(false);
  // Radix asks to close right after the confirm click; a ref sees the busy flag in that same event.
  const busyRef = useRef(false);

  useEffect(() => {
    hosts = [...hosts, id];
    emit();
    return () => {
      hosts = hosts.filter((host) => host !== id);
      if (hosts.length === 0) request = null;
      emit();
    };
  }, [id]);

  if (mounted[mounted.length - 1] !== id) return null;

  const confirm = () => {
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void current
      .stop()
      .catch((error: unknown) => {
        toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        setRequest(null);
      });
  };

  return (
    <ConfirmDialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open && !busyRef.current) setRequest(null);
      }}
      destructive
      busy={busy}
      title={t('pa.stopConfirm.title')}
      description={t('pa.stopConfirm.body')}
      confirmLabel={t('pa.stop')}
      onConfirm={confirm}
    />
  );
}

/** Returns `(taskId) => void` that asks for confirmation, then stops the task (POST /tasks/:id/cancel). */
export function usePaStopConfirm(): (taskId: string) => void {
  const { actions } = usePa().data;
  return useCallback((taskId: string) => setRequest({ taskId, stop: () => actions.stopTask(taskId) }), [actions]);
}
