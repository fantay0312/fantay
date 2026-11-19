// SPDX-License-Identifier: AGPL-3.0-only
// Admin console of the Fantay organization server. It only calls the management API with the signed-in member's
// token, so it can never do more than that member may: what a role cannot do is hidden here and refused there.
import type {
  OrgAuditEvent, OrgCustomRole, OrgGroup, OrgInfo, OrgIssuedToken, OrgLibraryAudience, OrgLibraryItem, OrgLibraryKind,
  OrgLibrarySummary, OrgMember, OrgPermission, OrgPlan, OrgPublicInfo, OrgRole, OrgScimStatus, OrgServiceScope,
  OrgServiceToken, OrgSession, OrgSsoConfig,
} from '@open-design/contracts/org';
import { Api, storeToken, storedToken } from './api.js';
import {
  badge, button, checkList, chips, confirmDialog, empty, failed, field, formatDate, formatTime, group, h, modal, note, reveal, row,
  segmented, select, table, textArea, textInput, toast, toggle, type Child,
} from './ui.js';

// ---- words ---------------------------------------------------------------------------------------------------------
const ROLE: Record<OrgRole, string> = { owner: '所有者', admin: '管理员', member: '成员', viewer: '访客' };
const PLAN: Record<OrgPlan, string> = { team: '团队版', enterprise: '企业版' };
const PERMISSION: Record<OrgPermission, { label: string; hint: string }> = {
  'org.manage': { label: '组织与策略', hint: '组织名称、策略、身份接入和服务凭据' },
  'roles.manage': { label: '角色分配', hint: '指派管理员和所有者，定义和分配自定义角色' },
  'members.manage': { label: '成员管理', hint: '添加、停用、移除成员和访客，轮换其令牌' },
  'groups.manage': { label: '用户组', hint: '新建、修改和删除用户组' },
  'library.manage': { label: '管理角色库', hint: '新建、编辑、发布和下架角色、世界书、文风' },
  'library.read': { label: '读取角色库', hint: '查看已发布的条目' },
  'chat.use': { label: '与角色对话', hint: '对话、人设和记忆只属于成员本人' },
  'audit.read': { label: '审计日志', hint: '读取和校验审计日志' },
};
const GRANTABLE: OrgPermission[] = ['members.manage', 'groups.manage', 'library.manage', 'library.read', 'chat.use', 'audit.read'];
const KIND: Record<OrgLibraryKind, string> = { character: '角色', lorebook: '世界书', preset: '文风' };
const STATUS = { draft: ['草稿', 'neutral'], published: ['已发布', 'good'], retired: ['已下架', 'warn'] } as const;
const SCOPE: Record<OrgServiceScope, { label: string; hint: string }> = {
  'directory.sync': { label: '成员目录同步', hint: 'Fantay 守护进程拉取成员、角色和令牌摘要' },
  'library.sync': { label: '角色库同步', hint: 'Fantay 守护进程拉取全部已发布条目' },
};
const AUDIT: Record<string, string> = {
  'org.created': '创建组织', 'org.updated': '修改组织', 'org.plan.changed': '变更套餐', 'org.transferred': '移交组织',
  'member.added': '添加成员', 'member.updated': '修改成员', 'member.role.changed': '变更角色', 'member.removed': '移除成员',
  'member.token.rotated': '轮换令牌', 'member.token.revoked': '吊销令牌', 'member.provisioned.sso': '单点登录加入',
  'member.provisioned.scim': 'SCIM 添加成员', 'member.updated.scim': 'SCIM 修改成员', 'member.removed.scim': 'SCIM 移除成员',
  'group.created': '新建用户组', 'group.updated': '修改用户组', 'group.deleted': '删除用户组', 'group.created.scim': 'SCIM 新建用户组',
  'group.updated.scim': 'SCIM 修改用户组', 'role.created': '新建自定义角色', 'role.updated': '修改自定义角色', 'role.deleted': '删除自定义角色',
  'library.created': '新建角色库条目', 'library.updated': '修改角色库条目', 'library.published': '发布条目', 'library.retired': '下架条目',
  'library.deleted': '删除条目', 'library.asset.saved': '上传图片', 'service-token.created': '新建服务凭据', 'service-token.deleted': '删除服务凭据',
  'sso.updated': '修改单点登录', 'sso.signed-in': '单点登录', 'scim.token.created': '生成 SCIM 令牌', 'scim.token.deleted': '停用 SCIM',
};
const SSO_ERROR: Record<string, string> = {
  ORG_SSO_DISABLED: '组织没有启用单点登录。', ORG_SSO_NOT_MEMBER: '你还不是这个组织的成员，请联系管理员添加。',
  ORG_SSO_DOMAIN: '这个邮箱域名不在允许范围内。', ORG_SSO_SUSPENDED: '账号已停用，请联系管理员。',
  ORG_SSO_REJECTED: '身份提供方的登录结果没有通过校验，请重试。', ORG_SSO_PROVIDER: '无法连接身份提供方，请稍后重试。',
  ORG_RATE_LIMITED: '尝试次数过多，请稍后再试。', ORG_LIMIT: '成员数已达到套餐上限。',
};
const TTL = [30, 90, 180, 365].map(days => ({ value: String(days), label: `${days} 天` }));

// ---- state ---------------------------------------------------------------------------------------------------------
type SectionId = 'overview' | 'members' | 'groups' | 'roles' | 'library' | 'policy' | 'identity' | 'tokens' | 'audit';
interface Ctx { api: Api; me: OrgSession; can(permission: OrgPermission): boolean; reload(): void }
const root = document.getElementById('app') as HTMLElement;
let section: SectionId = 'overview';
let generation = 0;

