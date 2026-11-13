/**
 * Whether a value is acceptable for a token, given the browser's own CSS.supports. A size may be
 * negative (Open Props ships --size-000: -.5rem), which `width` refuses and `margin-top` takes.
 */
export function studioTokenValueSupported(group: StudioTokenGroup, name: string, value: string, supports: (property: string, value: string) => boolean): boolean {
  const property = studioTokenCssProperty(group, name);
  return supports(property, value) || (group === 'sizing' && property === 'width' && supports('margin-top', value));
}
/** Lossless CSS custom-property editing. Offsets refer to the original source. */
export type StudioTokenGroup = 'colors' | 'typography' | 'spacing' | 'radius' | 'shadows' | 'motion' | 'layout' | 'measure' | 'sizing' | 'layers' | 'other';
export interface StudioToken {
  name: string;
  value: string;
  scope: string;
  group: StudioTokenGroup | null;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

export function studioTokenGroup(name: string, value: string): StudioTokenGroup | null {
  if (/motion|duration|eas(e|ing)|transition|animation/.test(name)) return 'motion';
  if (/^--z-|z-index|layer/.test(name)) return 'layers';
  if (/measure/.test(name)) return 'measure';
  // Fixed sizes and proportions: a size scale, control and target heights, icon sizes, aspect ratios.
  // Anchored at the start, so --font-size-* stays typography and --space-* stays spacing. A control,
  // icon or avatar token is a size only when its size key is a whole word and it names no other
  // property: --control-small-gap is spacing, --avatar-xs-font-size is typography.
  if (/aspect|^--ratio-/.test(name) || /^--(?:base-)?(?:size|sizing)-|^--(?:target|touch|tap)-/.test(name)) return 'sizing';
  if (/^--(?:control|icon|avatar)-/.test(name) && /-(?:size|height|width|min|target|xs|sm|md|lg|xl|2xl|xsmall|small|medium|large|xlarge|\d+)(?=-|$)/.test(name) && !/padding|gap|margin|space|font|line-height|leading|letter|tracking|colou?r|bg|fill|border|radius|shadow/i.test(name)) return 'sizing';
  if (/breakpoint|container|gutter|grid|column|screen/.test(name)) return 'layout';
  if (/shadow|elev/i.test(name)) return 'shadows';
  if (/radius|rounded/i.test(name)) return 'radius';
  if (/font|line-height|leading|tracking|letter-spacing|text-size|^--text-(?:xs|sm|base|md|lg|\d*xl)$/i.test(name)) return 'typography';
  if (/space|spacing|gap|padding|margin/i.test(name)) return 'spacing';
  if (/^(#[\da-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(|color\()/i.test(value) || /color|bg|surface|foreground|^--fg(?:-|$)|accent|border|muted|text|ink|success|danger|warn/i.test(name)) return 'colors';
  return 'other';
}

export function studioTokenCssProperty(group: StudioTokenGroup, name: string): string {
  if(group==='colors')return 'color';
  if(group==='spacing')return 'gap';
  if(group==='radius')return 'border-radius';
  if(group==='shadows')return 'box-shadow';
  if(group==='motion')return /ease/.test(name)?'transition-timing-function':'transition-duration';
  if(group==='layers')return 'z-index';
  if(group==='sizing')return /aspect|ratio/.test(name)?'aspect-ratio':'width';
  if(group==='layout'||group==='measure')return /columns/.test(name)?'column-count':'width';
  if(group==='other')return name;
  if(/weight/.test(name))return 'font-weight';
  if(/line|leading/.test(name))return 'line-height';
  if(/letter|tracking/.test(name))return 'letter-spacing';
  return /size|^--text-/.test(name)?'font-size':'font-family';
}

export function parseStudioTokens(css: string): StudioToken[] {
  const masked = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const tokens: StudioToken[] = [];
  const scopes: string[] = [];
  let boundary = 0;
  let quote = '';
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (quote) { if (c === quote && masked[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { scopes.push(masked.slice(boundary, i).trim()); boundary = i + 1; continue; }
    if (c === '}') { scopes.pop(); boundary = i + 1; continue; }
    if (c === ';') { boundary = i + 1; continue; }
    if (!scopes.length || c !== '-' || masked[i + 1] !== '-') continue;
    const match = /^--[\w-]+\s*:\s*/.exec(masked.slice(i));
    if (!match || masked.slice(boundary, i).trim()) continue;
    const name = match[0].slice(0, match[0].indexOf(':')).trim();
    const valueStart = i + match[0].length;
    let j = valueStart;
    let nesting = 0;
    let valueQuote = '';
    for (; j < masked.length; j++) {
      const ch = masked[j];
      if (valueQuote) { if (ch === valueQuote && masked[j - 1] !== '\\') valueQuote = ''; continue; }
      if (ch === '"' || ch === "'") { valueQuote = ch; continue; }
      if (ch === '(') nesting++;
      if (ch === ')') nesting--;
      if (!nesting && (ch === ';' || ch === '}')) break;
    }
    const valueEnd = j - (masked.slice(valueStart, j).match(/\s*$/)?.[0].length ?? 0);
    const value = css.slice(valueStart, valueEnd);
    tokens.push({ name, value, scope: scopes.join(' / '), group: studioTokenGroup(name, value), start: i, end: j + (masked[j] === ';' ? 1 : 0), valueStart, valueEnd });
    i = j - 1;
  }
  for(const token of tokens){
    if(token.group!=='other')continue;
    const reference=token.value.match(/^var\(\s*(--[\w-]+)/)?.[1];
    const target=reference?tokens.find(item=>item.name===reference&&item.group!=='other'):undefined;
    if(target)token.group=target.group;
  }
  return tokens;
}

export function editStudioToken(css: string, token: StudioToken | null, name: string, value: string, scope = ':root'): string {
  if (!/^--[a-zA-Z_][\w-]*$/.test(name)) throw new Error('INVALID_TOKEN_NAME');
  if (!value.trim() || value.length > 1000 || /[;{}\u0000-\u001f<>]|url\s*\(|expression\s*\(/i.test(value)) throw new Error('INVALID_TOKEN_VALUE');
  const trimmed = value.trim();
  if (token) {
    const current = parseStudioTokens(css).find((item) => item.start === token.start && item.name === token.name && item.value === token.value);
    if (!current) throw new Error('TOKEN_CONFLICT');
    return css.slice(0, current.start) + name + ': ' + trimmed + css.slice(current.valueEnd);
  }
  if (parseStudioTokens(css).some((item) => item.name === name && item.scope === scope)) throw new Error('TOKEN_EXISTS');
  // A separate :root block preserves existing selectors, themes and comments.
  if (/[{}<>;]/.test(scope)) throw new Error('INVALID_TOKEN_SCOPE');
  const scopes = scope.split(' / ');
  return css.trimEnd() + '\n\n' + scopes.map((selector) => selector + ' {').join('\n') + '\n  ' + name + ': ' + trimmed + ';\n' + scopes.map(() => '}').join('\n') + '\n';
}

export function resolveStudioToken(name: string, tokens: StudioToken[], scope = ':root', visited: string[] = []): string | null {
  if (visited.includes(name)||visited.length>100) return null;
  const own = tokens.filter((token) => token.name === name && token.scope === scope).at(-1) ?? tokens.filter((token) => token.name === name && token.scope === ':root').at(-1);
  if (!own) return null;
  const resolveValue=(raw:string):string|null=>{
    let result='';
    for(let i=0;i<raw.length;){
      if(raw.slice(i,i+4)!=='var('){result+=raw[i];i++;continue;}
      let depth=1,end=i+4,comma=-1;
      for(;end<raw.length;end++){const c=raw[end];if(c==='(')depth++;if(c===')'&&--depth===0)break;if(c===','&&depth===1&&comma<0)comma=end;}
      if(depth!==0)return null;
      const reference=raw.slice(i+4,comma<0?end:comma).trim();
      if(!/^--[\w-]+$/.test(reference))return null;
      const value=resolveStudioToken(reference,tokens,scope,[...visited,name])??(comma<0?null:resolveValue(raw.slice(comma+1,end).trim()));
      if(value===null)return null;
      result+=value;i=end+1;
    }
    return result;
  };
  return resolveValue(own.value);
}

export function removeStudioToken(css: string, token: StudioToken): string {
  const tokens = parseStudioTokens(css);
  if (tokens.some((item) => item.name !== token.name && new RegExp('var\\(\\s*' + token.name + '(?:\\s*[,)]|\\s)').test(item.value))) throw new Error('TOKEN_REFERENCED');
  return css.slice(0, token.start) + css.slice(token.end);
}

export function studioContrast(foreground: string, background: string): number | null {
  const luminance = (hex: string): number | null => {
    const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim());
    if (!match?.[1]) return null;
    const value = match[1].length === 3 ? [...match[1]].map((part) => part + part).join('') : match[1];
    const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return a === null || b === null ? null : (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Deliberately excludes DESIGN.md and private project metadata. */
export function isStudioPackageAsset(filePath: string): boolean {
  if (filePath.includes('\\') || filePath.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false;
  return /^(brand\.json|tokens\.css|design-tokens\.json|tailwind-v4\.css|components\.html|components\.manifest\.json|manifest\.json)$/.test(filePath)
    || /^(assets|fonts|logos|imagery|preview|system)\//.test(filePath);
}
