// SPDX-License-Identifier: AGPL-3.0-only
// Fantay's changelog, bound as a manga series: one release is one volume, one change is one chapter.
// Volumes are in release order; the shelf opens on the last one. Add a release by appending a volume.

export type MangaLocale = 'en' | 'zh-CN' | 'zh-TW';
/** Cover stock. The colours are the mascot's own (blue top, coral underside) plus paper, ink and the brand green. */
export type MangaCover = 'blue' | 'coral' | 'paper' | 'ink' | 'green';

export interface MangaChapter {
  /** Short enough for a speech bubble. */
  head: string;
  /** One sentence for the caption box. */
  text: string;
}

export interface MangaVolumeCopy {
  title: string;
  /** The line shouted in the opening starburst. */
  tagline: string;
  chapters: MangaChapter[];
}

export interface MangaVolume {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  cover: MangaCover;
  /** Decorative sound effects drawn into the panels, never read aloud. */
  sfx: readonly [string, string, string];
  copy: Record<MangaLocale, MangaVolumeCopy>;
}

export const MANGA_VOLUMES: readonly MangaVolume[] = [
  {
    id: 'fantay-20261031-video',
    date: '2026-10-31',
    cover: 'blue',
    sfx: ['咔嚓', '唰', '嘀'],
    copy: {
      'zh-CN': {
        title: '视频工作室',
        tagline: '剪辑台，搬进来了',
        chapters: [
          { head: '简易剪辑', text: '时间线、切分、撤销与重做，在右侧面板里直接完成。' },
          { head: '剪辑器重做', text: 'FantayDesign Video 换上和主程序同一套界面与图标。' },
          { head: '安静的后台', text: '视频引擎在后台运行，不弹窗口，也不占 Dock。' },
          { head: '工作区最大化', text: '一键让工作区占满窗口，专心编辑。' },
        ],
      },
      'zh-TW': {
        title: '影片工作室',
        tagline: '剪輯台，搬進來了',
        chapters: [
          { head: '簡易剪輯', text: '時間軸、切分、復原與重做，在右側面板裡直接完成。' },
          { head: '剪輯器重做', text: 'FantayDesign Video 換上和主程式同一套介面與圖示。' },
          { head: '安靜的背景', text: '影片引擎在背景執行，不彈出視窗，也不佔 Dock。' },
          { head: '工作區最大化', text: '一鍵讓工作區佔滿視窗，專心編輯。' },
        ],
      },
      en: {
        title: 'Video studio',
        tagline: 'The editing desk moves in',
        chapters: [
          { head: 'Quick edit', text: 'Timeline, split, undo and redo, right in the side panel.' },
          { head: 'Editor redesign', text: 'FantayDesign Video now shares the app’s interface and icons.' },
          { head: 'Quiet background', text: 'The video engine runs in the background: no window, no Dock icon.' },
          { head: 'Maximize workspace', text: 'One click lets the workspace fill the window.' },
        ],
      },
    },
  },
  {
    id: 'fantay-20261031-board',
    date: '2026-10-31',
    cover: 'coral',
    sfx: ['啪', '咻', '嗡'],
    copy: {
      'zh-CN': {
        title: '画板',
        tagline: '一页画不下，就多开几页',
        chapters: [
          { head: '多页面画板', text: '一个项目放多页，每页记住自己的视角。' },
          { head: '生成节点', text: '节点就是输出的形状，参数收进一张浮层。' },
          { head: '参考与我的素材', text: '参考图、角色、产品和品牌套件，拖进来就能用。' },
          { head: '页面最大化', text: '让页面占满画布查看，按 Esc 飞回原处。' },
        ],
      },
      'zh-TW': {
        title: '畫板',
        tagline: '一頁畫不下，就多開幾頁',
        chapters: [
          { head: '多頁面畫板', text: '一個專案放多頁，每頁記住自己的視角。' },
          { head: '生成節點', text: '節點就是輸出的形狀，參數收進一張浮層。' },
          { head: '參考與我的素材', text: '參考圖、角色、產品和品牌套件，拖進來就能用。' },
          { head: '頁面最大化', text: '讓頁面佔滿畫布檢視，按 Esc 飛回原處。' },
        ],
      },
      en: {
        title: 'Board',
        tagline: 'Out of room? Add a page',
        chapters: [
          { head: 'Board pages', text: 'Several pages per project, each remembering its own view.' },
          { head: 'Generator nodes', text: 'A node takes the shape of its output; settings live in one floating panel.' },
          { head: 'References & assets', text: 'Reference images, characters, products and brand kits are one drag away.' },
          { head: 'Maximize a page', text: 'Let a page fill the canvas, then press Esc to fly back.' },
        ],
      },
    },
  },
  {
    id: 'fantay-20261031-mascot',
    date: '2026-10-31',
    cover: 'paper',
    sfx: ['噗', '呼——', '啾'],
    copy: {
      'zh-CN': {
        title: '吉祥物登场',
        tagline: '一张纸，飘进来了',
        chapters: [
          { head: '吉祥物', text: '住进主页和对话，工作时会动，完成时跳一下。' },
          { head: '首次引导', text: '三道题，记住你的工作方式和外观偏好。' },
          { head: '新主页', text: '输入框合成一层，下方是 12 个可以直接预览的模板。' },
          { head: '集成并入插件', text: '技能、MCP 和连接器都搬到插件页。' },
        ],
      },
      'zh-TW': {
        title: '吉祥物登場',
        tagline: '一張紙，飄進來了',
        chapters: [
          { head: '吉祥物', text: '住進首頁和對話，工作時會動，完成時跳一下。' },
          { head: '首次引導', text: '三道題，記住你的工作方式和外觀偏好。' },
          { head: '新首頁', text: '輸入框合成一層，下方是 12 個可以直接預覽的範本。' },
          { head: '整合併入外掛', text: '技能、MCP 和連接器都搬到外掛頁。' },
        ],
      },
      en: {
        title: 'Enter the mascot',
        tagline: 'A sheet of paper drifts in',
        chapters: [
          { head: 'The mascot', text: 'It lives on Home and in chat, moves while working and hops when done.' },
          { head: 'Welcome', text: 'Three questions remember how you work and how the app should look.' },
          { head: 'New Home', text: 'A single-layer composer, with 12 templates you can preview below it.' },
          { head: 'Plugins', text: 'Skills, MCP and connectors moved to the Plugins page.' },
        ],
      },
    },
  },
  {
    id: 'fantay-20261031-pages',
    date: '2026-10-31',
    cover: 'ink',
    sfx: ['咚', '嚓', '叮'],
    copy: {
      'zh-CN': {
        title: '统一的页面',
        tagline: '十七个页面，一套规矩',
        chapters: [
          { head: '资源页统一', text: '设计体系、素材库、插件、自动化和社区，用同一套标题、标签和卡片。' },
          { head: '设置重排', text: '11 个设置页统一行高、按钮和开关。' },
          { head: '设计体系工作台', text: '列表和详情左右两栏，各自滚动。' },
          { head: '可搜索的下拉框', text: '设置里的下拉框都可以直接搜索。' },
        ],
      },
      'zh-TW': {
        title: '統一的頁面',
        tagline: '十七個頁面，一套規矩',
        chapters: [
          { head: '資源頁統一', text: '設計體系、素材庫、外掛、自動化和社群，用同一套標題、標籤和卡片。' },
          { head: '設定重排', text: '11 個設定頁統一行高、按鈕和開關。' },
          { head: '設計體系工作台', text: '列表和詳情左右兩欄，各自捲動。' },
          { head: '可搜尋的下拉選單', text: '設定裡的下拉選單都可以直接搜尋。' },
        ],
      },
      en: {
        title: 'One page system',
        tagline: 'Seventeen pages, one rulebook',
        chapters: [
          { head: 'Resource pages', text: 'Design systems, materials, plugins, automations and community share one header, tab and card system.' },
          { head: 'Settings tidy-up', text: 'All 11 settings pages use the same rows, buttons and switches.' },
          { head: 'Design-system workbench', text: 'List and detail sit side by side, each scrolling on its own.' },
          { head: 'Searchable menus', text: 'Every dropdown in Settings can be searched.' },
        ],
      },
    },
  },
  {
    id: 'fantay-20261101-process',
    date: '2026-11-01',
    cover: 'coral',
    sfx: ['嗒嗒', '咕噜', '停！'],
    copy: {
      'zh-CN': {
        title: '看得见的过程',
        tagline: '它在想什么，现在看得见',
        chapters: [
          { head: 'Cursor 对话过程', text: '思考、执行计划和每一次工具调用，逐条显示。' },
          { head: '停止按钮', text: '运行中一直在，随时可以叫停。' },
          { head: '收起右侧面板', text: '让对话铺满整个窗口。' },
          { head: '模型设置', text: 'Claude 推理强度，自选常用模型，下拉框统一样式。' },
        ],
      },
      'zh-TW': {
        title: '看得見的過程',
        tagline: '它在想什麼，現在看得見',
        chapters: [
          { head: 'Cursor 對話過程', text: '思考、執行計畫和每一次工具呼叫，逐條顯示。' },
          { head: '停止按鈕', text: '執行中一直在，隨時可以叫停。' },
          { head: '收起右側面板', text: '讓對話鋪滿整個視窗。' },
          { head: '模型設定', text: 'Claude 推理強度，自選常用模型，下拉選單統一樣式。' },
        ],
      },
      en: {
        title: 'Visible work',
        tagline: 'Now you can watch it think',
        chapters: [
          { head: 'Cursor progress', text: 'Thinking, plans and every tool call appear line by line.' },
          { head: 'Stop button', text: 'Always there while a run is going.' },
          { head: 'Collapse the panel', text: 'Let the chat fill the whole window.' },
          { head: 'Model settings', text: 'Claude reasoning effort, your own model list and one style of menu.' },
        ],
      },
    },
  },
  {
    id: 'fantay-20261102-projects',
    date: '2026-11-02',
    cover: 'blue',
    sfx: ['哗啦', '唰唰', '咔'],
    copy: {
      'zh-CN': {
        title: '项目',
        tagline: '所有项目，排好队了',
        chapters: [
          { head: '一个项目列表', text: '侧边栏只留一列，设计、视频和设计系统用图标区分。' },
          { head: '全部项目页', text: '按今天、近 7 天、近 30 天分组，进行中的排在最前。' },
          { head: '分组、置顶与归档', text: '按自己的方式整理项目。' },
          { head: '会动的空状态', text: '画板、片库和设计系统用一小段演示告诉你从哪开始。' },
        ],
      },
      'zh-TW': {
        title: '專案',
        tagline: '所有專案，排好隊了',
        chapters: [
          { head: '一個專案列表', text: '側邊欄只留一列，設計、影片和設計系統用圖示區分。' },
          { head: '全部專案頁', text: '按今天、近 7 天、近 30 天分組，進行中的排在最前。' },
          { head: '分組、置頂與封存', text: '按自己的方式整理專案。' },
          { head: '會動的空狀態', text: '畫板、片庫和設計系統用一小段示範告訴你從哪開始。' },
        ],
      },
      en: {
        title: 'Projects',
        tagline: 'Every project, in line',
        chapters: [
          { head: 'One project list', text: 'The sidebar keeps a single list; icons tell designs, videos and design systems apart.' },
          { head: 'All projects', text: 'Grouped by today, last 7 days and last 30 days, with running work on top.' },
          { head: 'Groups, pins, archive', text: 'Organise projects your own way.' },
          { head: 'Living empty states', text: 'Board, film library and design systems show a short demo of where to start.' },
        ],
      },
    },
  },
  {
    id: 'fantay-20261102-providers',
    date: '2026-11-02',
    cover: 'green',
    sfx: ['轰', '叮咚', '嚓'],
    copy: {
      'zh-CN': {
        title: '媒体生成',
        tagline: '图、视频、声音，一处生成',
        chapters: [
          { head: '媒体生成', text: '统一配置图片、视频和音频提供商，支持本地 ComfyUI 工作流与自定义代理。' },
          { head: '视频编辑', text: '本地时间线、字幕、色彩管理与审片流程。' },
          { head: '团队协作', text: '通过 TokenToSea 工作区管理项目、成员与分享。' },
          { head: '界面修复', text: '提供商名称等标签里，字母下沿不再被裁切。' },
        ],
      },
      'zh-TW': {
        title: '媒體生成',
        tagline: '圖、影片、聲音，一處生成',
        chapters: [
          { head: '媒體生成', text: '統一設定圖片、影片和音訊提供商，支援本機 ComfyUI 工作流程與自訂代理。' },
          { head: '影片編輯', text: '本機時間軸、字幕、色彩管理與審片流程。' },
          { head: '團隊協作', text: '透過 TokenToSea 工作區管理專案、成員與分享。' },
          { head: '介面修復', text: '提供商名稱等標籤裡，字母下緣不再被裁切。' },
        ],
      },
      en: {
        title: 'Media generation',
        tagline: 'Images, video, sound — one place',
        chapters: [
          { head: 'Media providers', text: 'Configure image, video and audio providers in one place, including local ComfyUI workflows and custom proxies.' },
          { head: 'Video editing', text: 'Edit and review with the local timeline, captions and colour controls.' },
          { head: 'Team workspace', text: 'Publish and manage shared projects with your TokenToSea workspace.' },
          { head: 'Crisp labels', text: 'Provider labels keep complete letter shapes across the desktop interface.' },
        ],
      },
    },
  },
];