function applyTheme(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const set = () => { document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'; };
  set();
  dark.addEventListener('change', set);
}
const page = (title: string, lead: string, actions: Child, ...body: Child[]): HTMLElement =>
  h('div', { class: 'page' }, h('header', { class: 'page-head' }, h('div', { class: 'page-text' }, h('h1', null, title), h('p', null, lead)), h('div', { class: 'page-actions' }, actions)), body);
const planNote = (ctx: Ctx): HTMLElement =>
  note(`这是企业版功能，当前套餐是${PLAN[ctx.me.org.plan]}。${ctx.me.member.primary ? '可以在“概览”里变更套餐。' : '需要主要所有者变更套餐。'}`);
const ttlOf = (control: HTMLSelectElement): number => Number(control.value);
const lines = (value: string): string[] => value.split(/[\s,，、;；]+/).map(item => item.trim()).filter(Boolean);
/** Whether the signed-in member may act on `target`: never on themselves or the primary owner; admins and owners
 *  answer to owners only. The server applies the same rule. */
const administers = (me: OrgSession, target: OrgMember): boolean =>
  !target.primary && target.id !== me.member.id && (me.member.role === 'owner' || target.role === 'member' || target.role === 'viewer');
function showToken(title: string, issued: OrgIssuedToken, what: string): void {
  reveal(title, issued.token, `${what}只显示这一次，服务器只保存它的摘要。请现在复制并妥善保管，有效期至 ${formatDate(issued.expiresAt)}。`);
}

// ---- sign-in -------------------------------------------------------------------------------------------------------
async function showLogin(message: string | null): Promise<void> {
  const info = await fetch('/v1/public', { cache: 'no-store' }).then(response => response.json() as Promise<OrgPublicInfo>).catch(() => null);
  const token = textInput({ type: 'password', placeholder: '以 fto_ 开头的访问令牌', required: true, autocomplete: 'off', maxLength: 256 });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: !message }, message ?? '');
  const submit = button('登录', { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'login-form' }, field('访问令牌', token), error, submit,
    info?.sso ? h('a', { class: 'btn btn-secondary', href: '/v1/sso/start' }, '使用单点登录') : null);
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit.disabled = true;
    enter(token.value.trim()).catch(() => {
      storeToken('');
      error.textContent = '访问令牌无效、已过期，或账号已停用。';
      error.hidden = false;
      submit.disabled = false;
    });
  });
  root.replaceChildren(h('main', { class: 'login' }, h('div', { class: 'login-card' },
    h('p', { class: 'eyebrow' }, 'Fantay 企业管理'),
    h('h1', null, info?.name ?? '组织服务器'),
    info && !info.initialized
      ? note('组织尚未初始化。请在服务器上运行 init 命令创建组织和主要所有者，再回到这里登录。', 'warn')
      : [h('p', { class: 'login-lead' }, '管理成员、角色和共享角色库。成员的对话和记忆不会保存在这里。'), form])));
  if (!info || info.initialized) token.focus();
}
async function enter(token: string): Promise<void> {
  const api = new Api(token, () => { storeToken(''); void showLogin('登录已失效，请重新登录。'); });
  const me = await api.get<OrgSession>('/v1/me');
  storeToken(token);
  const ctx: Ctx = { api, me, can: permission => me.permissions.includes(permission), reload: () => { void enter(token).catch(failed); } };
  renderShell(ctx);
}

// ---- shell ---------------------------------------------------------------------------------------------------------
const SECTIONS: Array<{ id: SectionId; label: string; show(ctx: Ctx): boolean; render(ctx: Ctx): Promise<Child> }> = [
  { id: 'overview', label: '概览', show: () => true, render: overview },
  { id: 'members', label: '成员', show: ctx => ctx.can('members.manage') || ctx.can('roles.manage'), render: members },
  { id: 'groups', label: '用户组', show: ctx => ctx.can('members.manage') || ctx.can('groups.manage'), render: groups },
  { id: 'roles', label: '自定义角色', show: ctx => ctx.can('roles.manage'), render: roles },
  { id: 'library', label: '角色库', show: ctx => ctx.can('library.read'), render: library },
  { id: 'policy', label: '策略', show: () => true, render: policy },
  { id: 'identity', label: '身份接入', show: ctx => ctx.can('org.manage'), render: identity },
  { id: 'tokens', label: '服务凭据', show: ctx => ctx.can('org.manage'), render: tokens },
  { id: 'audit', label: '审计日志', show: ctx => ctx.can('audit.read') || ctx.me.member.role === 'owner', render: audit },
];
function renderShell(ctx: Ctx): void {
  const shown = SECTIONS.filter(item => item.show(ctx));
  if (!shown.some(item => item.id === section)) section = 'overview';
  const main = h('main', { class: 'main' });
  const nav = h('nav', { class: 'nav', 'aria-label': '管理' }, shown.map(item => {
    const link = h('button', { class: 'nav-item', type: 'button', 'aria-current': item.id === section ? 'page' : false }, item.label);
    link.addEventListener('click', () => { section = item.id; renderShell(ctx); });
    return link;
  }));
  const signOut = button('退出', { variant: 'ghost', onClick: () => {
    void (ctx.me.auth === 'session' ? ctx.api.post('/v1/logout').catch(() => undefined) : Promise.resolve()).then(() => { storeToken(''); void showLogin(null); });
  } });
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'side-head' }, h('p', { class: 'eyebrow' }, 'Fantay 企业管理'), h('strong', { class: 'side-org' }, ctx.me.org.name), badge(PLAN[ctx.me.org.plan], 'info')),
      nav,
      h('div', { class: 'side-foot' },
        h('div', { class: 'side-me' }, h('strong', null, ctx.me.member.name), h('small', null, ROLE[ctx.me.member.role]), h('small', null, ctx.me.member.email)), signOut)),
    main));
  const mine = ++generation;
  main.replaceChildren(h('p', { class: 'loading' }, '正在加载…'));
  const current = shown.find(item => item.id === section) ?? shown[0]!;
  current.render({ ...ctx, reload: () => renderShell(ctx) }).then(
    content => { if (mine === generation) main.replaceChildren(h('div', { class: 'main-inner' }, content)); },
    error => { if (mine === generation) main.replaceChildren(h('div', { class: 'main-inner' }, note(error instanceof Error ? error.message : '加载失败', 'warn'))); },
  );
}

