type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Workspace = { workspaceId: string; workspaceName: string; workspaceType: string; role: string };
type Member = { memberId: string; displayName: string; role: string };
const node = (tag: string, text?: string) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };

export async function showTokenToSeaWorkspaces(root: HTMLElement, api: Api, report: (message: string) => void): Promise<void> {
  const command = <T>(operation: string, input: Record<string, unknown> = {}) => api<T>('/api/collaboration', 'POST', { operation, ...input });
  const section = node('section'); section.className = 'workspace-section'; root.prepend(section);
  const button = (label: string, run: () => Promise<void>) => {
    const element = node('button', label) as HTMLButtonElement;
    element.onclick = () => { element.disabled = true; void run().catch(error => report(error.message)).finally(() => { element.disabled = false; }); };
    return element;
  };
  const field = (label: string, placeholder: string) => {
    const wrapper = node('label', label), input = node('input') as HTMLInputElement;
    input.placeholder = placeholder; input.maxLength = 160; wrapper.append(input); return { wrapper, input };
  };
  async function render(selected?: string) {
    const { workspaces } = await command<{ workspaces: Workspace[] }>('workspace.list');
    section.replaceChildren(node('h2', 'TokenToSea 工作区'));
    const create = node('div'); create.className = 'actions';
    const name = field('新工作区名称', '例如：我的设计团队');
    create.append(name.wrapper, button('创建工作区', async () => {
      const workspace = await command<Workspace>('workspace.create', { name: name.input.value }); await render(workspace.workspaceId);
    })); section.append(create);
    const join = node('div'); join.className = 'actions'; const code = field('加入工作区', '粘贴邀请链接或邀请码');
    join.append(code.wrapper, button('加入', async () => {
      let token = code.input.value.trim(); try { token = new URL(token).searchParams.get('invite') ?? token; } catch {}
      const joined = await command<{ workspaceId: string }>('invitation.accept', { token }); await render(joined.workspaceId);
    })); section.append(join);
    for (const workspace of workspaces) {
      const card = node('article'); card.className = 'share-card';
      card.append(node('h3', workspace.workspaceName), node('p', workspace.workspaceType === 'team' ? '团队工作区' : '个人工作区'));
      card.append(button('查看成员与项目', async () => { await render(workspace.workspaceId); }));
      if (workspace.workspaceId === selected) {
        const [{ members }, { projects }] = await Promise.all([
          command<{ members: Member[] }>('member.list', { workspaceId: selected }),
          command<{ projects: Array<{ displayName: string; ownerMemberId: string; visibility: string }> }>('project.list', { workspaceId: selected }),
        ]);
        const list = node('ul');
        for (const member of members) {
          const item = node('li', `${member.displayName} · ${member.role === 'owner' ? '拥有者' : member.role === 'admin' ? '管理员' : '成员'}`);
          if (workspace.role === 'owner' && member.role !== 'owner') {
            item.append(button(member.role === 'admin' ? '设为成员' : '设为管理员', async () => {
              await command('member.role', { workspaceId: selected, memberId: member.memberId, role: member.role === 'admin' ? 'member' : 'admin' }); await render(selected);
            }));
            item.append(button('移除成员', async () => {
              if (!window.confirm(`移除 ${member.displayName} 的工作区访问权限？`)) return;
              await command('member.remove', { workspaceId: selected, memberId: member.memberId }); await render(selected);
            }));
          }
          list.append(item);
        }
        card.append(list, node('p', `可访问项目：${projects.length}`));
        for (const project of projects) card.append(node('p', project.displayName));
        if (workspace.workspaceType === 'team' && workspace.role !== 'member') card.append(button('生成成员邀请链接', async () => {
          const invite = await command<{ url: string }>('invitation.create', { workspaceId: selected });
          const input = node('input') as HTMLInputElement; input.readOnly = true; input.value = invite.url; input.setAttribute('aria-label', '成员邀请链接'); card.append(input); input.select();
        }));
      }
      section.append(card);
    }
  }
  const params = new URLSearchParams(location.search), invitation = params.get('invite');
  if (invitation) {
    const prompt = node('p', '你收到了一个工作区邀请。');
    section.append(prompt, button('接受邀请', async () => { const result = await command<{ workspaceId: string }>('invitation.accept', { token: invitation }); history.replaceState(null, '', '/'); await render(result.workspaceId); }));
  } else await render(params.get('workspace') ?? params.get('workspaceId') ?? undefined);
}
