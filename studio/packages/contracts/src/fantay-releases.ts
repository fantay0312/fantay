/** One authored record feeds the app, manga, repository Markdown and website JSON. Newest last. */
export interface FantayRelease {
  version: string;
  date: string;
  status: 'prepared' | 'published';
  title: string;
  summary: Record<'zh-CN' | 'zh-TW' | 'en', string[]>;
  sections: Array<{ title: string; items: string[] }>;
  validation: string[];
  limitations: string[];
  manga: {
    cover: 'blue' | 'coral' | 'paper' | 'ink' | 'green';
    sfx: [string, string, string];
    copy: Record<'zh-CN' | 'zh-TW' | 'en', { title: string; tagline: string; chapters: Array<{ head: string; text: string }> }>;
  };
}

export const FANTAY_RELEASES: readonly FantayRelease[] = [{
  version: '26.1114.1', date: '2026-11-14', status: 'prepared', title: '用量看全，更新有据',
  summary: {
    'zh-CN': ['版本规则：采用年、月日、当日序号，例如 26.1114.1。', 'AI 用量：切换「仅 Fantay / 本机全部」，读取受支持的本地 Agent 日志。', '费用明细：实际扣费、渠道报告与本地 Token 估算价值分别显示。', '更新记录：版本摘要、漫画、仓库详细日志与网站数据共用同一份内容。'],
    'zh-TW': ['版本規則：採用年、月日、當日序號，例如 26.1114.1。', 'AI 用量：切換「僅 Fantay / 本機全部」，讀取支援的本機 Agent 紀錄。', '費用明細：實際扣費、通路回報與本機 Token 估算價值分開顯示。', '更新紀錄：版本摘要、漫畫、儲存庫詳細日誌與網站資料共用同一份內容。'],
    en: ['Calendar versions use year, month/day and daily sequence, starting with 26.1114.1.', 'Switch AI usage between Fantay only and supported agents on this device.', 'Keep actual charges, reported costs and estimated local token value separate.', 'Release summaries, manga, repository notes and website data share one authored record.'],
  },
  sections: [
    { title: '工具用途图标', items: ['TokenToSea 工具列表与详情替换首字母占位，使用统一的 Lucide 用途图标。', '覆盖公开目录 294 个工具，连同精选与内置工具共 309 条固定映射；车辆、天气、酒店、语音、音乐、代码仓库等按实际用途区分。', '具体用途优先于历史分类；综合工具保留中性图标，未知工具按用途或类别降级。继续隐藏上游供应商品牌，不加载远端 Logo。', '图标与 TokenToSea 工具市场共用相同静态图形和映射；适配深浅色，不变更工具调用、账户或计费。'] },
    { title: '版本与发布流程', items: ['采用 YY.MMDD.N 版本：2026 年 11 月 14 日第一个版本为 26.1114.1；当天后续版本为 .2、.3。', '以 Asia/Taipei 日期计算每日序号；次日从 1 开始。日期固定四位，1 月 1 日为 26.0101.1。', '新增 next-version 与 sync-version 命令。只在正式准备一个更新版本时增加序号；同一版本的构建重试、不同平台安装包和普通代码提交不重复占号。', '同步应用与配套包版本，校验更新摘要、漫画和详细日志；保留旧版更新与回滚协议兼容性。'] },
    { title: 'AI 用量与本机 Agent', items: ['AI 用量新增「仅 Fantay / 本机全部」；日期、来源筛选、趋势、热力图、明细、CSV 和小票沿用当前范围。', '扩展 29 类本机来源：Claude、Codex、Gemini、OpenCode、Grok、Pi、Oh My Pi、MCode、DeepSeek Harness、Kimi Code、Copilot、WorkBuddy、CodeBuddy、WorkBuddy AI、Antigravity CLI/IDE/Insiders、Devin、ZCode、Qoder/Qoder CN、Cindy/CindyGlobal、Raft、Cline、Droid、Hermes、Alma，以及仅识别的 Cursor；保留工作区独立接入的 Muse。', '增加多账号目录、CC Switch 自定义路径、Magpie 账号目录、OMP/Hermes profiles 发现；兼容 JSONL、Zstd、SQLite V1/V2、Antigravity 明文统计 protobuf。', '合并流式快照及重复日志；按真实字段处理缓存、推理 Token 和多模型用量。Droid/Hermes 等累计数据标为会话汇总，不伪造逐请求时间与未知调用次数。', '通过 Fantay 保存的会话身份排除重复原生日志。扫描详情说明文件上限、未写完记录、归属不明或格式不支持等原因；Cursor 本地无 Token 统计时明确显示仅识别。', '新增 od usage --scope fantay|device，与桌面页面读取同一个 API；CSV 包含统计粒度。'] },
    { title: '费用与隐私', items: ['独立显示 TokenToSea 实际扣费、其他渠道报告费用和本地 Token 估算价值。估算不写入扣费字段，不触发支付。', '使用 models.dev 公共价格表缓存，按精确模型名、输入、输出、缓存读取和写入估算。无法匹配、缺少缓存单价、1 小时缓存写入或阶梯价格不猜测。', '未知费用仍为未提供，不当成免费。离线或价格表不可用时仍能读取本地 Token。', '仅保留用量元数据，不保存提示词、回答、工具输出或凭据；请求公共价格表不发送本地日志。'] },
    { title: '更新日志与漫画', items: ['本版本增加对应漫画卷及版本标识；漫画讲重点，详细说明独立保存。', '每个版本生成仓库 Markdown，另生成 releases.json 供未来网站使用；重复同步不会新建版本。', 'macOS arm64 安装包已在本机安装并通过启动检查。'] },
  ],
  validation: ['针对性测试通过：四位日期、每日递增、旧版兼容、更新文件一致性、用量解析、范围切换和小票。', '通过新增 Agent 格式测试，覆盖 Grok、Pi、OMP、DSH、Kimi、Copilot、WorkBuddy、Gemini JSONL、OpenCode V2、MCode、Antigravity protobuf、Alma 隐私过滤及 Hermes 聚合。', '通过 Codex 分段写入不重复计数、OpenCode WAL 读取、多账号目录发现和 Cursor 仅识别状态测试。', '实际只读扫描本机日志并查询独立测试实例，读取到 Codex、Claude、Grok、DeepSeek Harness、Antigravity 等真实记录；其他未安装来源通过合成格式验证。', '工具用途映射、列表与详情一致性、未知工具降级及深浅色界面检查通过。', '图标修复后，项目 guard 和完整类型检查通过。', 'macOS 打包修复通过 24 项针对性测试。DMG 校验和应用签名验证通过，内置搜索引擎可启动，桌面可读取搜索目录并显示两个用量范围。', '从 0.25.1 覆盖安装后，新版桌面和后台均成功启动，原有登录、项目文件、对话消息和 Personal Agent 记录保留。'],
  limitations: ['本机全部指受支持且可读取的本地历史，不代表所有软件或账号的完整服务账单。', 'Fantay 已登记的原生会话以 Fantay 记录为准；同一会话后来在外部续写的部分尚不能单独归属。', '无法证明父历史边界的 Codex 分叉、缺少累计基线的续写、未支持的日志格式及超出扫描上限的文件标记为部分记录。', '估算采用抓取时的公开单价，不是调用当时的发票价格；订阅抵扣、促销、不同服务层和税费不包含在内。', '尚未进行 Windows 安装及公开更新源的端到端验证。'],
  manga: {
    cover: 'ink', sfx: ['咔', '叮', '唰'],
    copy: {
      'zh-CN': { title: '用量看全', tagline: '每次更新，都有记录', chapters: [
        { head: '看图识用途', text: '车辆、天气、语音与音乐各有图标；列表与详情保持一致。' },
        { head: '今天的第一版', text: '26.1114.1：年份、月日，再加当天第几个版本。' },
        { head: '换个范围看看', text: '只看 Fantay，或汇总受支持的本机 Agent。' },
        { head: '费用各归各', text: '实际扣费、渠道报告、Token 估算，分开看清楚。' },
        { head: '一本更新档案', text: '漫画讲重点，详细日志留在仓库，也为网站备好。' },
      ] },
      'zh-TW': { title: '用量看全', tagline: '每次更新，都有紀錄', chapters: [
        { head: '看圖識用途', text: '車輛、天氣、語音與音樂各有圖示；清單與詳情保持一致。' },
        { head: '今天的第一版', text: '26.1114.1：年份、月日，再加當天第幾個版本。' },
        { head: '換個範圍看看', text: '只看 Fantay，或彙總支援的本機 Agent。' },
        { head: '費用各歸各', text: '實際扣費、通路回報、Token 估算，分開看清楚。' },
        { head: '一本更新檔案', text: '漫畫講重點，詳細日誌留在儲存庫，也為網站備好。' },
      ] },
      en: { title: 'Usage in view', tagline: 'Every update has a record', chapters: [
        { head: 'Recognize each tool', text: 'Distinct icons for vehicles, weather, speech and music, shared by lists and details.' },
        { head: 'First of the day', text: '26.1114.1: year, month and day, then the daily release number.' },
        { head: 'Choose the scope', text: 'See Fantay alone, or supported agents on this device.' },
        { head: 'Costs stay clear', text: 'Charges, reported costs and token estimates stay separate.' },
        { head: 'Keep the story', text: 'A manga for highlights, detailed notes for the repo and future site.' },
      ] },
    },
  },
}];

export const FANTAY_LATEST_RELEASE = FANTAY_RELEASES[FANTAY_RELEASES.length - 1]!;