// ---- 概览 ----------------------------------------------------------------------------------------------------------
async function overview(ctx: Ctx): Promise<Child> {
  const { api, me } = ctx;
  const org = await api.get<OrgInfo>('/v1/org');
  const rename = () => {
    const name = textInput({ value: org.name, required: true, maxLength: 80 });
    modal({ title: '修改组织名称', body: field('名称', name), submit: async () => { await api.patch('/v1/org', { name: name.value, revision: org.revision }); location.reload(); } });
  };
  const changePlan = () => {
    const plan = segmented<OrgPlan>([{ value: 'team', label: '团队版' }, { value: 'enterprise', label: '企业版' }], org.plan);
    modal({
      title: '变更套餐',
      body: [field('套餐', plan.node), note('企业版增加用户组、自定义角色、按组可见的角色库条目、审计日志和 SCIM。降回团队版时，这些内容保留在库里但不再生效。')],
      submit: async () => { await api.post('/v1/org/plan', { plan: plan.value, revision: org.revision }); location.reload(); },
    });
  };
  const rotate = () => confirmDialog('轮换我的访问令牌', '新令牌生成后，旧令牌立即失效。使用旧令牌的 Fantay 桌面端需要换成新令牌。', '轮换', async () => {
    const issued = await api.post<OrgIssuedToken>(`/v1/members/${me.member.id}/token`, {});
    if (me.auth === 'token') { storeToken(issued.token); await enter(issued.token); }
    showToken('新的访问令牌', issued, '令牌');
  }, false);
  const revoke = () => confirmDialog('吊销我的访问令牌', me.auth === 'token' ? '吊销后你会立即退出，之后需要管理员为你签发新令牌。' : '吊销后，使用这个令牌的 Fantay 桌面端无法再连接组织。', '吊销', async () => {
    await api.remove(`/v1/members/${me.member.id}/token`);
    if (me.auth === 'token') { storeToken(''); await showLogin('访问令牌已吊销。'); } else toast('访问令牌已吊销');
  });
  const transfer = async () => {
    const all = (await api.get<OrgMember[]>('/v1/members')).filter(item => item.id !== me.member.id && item.status === 'active');
    if (!all.length) { toast('没有可以接手的在职成员', 'bad'); return; }
    const target = select(all.map(item => ({ value: item.id, label: `${item.name}（${item.email}）` })), all[0]!.id);
    modal({
      title: '移交组织', danger: true, submitLabel: '移交',
      body: [field('新的主要所有者', target), note('移交后对方成为主要所有者，你保留所有者角色。主要所有者只有一位，只有本人可以再次移交。', 'warn')],
      submit: async () => { await api.post('/v1/org/transfer', { memberId: target.value }); location.reload(); },
    });
  };
  return page('概览', '组织、你的身份和你的访问令牌。', null,
    group('组织',
      row('名称', org.name, ctx.can('org.manage') ? button('修改', { onClick: rename }) : null),
      row('套餐', badge(PLAN[org.plan], 'info'), me.member.primary ? button('变更套餐', { onClick: changePlan }) : null),
      row('组织编号', h('code', null, org.id))),
    group('我的身份',
      row('姓名', me.member.name), row('邮箱', me.member.email),
      row('角色', [ROLE[me.member.role], me.member.primary ? ' · 主要所有者' : '']),
      row('登录方式', me.auth === 'session' ? '单点登录' : '访问令牌'),
      row('权限', chips(me.permissions.map(permission => PERMISSION[permission].label)))),
    group('我的访问令牌',
      row('用途', 'Fantay 桌面端用访问令牌连接组织。每位成员同一时间只有一个有效令牌。', [button('轮换', { onClick: rotate }), button('吊销', { variant: 'danger', onClick: revoke })])),
    me.member.primary ? group('移交组织', row('主要所有者', '把组织交给另一位在职成员。', button('移交', { variant: 'danger', onClick: () => { void transfer().catch(failed); } }))) : null,
    note('成员与角色的对话、消息和记忆只保存在成员自己的 Fantay 里。这台服务器不接收这些内容，任何角色都无法在这里读到。'));
}