export function mangaLocale(locale: string): MangaLocale {
  if (locale === 'zh-TW') return 'zh-TW';
  if (locale.startsWith('zh')) return 'zh-CN';
  return 'en';
}

/** Words the books print around the story. Kept beside the volumes: they read as part of the artwork, in the same three languages. */
export interface MangaChrome {
  /** Print small English echoes (RELEASED, CONTENTS, NEXT) beside the labels; pointless when the labels are English. */
  echo: boolean;
  quote: (text: string) => string;
  dialogLabel: string;
  series: string;
  volume: (n: number) => string;
  released: string;
  chapters: string;
  chapterCount: (n: number) => string;
  seriesRow: string;
  seriesCount: (n: number) => string;
  hint: string;
  readHint: string;
  shelf: string;
  prevPage: string;
  nextPage: string;
  contents: string;
  nextChapter: string;
  toBeContinued: string;
  nextVolume: (n: number, title: string) => string;
  comingSoon: (n: number) => string;
  published: string;
  openVolume: (n: number, title: string, date: string) => string;
  pageOf: (from: number, to: number, total: number) => string;
  /** The end card, shown once the last page is turned instead of closing the book. */
  volumeEnd: (n: number) => string;
  readNext: string;
  latestTitle: string;
  latestBody: string;
  readAgain: string;
  backToShelf: string;
  soundOn: string;
  soundOff: string;
}

