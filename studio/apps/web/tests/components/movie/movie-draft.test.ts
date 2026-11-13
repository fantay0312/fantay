// @vitest-environment jsdom
import {afterEach,describe,expect,it} from 'vitest';
import {MOVIE_STYLES} from '@open-design/contracts';
import {readMovieDraft,saveMovieDraft,clearMovieDraft} from '../../../src/components/movie/movie-draft';
afterEach(()=>localStorage.clear());
describe('Movie creation draft',()=>{
  it('survives reload and remains isolated to its workspace',()=>{
    const draft={title:'Draft film',brief:'My story',mode:'library' as const,aspect:'9:16' as const,style:MOVIE_STYLES[0]!};
    saveMovieDraft('one',draft);expect(readMovieDraft('one')).toEqual(draft);expect(readMovieDraft('two')).toBeNull();
    clearMovieDraft('one');expect(readMovieDraft('one')).toBeNull();
  });
  it('ignores broken or unsafe saved drafts',()=>{
    localStorage.setItem('fantay:movie-draft:v1:one','{"title":false}');expect(readMovieDraft('one')).toBeNull();
  });
});