// ---- 成员 ----------------------------------------------------------------------------------------------------------
async function members(ctx: Ctx): Promise<Child> {
  const { api, me } = ctx;
  const features = me.features;
  const [list, groupList, roleList] = await Promise.all([
    api.get<OrgMember[]>('/v1/members'),
    features.groups ? api.get<OrgGroup[]>('/v1/groups') : Promise.resolve([] as OrgGroup[]),
    features.customRoles ? api.get<OrgCustomRole[]>('/v1/roles') : Promise.resolve([] as OrgCustomRole[]),
  ]);
  const groupName = new Map(groupList.map(item => [item.id, item.name]));
  const roleName = new Map(roleList.map(item => [item.id, item.name]));
  const manage = ctx.can('members.manage'), assign = ctx.can('roles.manage'), editGroups = features.groups && ctx.can('groups.manage');
  const groupChecks = (selected: readonly string[]) => checkList(groupList.map(item => ({ value: item.id, label: item.name })), selected);

  const add = () => {
    const name = textInput({ required: true, maxLength: 80 }), email = textInput({ type: 'email', required: true, maxLength: 200 });
    const role = segmented<OrgRole>([
      { value: 'member', label: '成员' }, { value: 'viewer', label: '访客' },
      { value: 'admin', label: '管理员', disabled: !assign }, { value: 'owner', label: '所有者', disabled: !assign },
    ], 'member');
    const inGroups = groupChecks([]);
    const ttl = select(TTL, '90');
    modal({
      title: '添加成员', submitLabel: '添加',
      body: [field('姓名', name), field('邮箱', email),
        field('角色', role.node, assign ? '访客只能查看角色库，不能对话。' : '管理员和所有者只能由所有者添加。'),
        editGroups && groupList.length ? field('用户组', inGroups.node) : null, field('令牌有效期', ttl)],
      submit: async () => {
        const created = await api.post<{ member: OrgMember; token: OrgIssuedToken }>('/v1/members', {
          name: name.value, email: email.value, role: role.value, tokenTtlDays: ttlOf(ttl), ...(editGroups ? { groupIds: inGroups.values } : {}),
        });
        ctx.reload();
        showToken(`${created.member.name} 的访问令牌`, created.token, '令牌');
      },
    });
  };
  const edit = (target: OrgMember) => {
    const name = textInput({ value: target.name, required: true, maxLength: 80 }), email = textInput({ value: target.email, type: 'email', required: true });
    const inGroups = groupChecks(target.groupIds);
    modal({
      title: `编辑 ${target.name}`,
      body: [field('姓名', name), field('邮箱', email), editGroups && groupList.length ? field('用户组', inGroups.node) : null],
      submit: async () => {
        await api.patch(`/v1/members/${target.id}`, { name: name.value, email: email.value, revision: target.revision, ...(editGroups ? { groupIds: inGroups.values } : {}) });
        ctx.reload();
      },
    });
  };
  const changeRole = (target: OrgMember) => {
    const role = segmented<OrgRole>((['owner', 'admin', 'member', 'viewer'] as const).map(value => ({ value, label: ROLE[value] })), target.role);
    const custom = checkList(roleList.map(item => ({ value: item.id, label: item.name, hint: item.permissions.map(permission => PERMISSION[permission].label).join('、') })), target.customRoleIds);
    modal({
      title: `${target.name} 的角色`,
      body: [field('内置角色', role.node), features.customRoles && roleList.length ? field('自定义角色', custom.node, '自定义角色在内置角色之上叠加权限。') : null],
      submit: async () => {
        await api.post(`/v1/members/${target.id}/role`, { role: role.value, revision: target.revision, ...(features.customRoles ? { customRoleIds: custom.values } : {}) });
        ctx.reload();
      },
    });
  };
  const setStatus = (target: OrgMember, status: 'active' | 'suspended') => {
    const run = async () => { await api.patch(`/v1/members/${target.id}`, { status, revision: target.revision }); ctx.reload(); };
    if (status === 'active') void run().catch(failed);
    else confirmDialog(`停用 ${target.name}`, '停用后对方的令牌立即失效，已委托的任务不再继续。可以随时恢复。', '停用', run);
  };
  const rotate = (target: OrgMember) => confirmDialog(`为 ${target.name} 轮换令牌`, '新令牌生成后，对方的旧令牌立即失效。', '轮换', async () => {
    const issued = await api.post<OrgIssuedToken>(`/v1/members/${target.id}/token`, {});
    ctx.reload();
    showToken(`${target.name} 的访问令牌`, issued, '令牌');
  }, false);
  const remove = (target: OrgMember) => confirmDialog(`移除 ${target.name}`, '移除后对方无法再连接组织。对方 Fantay 里的对话和记忆不受影响。', '移除', async () => {
    await api.remove(`/v1/members/${target.id}`);
    ctx.reload();
  });

  const search = textInput({ placeholder: '搜索姓名或邮箱' });
  search.classList.add('search');
  const holder = h('div');
  const draw = () => {
    const query = search.value.trim().toLowerCase();
    const shown = list.filter(item => !query || item.name.toLowerCase().includes(query) || item.email.toLowerCase().includes(query));
    holder.replaceChildren(table<OrgMember>([
      { title: '成员', width: 'minmax(200px, 1.4fr)', cell: item => h('span', { class: 'cell-main' }, h('strong', null, item.name), h('small', null, item.email)) },
      { title: '角色', width: '128px', cell: item => h('span', { class: 'cell-main' },
        h('span', null, ROLE[item.role], item.primary ? ' · 主要' : ''),
        item.customRoleIds.length ? h('small', null, item.customRoleIds.map(id => roleName.get(id) ?? id).join('、')) : null) },
      { title: '状态', width: '72px', cell: item => (item.status === 'active' ? badge('在职', 'good') : badge('已停用', 'warn')) },
      ...(features.groups ? [{ title: '用户组', width: 'minmax(96px, 1fr)', cell: (item: OrgMember) => chips(item.groupIds.map(id => groupName.get(id) ?? id)) }] : []),
      { title: '令牌到期', width: '96px', cell: item => (item.hasToken ? formatDate(item.tokenExpiresAt) : h('span', { class: 'muted' }, '无')) },
      { title: '操作', width: '236px', align: 'end', cell: item => {
        if (!administers(me, item)) return h('span', { class: 'muted' }, item.id === me.member.id ? '本人' : '由所有者管理');
        return h('span', { class: 'actions' },
          manage ? button('编辑', { variant: 'ghost', onClick: () => edit(item) }) : null,
          assign ? button('角色', { variant: 'ghost', onClick: () => changeRole(item) }) : null,
          manage && item.status === 'active' ? button('令牌', { variant: 'ghost', onClick: () => rotate(item) }) : null,
          manage ? button(item.status === 'active' ? '停用' : '恢复', { variant: 'ghost', onClick: () => setStatus(item, item.status === 'active' ? 'suspended' : 'active') }) : null,
          manage ? button('移除', { variant: 'danger', onClick: () => remove(item) }) : null);
      } },
    ], shown, query ? '没有匹配的成员。' : '还没有成员。'));
  };
  search.addEventListener('input', draw);
  draw();
  return page('成员', `共 ${list.length} 人，上限 ${features.maxMembers} 人。管理员和所有者只能由所有者管理。`,
    manage ? button('添加成员', { variant: 'primary', onClick: add }) : null, search, holder);
}

