import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateUserData } from './user-data.js';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d,{ recursive:true, force:true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(),'nekko-migration-')); dirs.push(dir); const source=join(dir,'old'), target=join(dir,'new'); mkdirSync(source); return {dir,source,target}; }
describe('confirmed user-data migration', () => {
  it('moves data, rewrites owned paths and leaves borrowed paths and IDs alone', () => {
    const {source,target,dir}=fixture(); const borrowed=join(dir,'borrowed');
    writeFileSync(join(source,'settings.json'),JSON.stringify({engine:{modelsDir:join(source,'models'),autoload:['repo/model']},workspaces:[{path:borrowed}]}));
    mkdirSync(join(source,'engine')); writeFileSync(join(source,'engine','engine.json'),JSON.stringify({binPath:join(source,'engine','binary')}));
    migrateUserData(source,target);
    const settings=JSON.parse(readFileSync(join(target,'settings.json'),'utf8'));
    expect(settings.engine.modelsDir).toBe(join(target,'models')); expect(settings.engine.autoload).toEqual(['repo/model']); expect(settings.workspaces[0].path).toBe(borrowed);
    expect(existsSync(join(source,'settings.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(target,'engine','engine.json'),'utf8')).binPath).toBe(join(target,'engine','binary'));
  });
  it('reorganizes managed model folders while preserving stored IDs and presets', () => {
    const {source,target}=fixture(); const modelDir=join(source,'models','org_repo'); mkdirSync(modelDir,{recursive:true});
    writeFileSync(join(modelDir,'sd3.gguf'),'fixture');
    writeFileSync(join(source,'models','library.json'),JSON.stringify({models:{stable:{id:'org_repo/sd3',name:'SD3.5',architecture:'sd3',folderId:'primary',file:join(modelDir,'sd3.gguf'),preset:{ttlSeconds:0}}}}));
    writeFileSync(join(source,'settings.json'),JSON.stringify({engine:{autoload:['org_repo/sd3']}}));
    migrateUserData(source,target);
    const m=JSON.parse(readFileSync(join(target,'models','library.json'),'utf8')).models.stable;
    expect(m.id).toBe('org_repo/sd3'); expect(m.file).toBe(join(target,'models','image','org_repo','sd3.gguf')); expect(m.preset.ttlSeconds).toBe(0); expect(existsSync(m.file)).toBe(true);
  });
  it('refuses occupied destinations without overwriting either profile', () => {
    const {source,target}=fixture(); mkdirSync(target); writeFileSync(join(source,'settings.json'),'{}'); writeFileSync(join(target,'settings.json'),'{"theme":"dark"}');
    expect(()=>migrateUserData(source,target)).toThrow('already contains'); expect(readFileSync(join(target,'settings.json'),'utf8')).toContain('dark'); expect(existsSync(join(source,'settings.json'))).toBe(true);
  });
  it('moves the desktop browser profile beneath the new root after confirmation', () => {
    const {dir,target}=fixture(); const profile=join(dir,'profile'), source=join(profile,'nekko-agent'); mkdirSync(source,{recursive:true});
    writeFileSync(join(source,'settings.json'),'{}'); mkdirSync(join(profile,'Local Storage')); writeFileSync(join(profile,'Local Storage','fixture'),'ui settings');
    migrateUserData(source,target,profile);
    expect(readFileSync(join(target,'desktop','Local Storage','fixture'),'utf8')).toBe('ui settings'); expect(existsSync(join(profile,'Local Storage'))).toBe(false);
  });
  it('moves the desktop browser profile into one the running app already started', () => {
    const {dir,target}=fixture(); const profile=join(dir,'profile'), source=join(profile,'nekko-agent'), started=join(target,'desktop'); mkdirSync(source,{recursive:true}); mkdirSync(started,{recursive:true});
    writeFileSync(join(source,'settings.json'),'{}'); writeFileSync(join(profile,'Local State'),'old'); mkdirSync(join(profile,'Local Storage')); writeFileSync(join(profile,'Local Storage','fixture'),'ui settings');
    writeFileSync(join(started,'Local State'),'running'); writeFileSync(join(started,'lockfile'),'');
    for (const name of ['SingletonLock','SingletonCookie','SingletonSocket']) {
      // Windows profiles use files; creating POSIX-style symlinks there requires
      // privileges unrelated to the migration being exercised.
      if (process.platform === 'win32') writeFileSync(join(started,name),'fixture');
      else symlinkSync('fixture',join(started,name));
    }
    migrateUserData(source,target,profile);
    expect(existsSync(join(target,'settings.json'))).toBe(true); expect(readFileSync(join(started,'Local Storage','fixture'),'utf8')).toBe('ui settings');
    expect(readFileSync(join(started,'Local State'),'utf8')).toBe('running'); expect(readFileSync(join(profile,'Local State'),'utf8')).toBe('old');
  });
  it('refuses nested source/destination paths', () => { const {source}=fixture(); expect(()=>migrateUserData(source,join(source,'new'))).toThrow('separate'); });
  it('resumes an interrupted move and finishes updating references', () => {
    const {source,target}=fixture(); mkdirSync(target); writeFileSync(join(target,'settings.json'),JSON.stringify({engineBinPath:join(source,'engine','bin')}));
    mkdirSync(join(source,'engine')); writeFileSync(join(source,'engine','bin'),'fixture');
    writeFileSync(join(target,'migration.json'),JSON.stringify({from:source,to:target,phase:'moving'}));
    migrateUserData(source,target); expect(existsSync(join(target,'engine','bin'))).toBe(true); expect(JSON.parse(readFileSync(join(target,'settings.json'),'utf8')).engineBinPath).toBe(join(target,'engine','bin'));
  });
});
