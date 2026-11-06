import { describe, expect, it } from 'vitest';
import { insideWorkspace, runArtifactTarget } from './runArtifactTarget.js';

const WIN = 'C:\\work\\repo';
const OUT = 'nekko-training/run-1';

describe('runArtifactTarget', () => {
  it('opens a document inside the workspace', () => {
    expect(runArtifactTarget(WIN, 'nekko-training/run-1/report.md', OUT)).toEqual({
      path: 'C:\\work\\repo\\nekko-training/run-1/report.md',
      opensFile: true,
    });
    expect(runArtifactTarget('/home/u/repo', '/home/u/repo/out/chart.png', OUT).opensFile).toBe(true);
  });

  it('opens the output folder for anything that is not a listed document type', () => {
    for (const rel of ['out/model.cmd', 'out/model.safetensors', 'run.bat', 'tool.exe', 'script.js', 'out', 'x.lnk']) {
      expect(runArtifactTarget(WIN, rel, OUT)).toEqual({ path: 'C:\\work\\repo\\nekko-training/run-1', opensFile: false });
    }
  });

  it('opens the output folder for paths outside the workspace', () => {
    for (const rel of ['../other/report.md', 'C:\\Users\\me\\report.md', '\\\\host\\share\\report.md', 'a/../../report.md']) {
      expect(runArtifactTarget(WIN, rel, OUT).opensFile).toBe(false);
    }
    expect(runArtifactTarget(undefined, 'report.md', OUT).opensFile).toBe(false);
  });
});

describe('insideWorkspace', () => {
  it('compares Windows paths without case and POSIX paths with it', () => {
    expect(insideWorkspace(WIN, 'c:/WORK/repo/a.md')).toBe(true);
    expect(insideWorkspace(WIN, 'C:\\work\\repo2\\a.md')).toBe(false);
    expect(insideWorkspace('/home/u/repo', '/home/u/Repo/a.md')).toBe(false);
    expect(insideWorkspace('/home/u/repo', 'a/./b.md')).toBe(true);
    expect(insideWorkspace('/home/u/repo', '')).toBe(false);
  });
});