// ---- 用户组 --------------------------------------------------------------------------------------------------------
async function groups(ctx: Ctx): Promise<Child> {
  const { api, me } = ctx;
  if (!me.features.groups) return page('用户组', '把成员分组，用来限定角色库条目的可见范围和批量授予自定义角色。', null, planNote(ctx));
  const assign = ctx.can('roles.manage'), manage = ctx.can('groups.manage');
  const [list, roleList, memberList] = await Promise.all([
    api.get<OrgGroup[]>('/v1/groups'),
    me.features.customRoles ? api.get<OrgCustomRole[]>('/v1/roles') : Promise.resolve([] as OrgCustomRole[]),
    api.get<OrgMember[]>('/v1/members'),
  ]);
  const roleName = new Map(roleList.map(item => [item.id, item.name]));
  const editor = (existing: OrgGroup | null) => {
    const name = textInput({ value: existing?.name ?? '', required: true, maxLength: 80 });
    const custom = checkList(roleList.map(item => ({ value: item.id, label: item.name })), existing?.customRoleIds ?? [], !assign);
    modal({
      title: existing ? `编辑 ${existing.name}` : '新建用户组', submitLabel: existing ? '保存' : '新建',
      body: [field('名称', name), roleList.length ? field('自定义角色', custom.node, assign ? '组内全体成员获得这些角色的权限。' : '把自定义角色挂到用户组需要所有者操作。') : null],
      submit: async () => {
        const body = { name: name.value, ...(assign ? { customRoleIds: custom.values } : {}) };
        if (existing) await api.patch(`/v1/groups/${existing.id}`, { ...body, revision: existing.revision });
        else await api.post('/v1/groups', body);
        ctx.reload();
      },
    });
  };
  const remove = (target: OrgGroup) => confirmDialog(`删除 ${target.name}`, '成员会离开这个用户组。只对这个组可见的角色库条目会退回草稿，不会变成全员可见。', '删除', async () => {
    await api.remove(`/v1/groups/${target.id}`);
    ctx.reload();
  });
  return page('用户组', '把成员分组，用来限定角色库条目的可见范围和批量授予自定义角色。成员的用户组在“成员”里设置。',
    manage ? button('新建用户组', { variant: 'primary', onClick: () => editor(null) }) : null,
    table<OrgGroup>([
      { title: '名称', cell: item => h('strong', null, item.name) },
      { title: '成员数', width: '90px', cell: item => String(memberList.filter(member => member.groupIds.includes(item.id)).length) },
      { title: '自定义角色', cell: item => chips(item.customRoleIds.map(id => roleName.get(id) ?? id)) },
      { title: '操作', width: '132px', align: 'end', cell: item => (manage ? h('span', { class: 'actions' },
        button('编辑', { variant: 'ghost', onClick: () => editor(item) }), button('删除', { variant: 'danger', onClick: () => remove(item) })) : null) },
    ], list, '还没有用户组。'));
}

// ---- 自定义角色 ----------------------------------------------------------------------------------------------------
async function roles(ctx: Ctx): Promise<Child> {
  const { api, me } = ctx;
  const lead = '在四种内置角色之上叠加权限，可分配给成员或用户组。组织管理和角色分配不能放进自定义角色。';
  if (!me.features.customRoles) return page('自定义角色', lead, null, planNote(ctx));
  const list = await api.get<OrgCustomRole[]>('/v1/roles');
  const editor = (existing: OrgCustomRole | null) => {
    const name = textInput({ value: existing?.name ?? '', required: true, maxLength: 80 });
    const description = textInput({ value: existing?.description ?? '', maxLength: 400 });
    const granted = checkList(GRANTABLE.map(permission => ({ value: permission, ...PERMISSION[permission] })), existing?.permissions ?? []);
    modal({
      title: existing ? `编辑 ${existing.name}` : '新建自定义角色', submitLabel: existing ? '保存' : '新建',
      body: [field('名称', name), field('说明', description), field('权限', granted.node)],
      submit: async () => {
        const body = { name: name.value, description: description.value, permissions: granted.values };
        if (existing) await api.patch(`/v1/roles/${existing.id}`, { ...body, revision: existing.revision });
        else await api.post('/v1/roles', body);
        ctx.reload();
      },
    });
  };
  const remove = (target: OrgCustomRole) => confirmDialog(`删除 ${target.name}`, '持有这个角色的成员和用户组会失去它授予的权限。', '删除', async () => {
    await api.remove(`/v1/roles/${target.id}`);
    ctx.reload();
  });
  return page('自定义角色', lead, button('新建自定义角色', { variant: 'primary', onClick: () => editor(null) }),
    table<OrgCustomRole>([
      { title: '名称', width: '180px', cell: item => h('span', { class: 'cell-main' }, h('strong', null, item.name), item.description ? h('small', null, item.description) : null) },
      { title: '权限', cell: item => chips(item.permissions.map(permission => PERMISSION[permission].label)) },
      { title: '操作', width: '132px', align: 'end', cell: item => h('span', { class: 'actions' },
        button('编辑', { variant: 'ghost', onClick: () => editor(item) }), button('删除', { variant: 'danger', onClick: () => remove(item) })) },
    ], list, '还没有自定义角色。'));
}

