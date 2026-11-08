// Seed electron-builder's documented archive cache through the official API.
// These are the upstream 26.17.0 pins, not hashes learned from downloaded bytes.
import { mkdir, rename, rm, readFile, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { verifyArchive } from './release-electron.mjs';

const tool = (release, name, sha256, source) => ({ release, name, sha256, source });
const icons = tool('icons@1.2.3', 'icons-bundle.tar.gz', '4e5bb546c9d3ab0c2bbacc22857467bf415f742a34c2be9dd138779d2fc066f9', 'app-builder-lib/out/toolsets/icons.js');
const sevenZip = (name, sha256) => tool('7zip@1.0.0', name, sha256, 'app-builder-lib/out/toolsets/7zip.js');
const windows = (release, name, sha256) => tool(release, name, sha256, 'app-builder-lib/out/toolsets/windows.js');
const linux = (release, name, sha256) => tool(release, name, sha256, 'app-builder-lib/out/toolsets/linux.js');
const inventory = {
  'linux/x64': [
    icons,
    sevenZip('7zip-linux-x64.tar.gz', 'd151bb44b2a9d9bfc52813ce4cac042916394a0ab8a56bd5d221a5dc9ef8d5d7'),
    linux('appimage-12.0.1', 'appimage-12.0.1.7z', 'd12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4'),
    linux('fpm@2.1.4', 'fpm-1.17.0-ruby-3.4.3-linux-amd64.7z', '44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f'),
  ],
  'darwin/arm64': [
    icons,
    sevenZip('7zip-darwin-arm64.tar.gz', '496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1'),
    tool('dmg-builder@1.2.5', 'dmgbuild-bundle-arm64-75c8a6c.tar.gz', '793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb', 'dmg-builder/out/dmgUtil.js'),
  ],
  'win32/x64': [
    icons,
    sevenZip('7zip-win-x64.tar.gz', 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3'),
    windows('winCodeSign-2.6.0', 'winCodeSign-2.6.0.7z', 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4'),
    windows('nsis-3.0.4.1', 'nsis-3.0.4.1.7z', '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'),
    windows('nsis-resources-3.4.1', 'nsis-resources-3.4.1.7z', '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'),
  ],
};

export function toolsFor(platform, arch) {
  const tools = inventory[`${platform}/${arch}`];
  if (!tools) throw new Error(`Unsupported release tool platform: ${platform}/${arch}`);
  return tools.map(item => ({ ...item }));
}

export async function validateInstalledTools(require, tools) {
  for (const pkg of ['app-builder-lib', 'dmg-builder']) {
    if (require(`${pkg}/package.json`).version !== '26.17.0') throw new Error(`Review release tool pins for changed ${pkg} version`);
  }
  for (const item of tools) {
    const source = await readFile(require.resolve(item.source), 'utf8');
    if (![item.name, item.sha256].every(value => source.includes(value))) throw new Error(`Upstream tool pin changed: ${item.name}`);
  }
}

export function selectToolAsset(release, item) {
  if (!/^[A-Za-z0-9][A-Za-z0-9@._-]*$/.test(item.release) || item.release.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name) || item.name.includes('..') || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Unsafe release tool identity');
  if (release.tag_name !== item.release || release.draft) throw new Error('Unexpected builder tool release identity');
  const matches = release.assets.filter(asset => asset.name === item.name);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0 || !Number.isSafeInteger(matches[0].size) || matches[0].size <= 0) throw new Error(`Missing or ambiguous builder tool: ${item.name}`);
  return matches[0];
}

export async function seedBuilderTools({ tools, directory, token, request = fetch }) {
  const get = async (endpoint, accept) => {
    const response = await request(`https://api.github.com/repos/electron-userland/electron-builder-binaries/${endpoint}`, {
      headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Builder tools API ${endpoint}: HTTP ${response.status}`);
    return response;
  };
  for (const item of tools) {
    // Validate input before constructing a URL or touching the cache.
    selectToolAsset({ tag_name: item.release, assets: [{ id: 1, name: item.name, size: 1 }] }, item);
    const release = await (await get(`releases/tags/${encodeURIComponent(item.release)}`, 'application/vnd.github+json')).json();
    const asset = selectToolAsset(release, item);
    const destination = path.resolve(directory, item.release, item.name);
    const temporary = `${destination}.part`;
    await mkdir(path.dirname(destination), { recursive: true });
    // Never allow an older archive to be consumed after this invocation fails.
    await rm(destination, { force: true });
    try {
      const response = await get(`releases/assets/${asset.id}`, 'application/octet-stream');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      const digest = await verifyArchive(temporary, asset, item.sha256);
      await rename(temporary, destination);
      console.log(`Verified builder tool ${item.release}/${item.name}: sha256:${digest}`);
    } finally { await rm(temporary, { force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(path.resolve('package.json'));
  const tools = toolsFor(process.platform, process.arch);
  await validateInstalledTools(require, tools);
  if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('Release tool seeding requires an isolated runner');
  // A fresh cache avoids trusting an extracted directory restored by Actions.
  const directory = path.join(process.env.RUNNER_TEMP, 'verified-builder-tools');
  await seedBuilderTools({ tools, directory, token: process.env.GH_TOKEN });
  await appendFile(process.env.GITHUB_ENV, `ELECTRON_BUILDER_CACHE=${directory}\n`);
}
