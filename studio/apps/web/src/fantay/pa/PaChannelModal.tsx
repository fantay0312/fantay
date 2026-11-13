// SPDX-License-Identifier: AGPL-3.0-only
// Channel modal (spec §14.6). Create mode: platform, name, route, permissions → POST /channels, then the
// same modal switches to edit mode. Edit mode: connection, Feishu credentials / local apps, pairing,
// WeChat QR + PIN, permissions (PATCH with the full input), verification facts, commands and history.
// Every section is a heading over one hairline group block (the settings recipe of spec §13).
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useI18n, useT } from '../../i18n';
import { openExternalUrl } from '../../providers/registry';
import {
  Button,
  Callout,
  ConfirmDialog,
  Field,
  Input,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  cn,
  toast,
} from '../ui';
import { usePa } from './pa-context';
import { PaModalFrame, PaSwitchRow, paErrorText, usePaModalReset, usePaReload, usePaSubmit } from './PaAgentModal';
import { ChannelStatusLabel, formatStamp, PaHistoryDisclosure, platformName, recentInbox } from './PaConnectionsPage';
import { PaDisclosure } from './PaDisclosure';
import type { PaChannel, PaChannelInput, PaChannelLogin, PaChannelPairing, PaIndex, PaLocalFeishuApp } from './pa-types';
import styles from './PaModals.module.css';

const FEISHU_CONSOLE = 'https://open.feishu.cn/app';
const QR_POLL_MS = 1200;
const LIVE_LOGIN: ReadonlyArray<PaChannelLogin['status']> = ['waiting', 'scanned', 'verify_code'];
const COMMANDS = [
  'pa.channel.cmdHelp',
  'pa.channel.cmdStatus',
  'pa.channel.cmdStop',
  'pa.channel.cmdResume',
  'pa.channel.cmdAmend',
  'pa.channel.cmdProject',
] as const;
const CAPABILITIES = {
  direct: 'pa.channel.cap.direct',
  groups: 'pa.channel.cap.groups',
  threads: 'pa.channel.cap.threads',
  files: 'pa.channel.cap.files',
  unsolicited: 'pa.channel.cap.unsolicited',
} as const satisfies Record<keyof PaChannel['capabilities'], string>;
/** Statuses where Connect is the next step (a WeChat sign-in that lapsed needs a new scan instead). */
const CONNECTABLE: ReadonlyArray<PaChannel['status']> = ['disconnected', 'error', 'paused'];

type Route = Pick<PaChannelInput, 'targetKind' | 'targetId'>;
interface Permissions extends Route {
  allowProject: boolean;
  shareGroupMemory: boolean;
}

const routeValue = (route: Route) => `${route.targetKind}:${route.targetId}`;

function parseRoute(value: string): Route | null {
  const split = value.indexOf(':');
  const kind = value.slice(0, split);
  const id = value.slice(split + 1);
  if ((kind !== 'agent' && kind !== 'group') || !id) return null;
  return { targetKind: kind, targetId: id };
}

function defaultRoute(index: PaIndex): Route {
  if (index.fantay) return { targetKind: 'agent', targetId: index.fantay.id };
  const group = index.groups.values().next().value;
  if (group) return { targetKind: 'group', targetId: group.id };
  return { targetKind: 'agent', targetId: index.agents.keys().next().value ?? '' };
}

function draftInput(index: PaIndex): PaChannelInput {
  return {
    type: 'feishu',
    name: '',
    ...defaultRoute(index),
    enabled: false,
    allowProject: false,
    shareGroupMemory: false,
    allowedSenderIds: [],
    remoteChatId: null,
    tenantId: null,
  };
}

/** The full PATCH body the daemon re-validates (omitting a field would reset it to its default). */
function inputOf(channel: PaChannel): PaChannelInput {
  return {
    type: channel.type,
    name: channel.name,
    targetKind: channel.targetKind,
    targetId: channel.targetId,
    enabled: channel.enabled,
    allowProject: channel.allowProject,
    shareGroupMemory: channel.shareGroupMemory,
    allowedSenderIds: channel.allowedSenderIds,
    remoteChatId: channel.remoteChatId,
    tenantId: channel.tenantId,
  };
}

