import type { MovieCaption } from '@open-design/contracts';
export function parseMovieSubtitles(text:string,duration:number):MovieCaption[]{
  const cues:MovieCaption[]=[];
  const seconds=(h:string,m:string,s:string,ms:string)=>Number(h)*3600+Number(m)*60+Number(s)+Number(ms)/1000;
  for(const block of text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim().split(/\n\s*\n/)){
    const lines=block.split('\n'),index=lines.findIndex(l=>l.includes('-->'));if(index<0)continue;
    const time=/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(lines[index]!.trim());
    if(!time)throw new Error('SRT 时间码无效 / Invalid SRT timestamp');
    const start=seconds(time[1]!,time[2]!,time[3]!,time[4]!),end=seconds(time[5]!,time[6]!,time[7]!,time[8]!),content=lines.slice(index+1).join('\n').trim();
    if(!content||content.length>300||start<(cues.at(-1)?.end??0)||end<=start||end>duration+.05)throw new Error('字幕须排序、不重叠且位于所选片段内 / Cues must fit the selected clip');
    cues.push({start,end:Math.min(end,duration),text:content});if(cues.length>2000)throw new Error('最多 2000 条字幕 / At most 2000 captions');
  }
  if(!cues.length)throw new Error('未找到 SRT 字幕 / No SRT captions found');return cues;
}
export function movieSubtitlesText(captions:MovieCaption[]):string{
  const stamp=(t:number)=>{const ms=Math.round(t*1000),h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
  return captions.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}
