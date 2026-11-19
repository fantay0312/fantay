// SPDX-License-Identifier: AGPL-3.0-only
// Fantay workspace copy, unit-owned (spec §18). Keys live under `pa.`; zh-CN/zh-TW read paShellZh, other locales paShellEn.
// The first block rewrites values that pa-m3.ts defines (this file is spread after paM3En, so these win).
export const paShellEn = {
  'pa.backgroundHelp':
    "Keep working on tasks after the last window closes. The menu-bar icon can reopen the window, pause Fantay, or quit. Sleep and shutdown still pause work.",
  'pa.pauseAll': 'Pause Fantay',
  'pa.resumeAll': 'Resume Fantay',
  'pa.paused': 'Fantay is paused',
  'pa.noChannels': 'Connect Feishu or WeChat to reach Fantay from your phone.',
  'pa.feishuSharing':
    'Other listeners using the same app can receive some of its events. Use a dedicated Fantay bot or stop competing listeners.',

  // Roster (spec §3.3)
  'pa.roster.label': 'Chats and members',
  'pa.roster.search': 'Search chats and members',
  'pa.roster.newChatWith': 'New chat with {name}',
  'pa.roster.newChat': 'New chat',
  'pa.roster.channels': 'Channel chats',
  'pa.roster.noMatch': 'No matching chats',
  'pa.roster.rowMenu': 'More actions',
  'pa.roster.open': 'Open chat',
  'pa.roster.editProfile': 'Edit profile',
  'pa.roster.duplicate': 'Duplicate',
  'pa.roster.editGroup': 'Edit group chat',
  'pa.roster.channelSettings': 'Channel settings',
  'pa.roster.openList': 'Chats',
  'pa.roster.feishu': 'Feishu',
  'pa.roster.weixin': 'WeChat',
  'pa.roster.duplicated': 'Duplicated as "{name}"',
  'pa.roster.disableTitle': 'Disable {name}?',
  'pa.roster.disableBody': 'Its unfinished tasks move to Needs you. You can enable it again at any time.',

  // Row previews
  'pa.preview.working': '{name} is working…',
  'pa.preview.workingSelf': 'Working…',
  'pa.preview.queued': 'Queued',
  'pa.preview.needsYou': 'Needs you',
  'pa.preview.failed': 'Failed · {error}',
  'pa.preview.you': 'You: {text}',
  'pa.preview.sender': '{name}: {text}',
  'pa.preview.empty': 'No messages yet',
  'pa.preview.newChat': 'New chat · {date}',

  // Status line (spec §8.2; also the roster's Fantay card)
  'pa.status.offline': "Can't reach the local service",
  'pa.status.paused': 'Paused',
  'pa.status.asleep': 'Device asleep',
  'pa.status.needs': '{count} waiting for you',
  'pa.status.working': 'Working on {goal}',
  'pa.status.reviewing': 'Reviewing {goal}',
  'pa.status.queued': '{count} queued',
  'pa.status.idle': 'This device · Idle',
  'pa.status.modelUnavailable': 'Model unavailable',

  // Group modes
  'pa.mode.discussionHelp': 'The moderator answers; members you @ or reply to answer too.',
  'pa.mode.collaborationHelp': 'All members answer in turn.',
  'pa.mode.reviewHelp': 'All members answer in turn; the reviewer then checks independently on a different model.',

  // Global states (spec §17.2)
  'pa.state.offlineTitle': "Can't reach the local Fantay service",
  'pa.state.offlineBody': 'Fantay reconnects on its own once the service is back. You can also retry now.',
  'pa.state.retry': 'Retry',
  'pa.state.stale': 'Connection lost, retrying… Showing data from {time}',
  'pa.state.openInspector': 'Show details',
  'pa.state.closeInspector': 'Hide details',

  // Time and durations
  'pa.time.today': 'Today {time}',
  'pa.time.yesterday': 'Yesterday {time}',
  'pa.dur.seconds': '{s}s',
  'pa.dur.minutes': '{m}m {s}s',
  'pa.dur.hours': '{h}h {m}m',

  // Memory scope names (pa-model.memoryScopeName)
  'pa.scope.private': 'Owner profile & global preferences',
  'pa.scope.agent': 'Character · {name}',
  'pa.scope.group': 'Group chat · {name}',
  'pa.scope.project': 'Project · {name}',
  'pa.scope.deleted': 'Deleted target',
} as const;
export const paShellZh: { [K in keyof typeof paShellEn]: string } = {
  'pa.backgroundHelp':
    '关闭最后一个窗口后继续处理任务。可从菜单栏图标重新打开窗口、暂停 Fantay 或完全退出。设备休眠和关机时，本机工作仍会暂停。',
  'pa.pauseAll': '暂停 Fantay',
  'pa.resumeAll': '恢复 Fantay',
  'pa.paused': 'Fantay 已暂停',
  'pa.noChannels': '连接飞书或微信后，就能在手机上找 Fantay。',
  'pa.feishuSharing': '同一应用的其他接收程序可能分流事件。请使用专用的 Fantay 机器人，或停止竞争的消息监听。',

  'pa.roster.label': '对话与成员',
  'pa.roster.search': '搜索对话或成员',
  'pa.roster.newChatWith': '和 {name} 开始新对话',
  'pa.roster.newChat': '新对话',
  'pa.roster.channels': '渠道会话',
  'pa.roster.noMatch': '没有匹配的对话',
  'pa.roster.rowMenu': '更多操作',
  'pa.roster.open': '打开对话',
  'pa.roster.editProfile': '编辑资料',
  'pa.roster.duplicate': '复制',
  'pa.roster.editGroup': '编辑群聊',
  'pa.roster.channelSettings': '渠道设置',
  'pa.roster.openList': '对话列表',
  'pa.roster.feishu': '飞书',
  'pa.roster.weixin': '微信',
  'pa.roster.duplicated': '已复制为「{name}」',
  'pa.roster.disableTitle': '停用 {name}？',
  'pa.roster.disableBody': '它未完成的任务会转为等你处理。之后可以随时重新启用。',

  'pa.preview.working': '{name} 正在工作…',
  'pa.preview.workingSelf': '正在工作…',
  'pa.preview.queued': '排队中',
  'pa.preview.needsYou': '等你处理',
  'pa.preview.failed': '失败 · {error}',
  'pa.preview.you': '你：{text}',
  'pa.preview.sender': '{name}：{text}',
  'pa.preview.empty': '还没有消息',
  'pa.preview.newChat': '新对话 · {date}',

  'pa.status.offline': '连不上本机服务',
  'pa.status.paused': '已暂停',
  'pa.status.asleep': '设备休眠中',
  'pa.status.needs': '有 {count} 件事等你处理',
  'pa.status.working': '正在处理 · {goal}',
  'pa.status.reviewing': '正在审阅 · {goal}',
  'pa.status.queued': '{count} 项排队中',
  'pa.status.idle': '本机 · 空闲',
  'pa.status.modelUnavailable': '模型不可用',

  'pa.mode.discussionHelp': '主持人回答；被 @ 或被回复的成员也会回答。',
  'pa.mode.collaborationHelp': '所有成员依次回答。',
  'pa.mode.reviewHelp': '所有成员依次回答，最后由审阅者用不同模型独立核对。',

  'pa.state.offlineTitle': '连不上本机 Fantay 服务',
  'pa.state.offlineBody': '服务恢复后会自动重新连接，也可以现在重试。',
  'pa.state.retry': '重试',
  'pa.state.stale': '连接中断，正在重试… 显示的是 {time} 的内容',
  'pa.state.openInspector': '打开详情',
  'pa.state.closeInspector': '关闭详情',

  'pa.time.today': '今天 {time}',
  'pa.time.yesterday': '昨天 {time}',
  'pa.dur.seconds': '{s} 秒',
  'pa.dur.minutes': '{m} 分 {s} 秒',
  'pa.dur.hours': '{h} 小时 {m} 分',

  'pa.scope.private': '个人画像与全局偏好',
  'pa.scope.agent': '角色 · {name}',
  'pa.scope.group': '群聊 · {name}',
  'pa.scope.project': '项目 · {name}',
  'pa.scope.deleted': '已删除的对象',
};