const CHROME: Record<MangaLocale, MangaChrome> = {
  'zh-CN': {
    echo: true,
    quote: (text) => `「${text}」`,
    dialogLabel: 'Fantay 更新日志',
    series: 'Fantay 漫画',
    volume: (n) => `第${n}卷`,
    released: '发售日',
    chapters: '话数',
    chapterCount: (n) => `${n} 话`,
    seriesRow: '系列',
    seriesCount: (n) => `全 ${n} 卷`,
    hint: '滚动或方向键翻阅 · 点击封面阅读',
    readHint: '点击页面或方向键翻页 · Esc 回到书架',
    shelf: '书架',
    prevPage: '上一页',
    nextPage: '下一页',
    contents: '目次',
    nextChapter: '下一卷',
    toBeContinued: '未完待续',
    nextVolume: (n, title) => `下卷 · 第${n}卷 · ${title}`,
    comingSoon: (n) => `下卷 · 第${n}卷 · 敬请期待`,
    published: '发行',
    openVolume: (n, title, date) => `阅读第${n}卷：${title}（${date}）`,
    pageOf: (from, to, total) => `${from}–${to} / ${total} 页`,
    volumeEnd: (n) => `第${n}卷 · 完`,
    readNext: '继续阅读',
    latestTitle: '已是最新一卷',
    latestBody: '下一卷还在画，敬请期待。',
    readAgain: '从头再读',
    backToShelf: '回到书架',
    soundOn: '关闭翻页声',
    soundOff: '开启翻页声',
  },
  'zh-TW': {
    echo: true,
    quote: (text) => `「${text}」`,
    dialogLabel: 'Fantay 更新日誌',
    series: 'Fantay 漫畫',
    volume: (n) => `第${n}卷`,
    released: '發售日',
    chapters: '話數',
    chapterCount: (n) => `${n} 話`,
    seriesRow: '系列',
    seriesCount: (n) => `全 ${n} 卷`,
    hint: '捲動或方向鍵翻閱 · 點擊封面閱讀',
    readHint: '點擊頁面或方向鍵翻頁 · Esc 回到書架',
    shelf: '書架',
    prevPage: '上一頁',
    nextPage: '下一頁',
    contents: '目次',
    nextChapter: '下一卷',
    toBeContinued: '未完待續',
    nextVolume: (n, title) => `下卷 · 第${n}卷 · ${title}`,
    comingSoon: (n) => `下卷 · 第${n}卷 · 敬請期待`,
    published: '發行',
    openVolume: (n, title, date) => `閱讀第${n}卷：${title}（${date}）`,
    pageOf: (from, to, total) => `${from}–${to} / ${total} 頁`,
    volumeEnd: (n) => `第${n}卷 · 完`,
    readNext: '繼續閱讀',
    latestTitle: '已是最新一卷',
    latestBody: '下一卷還在畫，敬請期待。',
    readAgain: '從頭再讀',
    backToShelf: '回到書架',
    soundOn: '關閉翻頁聲',
    soundOff: '開啟翻頁聲',
  },
  en: {
    echo: false,
    quote: (text) => `“${text}”`,
    dialogLabel: 'Fantay',
    series: 'Fantay Comics',
    volume: (n) => `Vol. ${String(n).padStart(2, '0')}`,
    released: 'Released',
    chapters: 'Chapters',
    chapterCount: (n) => `${n} chapters`,
    seriesRow: 'Series',
    seriesCount: (n) => `${n} volumes`,
    hint: 'Scroll or use arrow keys · Click a cover to read',
    readHint: 'Click a page or use arrow keys · Esc for the shelf',
    shelf: 'Shelf',
    prevPage: 'Previous page',
    nextPage: 'Next page',
    contents: 'Contents',
    nextChapter: 'Next volume',
    toBeContinued: 'To be continued',
    nextVolume: (n, title) => `Vol. ${String(n).padStart(2, '0')} · ${title}`,
    comingSoon: (n) => `Vol. ${String(n).padStart(2, '0')} · Coming soon`,
    published: 'Published by',
    openVolume: (n, title, date) => `Read volume ${n}: ${title} (${date})`,
    pageOf: (from, to, total) => `Pages ${from}–${to} of ${total}`,
    volumeEnd: (n) => `End of Vol. ${String(n).padStart(2, '0')}`,
    readNext: 'Keep reading',
    latestTitle: 'You’re on the latest volume',
    latestBody: 'The next one is still being drawn.',
    readAgain: 'Read again',
    backToShelf: 'Back to the shelf',
    soundOn: 'Mute page turns',
    soundOff: 'Turn page sounds on',
  },
};

export function mangaChrome(locale: MangaLocale): MangaChrome {
  return CHROME[locale];
}

const CJK_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 7 → 七, 12 → 十二, 2026 → 二〇二六 (years are read digit by digit). */
export function cjkNumber(n: number, digitwise = false): string {
  if (digitwise) return String(n).split('').map((d) => CJK_DIGITS[Number(d)]).join('');
  if (n < 10) return CJK_DIGITS[n] ?? String(n);
  if (n < 20) return `十${n % 10 ? CJK_DIGITS[n % 10] : ''}`;
  if (n < 100) return `${CJK_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CJK_DIGITS[n % 10] : ''}`;
  return String(n);
}