function permissionsOf(channel: PaChannel): Permissions {
  return {
    targetKind: channel.targetKind,
    targetId: channel.targetId,
    allowProject: channel.allowProject,
    shareGroupMemory: channel.shareGroupMemory,
  };
}

const samePermissions = (a: Permissions, b: Permissions) =>
  a.targetKind === b.targetKind &&
  a.targetId === b.targetId &&
  a.allowProject === b.allowProject &&
  (a.targetKind !== 'group' || a.shareGroupMemory === b.shareGroupMemory);

/** Groups first, then agents (Fantay first); the current target stays listed even if it is gone. */
function RouteSelect({ id, value, onChange, className }: { id?: string; value: Route; onChange(route: Route): void; className?: string }) {
  const t = useT();
  const { index } = usePa();
  const groups = [...index.groups.values()];
  const agents = [...index.agents.values()].sort((a, b) => Number(b.id === index.fantay?.id) - Number(a.id === index.fantay?.id));
  const known = value.targetKind === 'group' ? index.groups.has(value.targetId) : index.agents.has(value.targetId);
  return (
    <Select
      value={value.targetId ? routeValue(value) : ''}
      onValueChange={(next) => {
        const route = parseRoute(next);
        if (route) onChange(route);
      }}
    >
      <SelectTrigger id={id} className={className ?? 'w-full'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {!known && value.targetId ? <SelectItem value={routeValue(value)}>{t('pa.memoryForm.deletedTarget')}</SelectItem> : null}
        {groups.length ? (
          <SelectGroup>
            <SelectLabel>{t('pa.groups')}</SelectLabel>
            {groups.map((group) => (
              <SelectItem key={group.id} value={`group:${group.id}`}>
                {group.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {agents.length ? (
          <SelectGroup>
            <SelectLabel>{t('pa.agents')}</SelectLabel>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={`agent:${agent.id}`} disabled={!agent.enabled && value.targetId !== agent.id}>
                {agent.enabled ? agent.name : `${agent.name} · ${t('pa.disabled')}`}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

export function PaChannelModal({ open, onClose, channelId }: { open: boolean; onClose(): void; channelId: string | null }) {
  const t = useT();
  const { locale } = useI18n();
  const { data, index, now } = usePa();
  const actions = data.actions;

  /* create → edit: the modal keeps its frame and swaps to the new channel */
  const [created, setCreated] = useState<PaChannel | null>(null);
  const id = channelId ?? created?.id ?? null;
  const channel = id ? (index.channels.get(id) ?? (created?.id === id ? created : null)) : null;

  const [draft, setDraft] = useState<PaChannelInput>(() => draftInput(index));
  const [perm, setPerm] = useState<Permissions | null>(() => (channel ? permissionsOf(channel) : null));
  const [permBase, setPermBase] = useState<Permissions | null>(perm);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [localApps, setLocalApps] = useState<PaLocalFeishuApp[] | null>(null);
  const [localId, setLocalId] = useState('');
  const [pairing, setPairing] = useState<PaChannelPairing | null>(null);
  const [login, setLogin] = useState<PaChannelLogin | null>(null);
  const [pin, setPin] = useState('');
  const [confirmForget, setConfirmForget] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const submit = usePaSubmit();
  const reload = usePaReload(channel, (latest) => {
    const next = permissionsOf(latest);
    setPerm(next);
    setPermBase(next);
  });
  const ids = { name: useId(), route: useId(), appId: useId(), appSecret: useId(), localApp: useId(), pin: useId(), editRoute: useId() };

  usePaModalReset(open, channelId ?? 'new', () => {
    setCreated(null);
    setDraft(draftInput(index));
    const next = channel && channelId ? permissionsOf(channel) : null;
    setPerm(next);
    setPermBase(next);
    setAppId('');
    setAppSecret('');
    setLocalApps(null);
    setLocalId('');
    setPairing(null);
    setLogin(null);
    setPin('');
    setConfirmForget(false);
    setBusy(null);
    submit.clear();
    reload.cancel();
  });

  /* Follow the live channel while the permissions are untouched. */
  const live = channel ? permissionsOf(channel) : null;
  const liveSignature = live ? JSON.stringify(live) : '';
  const dirty = !!perm && !!permBase && !samePermissions(perm, permBase);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!live || dirtyRef.current) return;
    setPerm(live);
    setPermBase(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialised permissions
  }, [liveSignature]);

  /* WeChat: pick up a sign-in already in progress, then poll every 1.2 s while it is live (the PIN
     step included: the daemon only moves past verify_code on its next poll). */
  const weixinId = open && channel?.type === 'weixin' ? channel.id : null;
  const signingIn = weixinId !== null && channel?.status === 'login_required';
  useEffect(() => {
    if (!weixinId || !signingIn) return;
    let cancelled = false;
    actions
      .pollWeixinLogin(weixinId)
      .then((current) => {
        if (!cancelled && LIVE_LOGIN.includes(current.status)) setLogin((previous) => previous ?? current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [weixinId, signingIn, actions]);
  const loginStatus = login?.status ?? null;
  useEffect(() => {
    if (!weixinId || !loginStatus || !LIVE_LOGIN.includes(loginStatus)) return;
    let cancelled = false;
    // pollWeixinLogin re-reads the channels itself once the sign-in is confirmed.
    const timer = setInterval(() => {
      actions
        .pollWeixinLogin(weixinId)
        .then((next) => {
          if (!cancelled) setLogin(next);
        })
        .catch(() => undefined);
    }, QR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [weixinId, loginStatus, actions]);

  const act = async (key: string, work: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    submit.setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      submit.setError(paErrorText(caught, t));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /* ── create mode ─────────────────────────────────────────────────────────────────────── */

  if (!id) {
    const valid = draft.name.trim().length > 0 && !!draft.targetId;
    const create = () => {
      if (!valid || submit.busy) return;
      const input: PaChannelInput = {
        ...draft,
        name: draft.name.trim(),
        shareGroupMemory: draft.targetKind === 'group' && draft.shareGroupMemory,
      };
      void submit.run(async () => {
        const next = await actions.createChannel(input);
        setCreated(next);
        const permissions = permissionsOf(next);
        setPerm(permissions);
        setPermBase(permissions);
      });
    };
    return (
      <PaModalFrame
        open={open}
        onClose={onClose}
        size="lg"
        title={t('pa.addChannel')}
        lede={t('pa.channelIntro')}
        error={submit.error}
        onSubmit={create}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('pa.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!valid} loading={submit.busy}>
              {t('pa.save')}
            </Button>
          </>
        }
      >
        <Field label={t('pa.platform')} labelVariant="form">
          <Segmented
            size="md"
            className="flex w-full"
            aria-label={t('pa.platform')}
            value={draft.type}
            onValueChange={(type) => setDraft((current) => ({ ...current, type: type as PaChannelInput['type'] }))}
          >
            <SegmentedItem value="feishu" className="min-w-0 flex-1">
              {t('pa.feishu')}
            </SegmentedItem>
            <SegmentedItem value="weixin" className="min-w-0 flex-1">
              {t('pa.weixin')}
            </SegmentedItem>
          </Segmented>
        </Field>
        <div className={styles.fields}>
          <Field label={t('pa.name')} htmlFor={ids.name} labelVariant="form">
            <Input
              id={ids.name}
              value={draft.name}
              maxLength={80}
              required
              autoComplete="off"
              placeholder={t('pa.channel.namePlaceholder')}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </Field>
          <Field label={t('pa.targetAssistant')} htmlFor={ids.route} labelVariant="form">
            <RouteSelect
              id={ids.route}
              value={draft}
              onChange={(route) => setDraft((current) => ({ ...current, ...route, shareGroupMemory: route.targetKind === 'group' && current.shareGroupMemory }))}
            />
          </Field>
        </div>
        {/* The same switch rows the edit mode's permissions group uses; both start off. */}
        <div className={styles.group}>
          <PaSwitchRow
            label={t('pa.allowProject')}
            hint={t('pa.channel.allowProjectHint')}
            checked={draft.allowProject}
            onChange={(allowProject) => setDraft((current) => ({ ...current, allowProject }))}
          />
          {draft.targetKind === 'group' ? (
            <PaSwitchRow
              label={t('pa.shareGroupMemory')}
              hint={t('pa.shareMemoryHelp')}
              checked={draft.shareGroupMemory}
              onChange={(shareGroupMemory) => setDraft((current) => ({ ...current, shareGroupMemory }))}
            />
          ) : null}
        </div>
      </PaModalFrame>
    );
  }

  /* ── edit mode ───────────────────────────────────────────────────────────────────────── */

  const stamp = (at: number | null) => (at ? formatStamp(at, locale, now) : t('pa.channel.never'));
  const permissions = perm ?? (channel ? permissionsOf(channel) : null);
  const capabilities = channel
    ? (Object.keys(CAPABILITIES) as Array<keyof typeof CAPABILITIES>).filter((key) => channel.capabilities[key]).map((key) => t(CAPABILITIES[key]))
    : [];
  const history = channel ? recentInbox(index.inbox, channel.id) : [];
  const canPair = !!channel && channel.enabled && channel.credentialConfigured;
  const loginMessage = login?.message?.trim() ?? '';
  const showLogin = !!login && (!!login.qrImagePath || !!loginMessage || login.status === 'verify_code');

  const savePermissions = () => {
    if (!channel || !permissions || !dirty || submit.busy) return;
    const input: PaChannelInput = {
      ...inputOf(channel),
      ...permissions,
      shareGroupMemory: permissions.targetKind === 'group' && permissions.shareGroupMemory,
    };
    const held = channel;
    void submit
      .run(
        () => actions.updateChannel(held, input),
        () => reload.expect(held.revision),
      )
      .then((ok) => {
        if (ok) setPermBase(permissions);
      });
  };

  const connectFeishu = (event: FormEvent) => {
    event.preventDefault();
    if (!channel || !appId.trim() || !appSecret.trim()) return;
    void act('feishu', () => actions.connectFeishu(channel.id, { appId: appId.trim(), appSecret: appSecret.trim() })).then((ok) => {
      if (!ok) return;
      setAppSecret('');
      toast({ tone: 'success', title: t('pa.channel.credentialsSaved') });
    });
  };

  const submitPin = (event: FormEvent) => {
    event.preventDefault();
    if (!channel || !/^\d{4,10}$/.test(pin)) return;
    void act('pin', async () => {
      setLogin(await actions.submitWeixinPin(channel.id, pin));
      setPin('');
    });
  };

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="lg"
      title={channel?.name ?? t('pa.channel')}
      lede={
        channel
          ? `${platformName(channel.type, t)} · ${channel.accountLabel ? t('pa.channel.account', { name: channel.accountLabel }) : t('pa.notVerified')}`
          : undefined
      }
      leading={
        channel ? (
          <span className={styles.platformTile} aria-hidden>
            {channel.type === 'feishu' ? '飞' : '微'}
          </span>
        ) : undefined
      }
      conflict={submit.conflict}
      error={submit.error}
      bodyClassName={styles.bodyLoose}
      footer={
        <>
          {/* Everything above Permissions applies at once, so with nothing pending the dismiss button
              reads Close; it becomes Cancel only while permission changes wait for Save. */}
          <Button variant="ghost" onClick={onClose}>
            {dirty ? t('pa.cancel') : t('common.close')}
          </Button>
          <Button variant="primary" disabled={!dirty} loading={submit.busy} onClick={savePermissions}>
            {t('pa.save')}
          </Button>
        </>
      }
    >
      {!channel ? (
        <Callout tone="error">{t('pa.error')}</Callout>
      ) : (
        <>
          <Section title={t('pa.channel.secConnection')}>
            <div className={styles.group}>
              <div className={styles.row}>
                <div className={styles.rowText}>
                  <ChannelStatusLabel status={channel.status} className={styles.statusStrong} />
                  {channel.lastError ? (
                    <div className={styles.rowError}>{channel.lastError}</div>
                  ) : !channel.credentialConfigured ? (
                    <div className={styles.rowHint}>
                      {channel.type === 'feishu' ? t('pa.channel.needsCredentials') : t('pa.channel.needsWechatLogin')}
                    </div>
                  ) : null}
                </div>
                <div className={styles.rowControl}>
                  {channel.credentialConfigured && CONNECTABLE.includes(channel.status) ? (
                    <Button size="sm" loading={busy === 'connect'} onClick={() => void act('connect', () => actions.connectChannel(channel.id))}>
                      {t('pa.connect')}
                    </Button>
                  ) : null}
                  {channel.enabled ? (
                    <Button
                      size="sm"
                      loading={busy === 'disconnect'}
                      onClick={() => void act('disconnect', () => actions.disconnectChannel(channel.id, false))}
                    >
                      {t('pa.disconnect')}
                    </Button>
                  ) : null}
                </div>
              </div>
              {channel.credentialConfigured ? (
                <div className={styles.row}>
                  <div className={styles.rowText}>
                    <div className={styles.rowLabel}>{t('pa.channel.credentialsRow')}</div>
                    <div className={styles.rowHint}>{t('pa.channel.credentialsHint')}</div>
                  </div>
                  <div className={styles.rowControl}>
                    <Button size="sm" className={styles.dangerQuiet} loading={busy === 'forget'} onClick={() => setConfirmForget(true)}>
                      {t('pa.channel.forgetShort')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </Section>

          {channel.type === 'feishu' ? (
            <>
              <Section title={t('pa.channel.secCredentials')}>
                <div className={styles.group}>
                  <PaDisclosure className={styles.rowDisclosure} label={<span className={styles.rowDisclosureLabel}>{t('pa.channel.useLocalApp')}</span>}>
                    <div className={styles.rowDisclosureBody}>
                      <Button
                        size="sm"
                        loading={busy === 'apps'}
                        onClick={() =>
                          void act('apps', async () => {
                            const apps = await actions.listLocalFeishuApps();
                            setLocalApps(apps);
                            setLocalId((current) => (apps.some((app) => app.appId === current) ? current : (apps[0]?.appId ?? '')));
                          })
                        }
                      >
                        {t('pa.refresh')}
                      </Button>
                      {localApps && localApps.length ? (
                        <>
                          <div className={styles.grow}>
                            <Select value={localId} onValueChange={setLocalId}>
                              <SelectTrigger id={ids.localApp} size="sm" className="w-full" aria-label={t('pa.importFeishu')}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {localApps.map((app) => (
                                  <SelectItem key={app.appId} value={app.appId}>
                                    {app.label === app.appId ? app.appId : `${app.label} · ${app.appId}`}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            size="sm"
                            disabled={!localId}
                            loading={busy === 'import'}
                            onClick={() =>
                              void act('import', () => actions.connectFeishu(channel.id, { localAppId: localId })).then((ok) => {
                                if (ok) toast({ tone: 'success', title: t('pa.channel.credentialsSaved') });
                              })
                            }
                          >
                            {t('pa.importConnect')}
                          </Button>
                        </>
                      ) : localApps ? (
                        <span className={styles.muted}>{t('pa.channel.noLocalApps')}</span>
                      ) : null}
                    </div>
                  </PaDisclosure>
                  {/* App ID, App Secret and the submit share one line, so the button closes the form it belongs to. */}
                  <form className={cn(styles.groupPad, styles.credentials)} noValidate onSubmit={connectFeishu}>
                    <Field label={t('pa.appId')} htmlFor={ids.appId} labelVariant="form">
                      <Input
                        id={ids.appId}
                        variant="mono"
                        value={appId}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="cli_…"
                        onChange={(event) => setAppId(event.target.value)}
                      />
                    </Field>
                    <Field label={t('pa.appSecret')} htmlFor={ids.appSecret} labelVariant="form">
                      <Input
                        id={ids.appSecret}
                        type="password"
                        variant="mono"
                        value={appSecret}
                        autoComplete="new-password"
                        onChange={(event) => setAppSecret(event.target.value)}
                      />
                    </Field>
                    <Button type="submit" disabled={!appId.trim() || !appSecret.trim()} loading={busy === 'feishu'}>
                      {t('pa.connectFeishu')}
                    </Button>
                  </form>
                  <div className={styles.note}>
                    <p className={styles.noteText}>{t('pa.feishuSetup')}</p>
                    <p className={styles.noteFaint}>{t('pa.feishuSharing')}</p>
                    <Button variant="link" size="sm" className={styles.noteLink} onClick={() => void openExternalUrl(FEISHU_CONSOLE)}>
                      {t('pa.feishuDocs')}
                      <span aria-hidden>↗</span>
                    </Button>
                  </div>
                </div>
              </Section>

              <Section title={t('pa.channel.secPairing')}>
                <div className={styles.group}>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <div className={styles.rowCopy}>{t('pa.channel.pairIntro')}</div>
                      {!canPair ? <div className={styles.rowHint}>{t('pa.channel.pairNeedsConnection')}</div> : null}
                    </div>
                    <div className={styles.rowControl}>
                      <Button
                        size="sm"
                        disabled={!canPair}
                        loading={busy === 'pair'}
                        onClick={() => void act('pair', async () => setPairing(await actions.pairChannel(channel.id)))}
                      >
                        {t('pa.pair')}
                      </Button>
                    </div>
                  </div>
                  {pairing?.code ? (
                    <div className={styles.groupPad}>
                      <div className={styles.caption}>{t('pa.channel.pairCodeLabel')}</div>
                      <div className={styles.codeRow}>
                        <code className={styles.code}>{pairing.code}</code>
                        <Button
                          className={styles.codeCopy}
                          onClick={() =>
                            void navigator.clipboard
                              ?.writeText(pairing.code)
                              .then(() => toast({ tone: 'success', title: t('pa.channel.copied') }))
                              .catch(() => undefined)
                          }
                        >
                          {t('pa.copyCode')}
                        </Button>
                      </div>
                      <p className={styles.muted}>{t('pa.channel.pairExpires')}</p>
                    </div>
                  ) : null}
                </div>
              </Section>
            </>
          ) : (
            <Section title={t('pa.channel.secWechat')}>
              <div className={styles.group}>
                <div className={styles.row}>
                  <div className={styles.rowText}>
                    <div className={styles.rowCopy}>{t('pa.wechatHelp')}</div>
                  </div>
                  <div className={styles.rowControl}>
                    <Button
                      size="sm"
                      loading={busy === 'login'}
                      onClick={() => void act('login', async () => setLogin(await actions.startWeixinLogin(channel.id)))}
                    >
                      {channel.credentialConfigured ? t('pa.reloginWechat') : t('pa.scanWechat')}
                    </Button>
                  </div>
                </div>
                {login && showLogin ? (
                  <div className={cn(styles.qrRow, !login.qrImagePath && styles.qrRowPlain)}>
                    {login.qrImagePath ? (
                      <div className={styles.qr}>
                        <img src={login.qrImagePath} width={240} height={240} alt={t('pa.qrAlt')} />
                      </div>
                    ) : null}
                    <div className={styles.qrSide}>
                      {loginMessage ? (
                        <p className={styles.qrMessage} role="status">
                          {loginMessage}
                        </p>
                      ) : null}
                      {login.status === 'verify_code' ? (
                        <form className={styles.pinForm} noValidate onSubmit={submitPin}>
                          {/* The daemon's status line already asks for the code; a caption only when it is silent. */}
                          {loginMessage ? null : (
                            <label htmlFor={ids.pin} className={styles.caption}>
                              {t('pa.pin')}
                            </label>
                          )}
                          <div className={styles.inline}>
                            <Input
                              id={ids.pin}
                              variant="mono"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              maxLength={10}
                              aria-label={t('pa.pin')}
                              placeholder="••••••"
                              className={styles.pin}
                              value={pin}
                              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 10))}
                            />
                            <Button type="submit" disabled={!/^\d{4,10}$/.test(pin)} loading={busy === 'pin'}>
                              {t('pa.verifyPin')}
                            </Button>
                          </div>
                        </form>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </Section>
          )}

          {permissions ? (
            <Section title={t('pa.permissions')}>
              <div className={styles.group}>
                <div className={styles.row}>
                  <div className={styles.rowText}>
                    <label htmlFor={ids.editRoute} className={styles.rowLabel}>
                      {t('pa.targetAssistant')}
                    </label>
                  </div>
                  <div className={styles.rowControl}>
                    <RouteSelect
                      id={ids.editRoute}
                      className={styles.routeSelect}
                      value={permissions}
                      onChange={(route) =>
                        setPerm({ ...permissions, ...route, shareGroupMemory: route.targetKind === 'group' && permissions.shareGroupMemory })
                      }
                    />
                  </div>
                </div>
                <PaSwitchRow
                  label={t('pa.allowProject')}
                  hint={t('pa.channel.allowProjectHint')}
                  checked={permissions.allowProject}
                  onChange={(allowProject) => setPerm({ ...permissions, allowProject })}
                />
                {permissions.targetKind === 'group' ? (
                  <PaSwitchRow
                    label={t('pa.shareGroupMemory')}
                    hint={t('pa.shareMemoryHelp')}
                    checked={permissions.shareGroupMemory}
                    onChange={(shareGroupMemory) => setPerm({ ...permissions, shareGroupMemory })}
                  />
                ) : null}
              </div>
              {dirty ? (
                <Callout tone="neutral" className={styles.notice}>
                  {t('pa.channel.permChangeWarn')}
                </Callout>
              ) : null}
            </Section>
          ) : null}

          <Section title={t('pa.channel.secVerification')}>
            <dl className={cn(styles.group, styles.facts)}>
              <div className={styles.fact}>
                <dt>{t('pa.pairedChat')}</dt>
                <dd className={channel.remoteChatId ? styles.mono : undefined}>{channel.remoteChatId ?? '—'}</dd>
              </div>
              <div className={styles.fact}>
                <dt>{t('pa.pairedSenders')}</dt>
                <dd className={channel.allowedSenderIds.length ? styles.mono : undefined}>
                  {channel.allowedSenderIds.length ? channel.allowedSenderIds.join(', ') : '—'}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>{t('pa.receiveTime')}</dt>
                <dd>{stamp(channel.verification.inboundAt ?? channel.lastReceivedAt)}</dd>
              </div>
              <div className={styles.fact}>
                <dt>{t('pa.replyTime')}</dt>
                <dd>{stamp(channel.verification.outboundAt ?? channel.lastSentAt)}</dd>
              </div>
              <div className={styles.fact}>
                <dt>{t('pa.conn.capabilities')}</dt>
                <dd>{capabilities.length ? capabilities.join(' · ') : '—'}</dd>
              </div>
            </dl>
          </Section>

          <div className={styles.disclosures}>
            <PaDisclosure className={styles.sectionDisclosure} label={t('pa.channel.commands')}>
              <div className={cn(styles.group, styles.commands)}>
                {COMMANDS.map((key) => {
                  const text = t(key);
                  const space = text.indexOf(' ');
                  return (
                    <div key={key} className={styles.command}>
                      <code className={styles.commandName}>{space > 0 ? text.slice(0, space) : text}</code>
                      <span className={styles.commandText}>{space > 0 ? text.slice(space + 1) : ''}</span>
                    </div>
                  );
                })}
              </div>
            </PaDisclosure>
            <PaHistoryDisclosure rows={history} showChannel={false} variant="modal" />
          </div>

          <ConfirmDialog
            open={confirmForget}
            onOpenChange={setConfirmForget}
            title={t('pa.channel.forget')}
            description={t('pa.channel.forgetBody')}
            confirmLabel={t('pa.channel.forget')}
            cancelLabel={t('pa.cancel')}
            destructive
            onConfirm={() => {
              setConfirmForget(false);
              void act('forget', () => actions.disconnectChannel(channel.id, true)).then((ok) => {
                if (ok) {
                  setPairing(null);
                  setLogin(null);
                }
              });
            }}
          />
        </>
      )}
    </PaModalFrame>
  );
}