// ---- 角色库 --------------------------------------------------------------------------------------------------------
async function library(ctx: Ctx): Promise<Child> {
  const { api, me } = ctx;
  const manage = ctx.can('library.manage');
  const scoped = me.features.scopedLibrary;
  const [list, groupList] = await Promise.all([
    api.get<OrgLibrarySummary[]>('/v1/library'),
    scoped && manage ? api.get<OrgGroup[]>('/v1/groups') : Promise.resolve([] as OrgGroup[]),
  ]);
  const groupName = new Map(groupList.map(item => [item.id, item.name]));
  const audienceText = (audience: OrgLibraryAudience) =>
    audience.kind === 'everyone' ? '全员' : audience.groupIds.map(id => groupName.get(id) ?? '用户组').join('、');

  const editor = async (existing: OrgLibrarySummary | null) => {
    const full = existing ? await api.get<OrgLibraryItem>(`/v1/library/${existing.id}`) : null;
    const kind = segmented<OrgLibraryKind>((['character', 'lorebook', 'preset'] as const).map(value => ({ value, label: KIND[value] })), existing?.kind ?? 'character');
    const name = textInput({ value: existing?.name ?? '', required: true, maxLength: 120 });
    const text = textArea({ value: full ? JSON.stringify(full.document, null, 2) : '', rows: 12, mono: true, placeholder: '粘贴 JSON，或从文件读取' });
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', () => {
      const picked = file.files?.[0];
      if (!picked) return;
      void picked.text().then(content => { text.value = content; if (!name.value) name.value = picked.name.replace(/\.json$/i, ''); });
    });
    const groupPick = checkList(groupList.map(item => ({ value: item.id, label: item.name })), existing?.audience.kind === 'groups' ? existing.audience.groupIds : []);
    const groupField = field('可见的用户组', groupPick.node);
    const audience = segmented<'everyone' | 'groups'>([
      { value: 'everyone', label: '全员可见' }, { value: 'groups', label: '指定用户组', disabled: !scoped || !groupList.length },
    ], existing?.audience.kind ?? 'everyone', value => { groupField.hidden = value !== 'groups'; });
    groupField.hidden = audience.value !== 'groups';
    modal({
      title: existing ? `编辑 ${existing.name}` : '新建角色库条目', wide: true, submitLabel: existing ? '保存' : '新建',
      body: [
        existing ? null : field('类型', kind.node), field('名称', name),
        field('文档', h('div', { class: 'stack' }, text, h('div', null, button('从文件读取', { onClick: () => file.click() }), file)),
          '角色用角色卡 JSON（V2 或 V3），世界书和文风用 Fantay 导出的 JSON。PNG 角色卡请先在 Fantay 里导出为 JSON。'),
        field('可见范围', audience.node, scoped ? undefined : '按用户组限定可见范围是企业版功能。'), groupField,
        existing?.status === 'published' ? note('这个条目已发布，保存后立即对成员生效。') : null,
      ],
      submit: async () => {
        let document: unknown;
        try { document = JSON.parse(text.value); } catch { throw new Error('文档不是有效的 JSON'); }
        if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('文档需要是一个 JSON 对象');
        if (audience.value === 'groups' && !groupPick.values.length) throw new Error('请至少选择一个用户组');
        const body = { name: name.value, document, audience: audience.value === 'groups' ? { kind: 'groups', groupIds: groupPick.values } : { kind: 'everyone' } };
        if (existing) await api.patch(`/v1/library/${existing.id}`, { ...body, revision: existing.revision });
        else await api.post('/v1/library', { ...body, kind: kind.value });
        ctx.reload();
      },
    });
  };
  const setStatus = (item: OrgLibrarySummary, action: 'publish' | 'retire') => {
    const run = async () => { await api.post(`/v1/library/${item.id}/${action}`, { revision: item.revision }); ctx.reload(); };
    if (action === 'publish') void run().catch(failed);
    else confirmDialog(`下架 ${item.name}`, '下架后成员的 Fantay 在下次同步时停用这个条目。成员已有的对话不会被删除。', '下架', run);
  };
  const remove = (item: OrgLibrarySummary) => confirmDialog(`删除 ${item.name}`, '删除后不可恢复。', '删除', async () => {
    await api.remove(`/v1/library/${item.id}`);
    ctx.reload();
  });
  const upload = (item: OrgLibrarySummary) => {
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    file.addEventListener('change', () => {
      const picked = file.files?.[0];
      if (!picked) return;
      const reader = new FileReader();
      reader.onload = () => {
        void api.post(`/v1/library/${item.id}/assets`, { role: 'portrait', mime: picked.type, data: String(reader.result), revision: item.revision })
          .then(() => { toast('头像已更新'); ctx.reload(); }, failed);
      };
      reader.readAsDataURL(picked);
    });
    file.click();
  };
  /** The portrait is fetched with the token (an <img> cannot send one) and shown from a blob URL. */
  const portrait = (item: OrgLibrarySummary): HTMLElement => {
    const asset = item.assets.find(entry => entry.role === 'portrait');
    const frame = h('span', { class: 'thumb', 'aria-hidden': 'true' }, item.name.slice(0, 1));
    if (asset) void api.blob(`/v1/library/${item.id}/assets/${asset.id}`).then(blob => {
      frame.replaceChildren(h('img', { src: URL.createObjectURL(blob), alt: '' }));
    }, () => undefined);
    return frame;
  };

  let filter: OrgLibraryKind | 'all' = 'all';
  const holder = h('div');
  const draw = () => holder.replaceChildren(table<OrgLibrarySummary>([
    { title: '条目', cell: item => h('span', { class: 'cell-lead' }, portrait(item), h('span', { class: 'cell-main' }, h('strong', null, item.name), h('small', null, KIND[item.kind]))) },
    { title: '状态', width: '84px', cell: item => badge(STATUS[item.status][0], STATUS[item.status][1]) },
    { title: '可见范围', width: '150px', cell: item => audienceText(item.audience) },
    { title: '更新时间', width: '136px', cell: item => formatTime(item.updatedAt) },
    ...(manage ? [{ title: '操作', width: '248px', align: 'end' as const, cell: (item: OrgLibrarySummary) => h('span', { class: 'actions' },
      button('编辑', { variant: 'ghost', onClick: () => { void editor(item).catch(failed); } }),
      item.kind === 'character' ? button('头像', { variant: 'ghost', onClick: () => upload(item) }) : null,
      item.status === 'published'
        ? button('下架', { variant: 'ghost', onClick: () => setStatus(item, 'retire') })
        : button('发布', { variant: 'ghost', onClick: () => setStatus(item, 'publish') }),
      button('删除', { variant: 'danger', onClick: () => remove(item) })) }] : []),
  ], list.filter(item => filter === 'all' || item.kind === filter), manage ? '还没有条目。新建一个，发布后成员就能看到。' : '还没有对你可见的条目。'));
  const kinds = segmented<OrgLibraryKind | 'all'>([
    { value: 'all', label: `全部 ${list.length}` },
    ...(['character', 'lorebook', 'preset'] as const).map(value => ({ value, label: `${KIND[value]} ${list.filter(item => item.kind === value).length}` })),
  ], 'all', value => { filter = value; draw(); });
  draw();
  return page('角色库', manage ? '组织共享的角色、世界书和文风。发布后，成员的 Fantay 在同步时取得。' : '组织共享的角色、世界书和文风，由管理员统一管理。',
    manage ? button('新建条目', { variant: 'primary', onClick: () => { void editor(null).catch(failed); } }) : null, kinds.node, holder);
}

// ---- 策略 ----------------------------------------------------------------------------------------------------------
async function policy(ctx: Ctx): Promise<Child> {
  const { api } = ctx;
  const org = await api.get<OrgInfo>('/v1/org');
  const editable = ctx.can('org.manage');
  const enabled = toggle('陪伴对话', '成员可以与角色库里的角色对话。关闭后只保留工作任务。', org.policy.companion.enabled, !editable);
  const memory = toggle('角色记忆', '角色为每位成员各自记住对话里的事。关闭后不再读取和写入。', org.policy.companion.memory, !editable);
  const personas = toggle('成员人设', '成员可以写自己的人设，对话时角色据此称呼和了解对方。', org.policy.companion.personas, !editable);
  const save = button('保存', { variant: 'primary', onClick: () => {
    save.disabled = true;
    api.patch('/v1/org', { revision: org.revision, policy: { ...org.policy, companion: { enabled: enabled.checked, memory: memory.checked, personas: personas.checked } } })
      .then(() => { toast('策略已保存'); ctx.reload(); }, error => { failed(error); save.disabled = false; });
  } });
  return page('策略', '对全体成员生效的开关。跟随这台服务器的 Fantay 在下次同步目录时应用。', editable ? save : null,
    group('陪伴', enabled.node, memory.node, personas.node),
    editable ? null : note('只有所有者可以修改策略。'));
}

