// @vitest-environment jsdom
import '../fantay/helpers/radix-jsdom';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {I18nProvider} from '../../src/i18n';
import {AgentIcon} from '../../src/components/AgentIcon';
import {UsageDashboard,balancedBreaks} from '../../src/components/usage/UsageDashboard';
import {placeReadout} from '../../src/components/usage/UsageTrendChart';
import type {AiUsageSummary} from '@open-design/contracts';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

const day=new Date().toISOString().slice(0,10);
const totals={requests:2,inputTokens:100,outputTokens:20,cachedTokens:10,chargedUsd:'0.000000',refundedUsd:'0.000000',reportedUsd:'0.250000',reservedUsd:'0.000000',pending:0,unknown:1,failed:1,withTokens:2};
const metric={requests:2,tokens:120,costUsd:'0.250000'};
const value:AiUsageSummary={
  days:30,from:day,to:day,bucket:'hour',timeZone:'Asia/Taipei',provider:null,account:'local',coverageSince:Date.now(),totals,
  daily:[{day,totals}],models:[{model:'Local model',provider:'claude',totals}],projects:[{projectId:'film',totals}],
  providers:[{provider:'claude',totals}],availableProviders:[{provider:'claude',requests:2}],
  series:[{start:`${day}T10`,...metric,failed:1,unknown:1,chargedUsd:'0.000000',reportedUsd:'0.250000',groups:{model:{'Local model':metric},provider:{claude:metric},project:{film:metric}}}],
  hours:Array.from({length:24},(_,hour)=>hour===10?metric:{requests:0,tokens:0,costUsd:'0.000000'}),
  recent:[
    {requestKey:'unknown',provider:'claude',model:'Local model',kind:'cli',status:'completed',inputTokens:100,outputTokens:20,cachedTokens:10,chargedUsd:null,refundedUsd:null,reportedUsd:null,reservedUsd:null,createdAt:Date.now(),updatedAt:Date.now()},
    {requestKey:'failed',provider:'claude',model:'Local model',kind:'cli',status:'failed',inputTokens:null,outputTokens:null,cachedTokens:null,chargedUsd:null,refundedUsd:null,reportedUsd:'0.250000',reservedUsd:null,createdAt:Date.now(),updatedAt:Date.now()},
  ],
  activity:{from:day,to:day,days:[{day,...metric,unknown:1}]},
};

it('switches scope through the shared API and labels local estimates separately',async()=>{
  const fetcher=vi.fn(async(url:string)=>Response.json({...value,scope:url.includes('scope=device')?'device':'fantay',totals:{...totals,estimatedUsd:'1.500000',estimatedRequests:1}}));vi.stubGlobal('fetch',fetcher);
  render(<I18nProvider initial="zh-CN"><UsageDashboard /></I18nProvider>);
  await screen.findByText('本地 Token 估算价值');
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('scope=fantay');
  fireEvent.click(screen.getByRole('radio',{name:'本机全部'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>url.includes('scope=device'))).toBe(true));
  expect(await screen.findByText('1 条记录 · 非实际扣费')).toBeInTheDocument();
  expect(screen.getByRole('radio',{name:'本机全部'})).toHaveAttribute('aria-checked','true');
});

it('shows session aggregates even when a source has no per-request count',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...value,totals:{...totals,requests:0,failed:0,sessionRecords:1},recent:[]})));
  render(<I18nProvider initial="zh-CN"><UsageDashboard /></I18nProvider>);
  expect(await screen.findByText('另含 1 条会话汇总')).toBeInTheDocument();
  expect(screen.queryByText('还没有用量记录')).toBeNull();
});

it('shows reported usage and unavailable cost without inventing billed amounts',async()=>{
  const fetcher=vi.fn(async(_url:string,_init?:RequestInit)=>Response.json(value));vi.stubGlobal('fetch',fetcher);
  render(<I18nProvider initial="zh-CN"><UsageDashboard projectId="film" /></I18nProvider>);
  await screen.findByText('费用未提供 1');
  expect(screen.getByText('其他渠道报告费用')).toBeInTheDocument();
  // Failures and the success rate are separate phrases, so a wrap never starts a line with a separator.
  const requestsFoot=screen.getByText('成功率 50%').parentElement!;
  expect(within(requestsFoot).getByText('1 次失败')).toBeInTheDocument();
  expect(requestsFoot.textContent).not.toContain('·');
  // The request without any cost reads as unavailable, never as $0.
  const log=screen.getByRole('table');
  expect(within(log).getByText('未提供')).toBeInTheDocument();
  expect(screen.getByText('有费用记录的请求').nextSibling?.textContent).toBe('1 / 2');
  await waitFor(()=>expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/projectId=film.*activity=1|activity=1.*projectId=film/),expect.anything()));
  expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
});

it('offers every source as a whole filter chip and names what the figures cover',async()=>{
  const fetcher=vi.fn(async(_url:string,_init?:RequestInit)=>Response.json({...value,availableProviders:[{provider:'tokentosea',requests:5},{provider:'claude',requests:2},{provider:'codex',requests:1},{provider:'cursor-agent',requests:1}]}));vi.stubGlobal('fetch',fetcher);
  render(<I18nProvider initial="zh-CN"><UsageDashboard /></I18nProvider>);
  const sources=await screen.findByRole('radiogroup',{name:'按来源筛选'});
  for(const name of ['全部','TokenToSea','Claude','Codex','Cursor'])expect(within(sources).getByText(name)).toBeInTheDocument();
  expect(screen.getByText(/近 30 天/).textContent).toBe('近 30 天 · 全部来源');
});

