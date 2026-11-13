export const EDITOR_FEATURED_MODELS = [
  {id:'gemini-4-argon',name:'Gemini 4 Argon',kind:'chat',aliases:['gemini-4-argon'],source:'https://ai.google.dev/gemini-api/docs/models/gemini-4-argon'},
  {id:'muse-wonder',name:'Muse Wonder',kind:'chat',aliases:['muse-wonder-1.0','muse-wonder'],source:'https://dev.meta.ai/docs/models'},
  {id:'kling-v4',name:'Kling V4',kind:'video',aliases:['kling-v4','kling-video-v4','klingai/kling-v4'],source:'https://developers.cloudflare.com/ai/models/klingai/kling-v4/'},
] as const;
export interface EditorCatalogModel { id:string;model:string;name?:string;displayName?:string;modality?:string;executionKind?:string;available?:boolean;toolCalling?:boolean;supportsTools?:boolean }
const normalized=(value:string)=>value.toLowerCase().replace(/[\s_.:/-]/g,'');
export function featuredEditorModel<T extends EditorCatalogModel>(feature:(typeof EDITOR_FEATURED_MODELS)[number],models:readonly T[]):T|undefined {
  return models.find(model=>model.available!==false
    && (feature.kind==='video' ? model.modality==='video'&&Boolean(model.executionKind) : !model.executionKind&&(model.toolCalling===true||model.supportsTools===true))
    && [model.model,model.name??'',model.displayName??''].some(value=>[feature.name,...feature.aliases].some(alias=>normalized(value)===normalized(alias)||normalized(value.split('/').at(-1)??'')===normalized(alias))));
}