// ---- 身份接入 ------------------------------------------------------------------------------------------------------
async function identity(ctx: Ctx): Promise<Child> {
  const { api, me } = ctx;
  const [sso, scim] = await Promise.all([
    api.get<OrgSsoConfig>('/v1/sso'),
    me.features.scim ? api.get<OrgScimStatus>('/v1/scim') : Promise.resolve(null),
  ]);
  const enabled = toggle('启用单点登录', '成员可以用组织的身份提供方登录这个管理界面。', sso.enabled);
  const issuer = textInput({ value: sso.issuer, placeholder: 'https://login.example.com', maxLength: 300 });
  const clientId = textInput({ value: sso.clientId, maxLength: 200 });
  const secret = textInput({ type: 'password', placeholder: sso.hasClientSecret ? '已保存，留空则不修改' : '', maxLength: 500 });
  const domains = textInput({ value: sso.allowedDomains.join(', '), placeholder: 'example.com' });
  const provision = toggle('首次登录自动加入', '不在成员名单里的人第一次登录时自动成为成员。关闭时只有已添加的成员能登录。', sso.autoProvision);
  const role = segmented<'member' | 'viewer'>([{ value: 'member', label: '成员' }, { value: 'viewer', label: '访客' }], sso.defaultRole);
  const save = button('保存单点登录', { variant: 'primary', onClick: () => {
    save.disabled = true;
    api.put('/v1/sso', {
      enabled: enabled.checked, issuer: issuer.value.trim(), clientId: clientId.value.trim(), allowedDomains: lines(domains.value),
      autoProvision: provision.checked, defaultRole: role.value, ...(secret.value ? { clientSecret: secret.value } : {}),
    }).then(() => { toast('单点登录设置已保存'); ctx.reload(); }, error => { failed(error); save.disabled = false; });
  } });
  const generate = () => confirmDialog(scim?.enabled ? '重新生成 SCIM 令牌' : '生成 SCIM 令牌', scim?.enabled ? '新令牌生成后，身份提供方里配置的旧令牌立即失效。' : '令牌交给身份提供方，用来添加、修改、停用和移除成员与用户组。它不能分配角色，也不能改动主要所有者。', '生成', async () => {
    const issued = await api.post<OrgIssuedToken>('/v1/scim/token');
    ctx.reload();
    reveal('SCIM 令牌', issued.token, '令牌只显示这一次，请现在复制到身份提供方的配置里。');
  }, false);
  const disable = () => confirmDialog('停用 SCIM', '停用后身份提供方无法再同步成员和用户组。已有的成员不受影响。', '停用', async () => {
    await api.remove('/v1/scim/token');
    ctx.reload();
  });
  return page('身份接入', '用组织的身份提供方登录和同步成员。身份提供方只说明“是谁”，角色始终在这里分配。', null,
    group('单点登录（OpenID Connect）',
      row('回调地址', sso.redirectUri ? h('code', null, sso.redirectUri) : h('span', { class: 'muted' }, '服务器未设置 ORG_PUBLIC_URL，暂时无法使用单点登录')),
      enabled.node,
      h('div', { class: 'row form-row' }, field('身份提供方地址（Issuer）', issuer), field('客户端 ID', clientId)),
      h('div', { class: 'row form-row' }, field('客户端密钥', secret), field('允许的邮箱域名', domains, '多个域名用逗号分隔；留空则接受身份提供方验证过的任何邮箱。')),
      provision.node,
      h('div', { class: 'row form-row' }, field('自动加入时的角色', role.node)),
      h('div', { class: 'row row-end' }, save)),
    group('成员同步（SCIM 2.0）',
      !me.features.scim ? h('div', { class: 'row' }, planNote(ctx)) : [
        row('基础地址', scim?.baseUrl ? h('code', null, scim.baseUrl) : h('span', { class: 'muted' }, '服务器未设置 ORG_PUBLIC_URL')),
        row('状态', scim?.enabled ? [badge('已启用', 'good'), ` 上次使用 ${formatTime(scim.lastUsedAt)}`] : badge('未启用'),
          [button(scim?.enabled ? '重新生成令牌' : '生成令牌', { onClick: generate }), scim?.enabled ? button('停用', { variant: 'danger', onClick: disable }) : null]),
      ]));
}

// ---- 服务凭据 ------------------------------------------------------------------------------------------------------
async function tokens(ctx: Ctx): Promise<Child> {
  const { api } = ctx;
  const list = await api.get<OrgServiceToken[]>('/v1/service-tokens');
  const create = () => {
    const label = textInput({ required: true, maxLength: 80, placeholder: '例如：总部 Fantay 控制器' });
    const scopes = checkList((Object.keys(SCOPE) as OrgServiceScope[]).map(value => ({ value, ...SCOPE[value] })), ['directory.sync', 'library.sync']);
    const ttl = select(TTL, '90');
    modal({
      title: '新建服务凭据', submitLabel: '新建',
      body: [field('名称', label), field('范围', scopes.node), field('有效期', ttl)],
      submit: async () => {
        if (!scopes.values.length) throw new Error('请至少选择一个范围');
        const created = await api.post<{ record: OrgServiceToken; token: OrgIssuedToken }>('/v1/service-tokens', { label: label.value, scopes: scopes.values, ttlDays: ttlOf(ttl) });
        ctx.reload();
        showToken(`${created.record.label} 的服务凭据`, created.token, '凭据');
      },
    });
  };
  const remove = (target: OrgServiceToken) => confirmDialog(`删除 ${target.label}`, '删除后，使用这个凭据的 Fantay 守护进程无法再同步，并沿用最后一次取得的目录。', '删除', async () => {
    await api.remove(`/v1/service-tokens/${target.id}`);
    ctx.reload();
  });
  return page('服务凭据', '给 Fantay 守护进程用的同步凭据。它只能拉取目录和角色库，不代表任何成员，也不能登录这里。',
    button('新建服务凭据', { variant: 'primary', onClick: create }),
    table<OrgServiceToken>([
      { title: '名称', cell: item => h('strong', null, item.label) },
      { title: '范围', cell: item => chips(item.scopes.map(scope => SCOPE[scope].label)) },
      { title: '到期', width: '104px', cell: item => formatDate(item.expiresAt) },
      { title: '上次使用', width: '136px', cell: item => formatTime(item.lastUsedAt) },
      { title: '操作', width: '80px', align: 'end', cell: item => button('删除', { variant: 'danger', onClick: () => remove(item) }) },
    ], list, '还没有服务凭据。'));
}