it('breaks source chips into the fewest even lines that fit the column',()=>{
  // 全部, TokenToSea, Claude, DeepSeek Harness, Codex, Cursor, BYOK at their own widths, 4px apart.
  const chips=[45,109,79,149,77,81,75];
  expect(balancedBreaks(chips,660,4)).toEqual([]);
  // Greedy filling would leave 6 + 1 at 600px and 5 + 2 at 527px; both come out as 3 + 4.
  expect(balancedBreaks(chips,600,4)).toEqual([3]);
  expect(balancedBreaks(chips,527,4)).toEqual([3]);
  expect(balancedBreaks(chips,300,4)).toHaveLength(2);
  for(const room of [600,527,300]){
    const starts=[0,...balancedBreaks(chips,room,4),chips.length];
    for(let line=1;line<starts.length;line+=1){
      const items=chips.slice(starts[line-1],starts[line]);
      expect(items.reduce((sum,width)=>sum+width,0)+4*(items.length-1)).toBeLessThanOrEqual(room);
    }
  }
  // One chip wider than the column: no breaks, the row wraps by itself.
  expect(balancedBreaks([40,700,40],660,4)).toEqual([]);
});

it('keeps the chart read-out inside the plot whatever its width',()=>{
  const place=(columnX:number,tipWidth:number,width:number,preferLeft:boolean)=>{
    const {side,x}=placeReadout({columnX,gap:14,tipWidth,width,preferLeft});
    const from=side==='left'?x-tipWidth:x;
    return {side,from,to:from+Math.min(tipWidth,width)};
  };
  // Room on the preferred side: beside the column.
  expect(place(100,200,600,false)).toEqual({side:'right',from:114,to:314});
  expect(place(500,200,600,true)).toEqual({side:'left',from:286,to:486});
  // No room for a 258px read-out on the preferred right of a 442px plot: the other side, where all of it fits.
  expect(place(280,258,442,false).side).toBe('left');
  // Mid-plot in a narrow window: beside the column where it fits, else over the plot; inside both edges either way.
  expect(place(200,258,442,false).side).toBe('over');
  for(const columnX of [130,160,200,250,300,400]){
    const spot=place(columnX,258,442,columnX>260);
    expect(spot.from).toBeGreaterThanOrEqual(0);
    expect(spot.to).toBeLessThanOrEqual(442);
  }
  // The compact popover's plot.
  for(let columnX=20;columnX<=284;columnX+=8){
    const spot=place(columnX,190,284,columnX>160);
    expect(spot.from).toBeGreaterThanOrEqual(0);
    expect(spot.to).toBeLessThanOrEqual(284);
  }
});

it('keeps the compact form to the range, figures and one chart',async()=>{
  const fetcher=vi.fn(async(_url:string,_init?:RequestInit)=>Response.json({...value,activity:undefined}));vi.stubGlobal('fetch',fetcher);
  render(<I18nProvider initial="zh-CN"><UsageDashboard projectId="film" compact /></I18nProvider>);
  await screen.findByText('费用未提供 1');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByText('活动')).toBeNull();
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('limit=0');
  expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('activity=1');
});

it('shows an em dash instead of $0.00 in reported cost when all requests lack provider cost',async()=>{
  const allUnknown={...totals,requests:12,unknown:12,reportedUsd:'0.000000',failed:0};
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...value,totals:allUnknown})));
  render(<I18nProvider initial="zh-CN"><UsageDashboard projectId="film" /></I18nProvider>);
  const reportedTerm=await screen.findByText('其他渠道报告费用');
  expect(reportedTerm.nextElementSibling?.textContent).toBe('—');
  expect(screen.getByText('TokenToSea 已扣费').nextElementSibling?.textContent).toBe('$0.00');
});

it('collapses long local provider lists behind a toggle and resolves aliased agent icons',async()=>{
  const manyProviders=['tokentosea','claude','codex','gemini','opencode','cursor','grok','antigravity-ide','qoder-cn','omp'].map((provider,index)=>({provider,requests:20-index}));
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...value,availableProviders:manyProviders})));
  render(<I18nProvider initial="zh-CN"><UsageDashboard /></I18nProvider>);
  const toggle=await screen.findByRole('button',{name:'+3 更多'});
  expect(screen.queryByText('Oh My Pi')).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText('Oh My Pi')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'收起'})).toBeInTheDocument();

  const {container}=render(
    <div>
      <AgentIcon id="grok" size={14} />
      <AgentIcon id="antigravity-ide" size={14} />
      <AgentIcon id="qoder-cn" size={14} />
      <AgentIcon id="omp" size={14} />
    </div>,
  );
  expect(container.querySelectorAll('.agent-icon-fallback')).toHaveLength(0);
  expect(container.querySelector('img[src="/agent-icons/antigravity.svg"]')).not.toBeNull();
  expect(container.querySelector('img[src="/agent-icons/qoder.svg"]')).not.toBeNull();
  expect(container.querySelector('img[src="/agent-icons/pi.svg"]')).not.toBeNull();
});
