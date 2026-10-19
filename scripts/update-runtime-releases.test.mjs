import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseRelease, currentPin, shouldUpdate, usableRelease } from './update-runtime-releases.mjs';
const names=['sd-master-abc-bin-win-cpu-x64.zip','sd-master-abc-bin-Darwin-macOS-26-arm64.zip','sd-master-abc-bin-Linux-Ubuntu-24.04-x86_64.zip'];
test('never downgrades a pin or creates duplicate updates',()=>{
  assert.equal(shouldUpdate('llama','b11011','b11123'),true);
  assert.equal(shouldUpdate('llama','b11123','b11123'),false);
  assert.equal(shouldUpdate('diffusion','master-900-c92d73c','master-899-28b454b'),false);
});
const release=(tag,date)=>({tag_name:tag,published_at:date,draft:false,assets:names.map(name=>({name,size:10,state:'uploaded'}))});
test('ignores incomplete releases and draft uploads',()=>{
  assert.equal(usableRelease('diffusion',{...release('master-1-abc','2026-09-01'),assets:[]}),false);
  assert.equal(usableRelease('diffusion',{...release('master-1-abc','2026-09-01'),draft:true}),false);
});
test('selects the newest eligible binary release, not an upload in progress',()=>{
  const old=release('master-1-abc','2026-09-01'), eligible=release('master-2-def','2026-09-15'), fresh=release('master-3-fff','2026-09-29');
  assert.equal(chooseRelease('diffusion',[fresh,old,eligible],Date.parse('2026-09-30')).tag_name,eligible.tag_name);
});

test('reads the pinned tag from the engine crate', () => {
  const source = `match runtime {
        "diffusion" => ("leejet/stable-diffusion.cpp", "master-929-3f8527a"),
        _ => ("ggml-org/llama.cpp", "b11224"),
    }`;
  assert.equal(currentPin(source, 'ggml-org/llama.cpp'), 'b11224');
  assert.equal(currentPin(source, 'leejet/stable-diffusion.cpp'), 'master-929-3f8527a');
  assert.equal(currentPin(source, 'someone/else'), undefined);
});
