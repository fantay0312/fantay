import {expect,it} from 'vitest';
import {EDITOR_FEATURED_MODELS,featuredEditorModel} from '../../src/api/editor-models.js';

it('uses real authorized model rows and never creates an unavailable catalog entry',()=>{
  const gemini=EDITOR_FEATURED_MODELS[0],muse=EDITOR_FEATURED_MODELS[1],kling=EDITOR_FEATURED_MODELS[2];
  expect(featuredEditorModel(gemini,[])).toBeUndefined();
  expect(featuredEditorModel(gemini,[{id:'listing',model:'gemini-4-argon',toolCalling:true,available:false}])).toBeUndefined();
  expect(featuredEditorModel(gemini,[{id:'listing',model:'google/gemini-4-argon',toolCalling:true}])?.id).toBe('listing');
  expect(featuredEditorModel(muse,[{id:'meta-listing',model:'muse-wonder-1.0',supportsTools:true}])?.id).toBe('meta-listing');
  expect(featuredEditorModel(kling,[{id:'video-listing',model:'kling-video-v4',modality:'video',executionKind:'official'}])?.id).toBe('video-listing');
  expect(featuredEditorModel(gemini,[{id:'wrong',model:'gemini-4-argon-pro',toolCalling:true}])).toBeUndefined();
});