// ---- 审计日志 ------------------------------------------------------------------------------------------------------
const DETAIL: Record<string, string> = {
  name: '名称', label: '名称', kind: '类型', role: '角色', from: '原值', to: '新值', fields: '改动', plan: '套餐', permissions: '权限', scopes: '范围',
  enabled: '启用', issuer: '身份提供方', bytes: '字节', active: '在职', audience: '可见范围', customRoleIds: '自定义角色', document: '文档有改动',
  policy: '策略有改动', autoProvision: '自动加入', secretChanged: '密钥有改动',
};
const WORD: Record<string, string> = { ...ROLE, ...PLAN, ...KIND, everyone: '全员', groups: '指定用户组', status: '状态', email: '邮箱', groupIds: '用户组', externalId: '外部编号' };
/** One line a person can read from an audit entry's detail. `named`: the object's name is already shown above. */
function summarize(detail: Record<string, unknown>, named: boolean, names: ReadonlyMap<string, string>): string {
  const say = (value: unknown): string => {
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (Array.isArray(value)) return value.map(say).join('、') || '无';
    if (value && typeof value === 'object') return say((value as { kind?: unknown }).kind ?? JSON.stringify(value));
    const text = String(value);
    return names.get(text) ?? WORD[text] ?? (text in PERMISSION ? PERMISSION[text as OrgPermission].label : text in SCOPE ? SCOPE[text as OrgServiceScope].label : text);
  };
  return Object.entries(detail)
    .filter(([key]) => !(named && (key === 'name' || key === 'label')))
    .map(([key, value]) => `${DETAIL[key] ?? key}：${say(value)}`).join(' · ');
}
async function audit(ctx: Ctx): Promise<Child> {
  const { api, me } = ctx;
  const lead = '每一次管理操作都有记录：时间、操作者、动作和对象。记录里没有任何对话内容。';
  if (!me.features.auditLog) return page('审计日志', lead, null, planNote(ctx));
  const names = new Map<string, string>([['scim', 'SCIM']]);
  // Names for the ids an entry mentions: members, custom roles and groups this member may list.
  const [memberList, roleList, groupList] = await Promise.all([
    ctx.can('members.manage') ? api.get<OrgMember[]>('/v1/members') : Promise.resolve([]),
    ctx.can('roles.manage') || ctx.can('members.manage') ? api.get<OrgCustomRole[]>('/v1/roles') : Promise.resolve([]),
    ctx.can('groups.manage') || ctx.can('members.manage') ? api.get<OrgGroup[]>('/v1/groups') : Promise.resolve([]),
  ]);
  for (const item of [...memberList, ...roleList, ...groupList]) names.set(item.id, item.name);
  let items: OrgAuditEvent[] = [];
  let next: number | null = null;
  const holder = h('div');
  const more = button('加载更多', { onClick: () => { void load().catch(failed); } });
  const draw = () => holder.replaceChildren(
    table<OrgAuditEvent>([
      { title: '时间', width: '136px', cell: item => formatTime(item.at) },
      { title: '操作者', width: '140px', cell: item => names.get(item.actorId) ?? h('code', null, item.actorId.slice(0, 8)) },
      { title: '动作', width: '150px', cell: item => AUDIT[item.action] ?? item.action },
      { title: '对象与摘要', cell: item => {
        const named = item.targetId ? names.get(item.targetId) ?? (typeof item.detail.name === 'string' ? item.detail.name : typeof item.detail.label === 'string' ? item.detail.label : null) : null;
        const summary = summarize(item.detail, named !== null, names);
        return h('span', { class: 'cell-main' },
          item.targetId ? h('span', null, named ?? h('code', null, item.targetId.slice(0, 8))) : null,
          summary ? h('small', null, summary) : null);
      } },
    ], items, '还没有记录。'),
    ...(next ? [h('div', { class: 'more' }, more)] : []));
  const load = async () => {
    const result = await api.get<{ items: OrgAuditEvent[]; nextBefore: number | null }>(`/v1/audit?limit=100${next ? `&before=${next}` : ''}`);
    items = [...items, ...result.items];
    next = result.nextBefore;
    draw();
  };
  await load();
  const verify = button('校验完整性', { onClick: () => {
    void api.get<{ valid: boolean; entries: number }>('/v1/audit/verify').then(result => {
      toast(result.valid ? `校验通过：${result.entries} 条记录的哈希链完整。` : `校验失败：第 ${result.entries + 1} 条记录起被改动过。`, result.valid ? 'good' : 'bad');
    }, failed);
  } });
  return page('审计日志', lead, verify, holder);
}

// ---- start ---------------------------------------------------------------------------------------------------------
async function start(): Promise<void> {
  applyTheme();
  const hash = new URLSearchParams(location.hash.slice(1));
  const session = hash.get('session'), ssoError = hash.get('sso_error');
  // A session arrives in the fragment after single sign-on: take it out of the address bar before anything else.
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (session) storeToken(session);
  const token = storedToken();
  if (token) {
    try { await enter(token); return; } catch { storeToken(''); }
  }
  await showLogin(ssoError ? SSO_ERROR[ssoError] ?? '单点登录失败，请重试。' : null);
}
void start();
