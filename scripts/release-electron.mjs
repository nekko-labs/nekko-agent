// Fetch the official Electron distribution through the release-assets API.
// electron-builder's custom ZIP path bypasses its failing browser-download URL,
// not integrity validation: both the official asset digest and SHASUMS must match.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export function archiveName(version, platform, arch) {
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid Electron version');
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Electron platform/architecture');
  return `electron-v${version}-${platform}-${arch}.zip`;
}

export function selectAssets(release, version, name) {
  if (release.tag_name !== `v${version}` || release.draft) throw new Error('Unexpected Electron release identity');
  return [name, 'SHASUMS256.txt'].map(filename => {
    const matches = release.assets.filter(asset => asset.name === filename);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].size <= 0) throw new Error(`Missing or ambiguous Electron asset: ${filename}`);
    return matches[0];
  });
}

export function expectedChecksum(text, name) {
  const matches = text.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/)).filter(match => match?.[2] === name);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous checksum: ${name}`);
  return matches[0][1];
}

export async function verifyArchive(file, asset, checksum) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  const digest = hash.digest('hex');
  if (size !== asset.size || digest !== checksum) throw new Error('Electron archive size/SHA256 mismatch');
  if (asset.digest && asset.digest !== `sha256:${digest}`) throw new Error('Electron GitHub asset digest mismatch');
  return digest;
}

export async function downloadElectron({ version, platform, arch, directory, token, request = fetch }) {
  const name = archiveName(version, platform, arch);
  // Authentication is sent only to api.github.com, never an arbitrary mirror.
  // fetch strips Authorization when following cross-origin asset redirects.
  const get = async (endpoint, accept) => {
    const response = await request(`https://api.github.com/repos/electron/electron/${endpoint}`, {
      headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Electron API ${endpoint}: HTTP ${response.status}`);
    return response;
  };
  const release = await (await get(`releases/tags/v${version}`, 'application/vnd.github+json')).json();
  const [archive, sums] = selectAssets(release, version, name);
  const checksumBytes = Buffer.from(await (await get(`releases/assets/${sums.id}`, 'application/octet-stream')).arrayBuffer());
  if (checksumBytes.length !== sums.size) throw new Error('Electron checksum file size mismatch');
  if (sums.digest && sums.digest !== `sha256:${createHash('sha256').update(checksumBytes).digest('hex')}`) throw new Error('Electron checksum file digest mismatch');
  const checksum = expectedChecksum(checksumBytes.toString('utf8'), name);
  await mkdir(directory, { recursive: true });
  const destination = path.resolve(directory, name);
  const temporary = `${destination}.part`;
  try {
    const response = await get(`releases/assets/${archive.id}`, 'application/octet-stream');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    const digest = await verifyArchive(temporary, archive, checksum);
    await rename(temporary, destination);
    console.log(`Verified official Electron ${name}: sha256:${digest}`);
    return destination;
  } finally { await rm(temporary, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8'));
  const destination = await downloadElectron({ version: pkg.version, platform: process.platform, arch: process.arch,
    directory: path.join(process.env.RUNNER_TEMP || '.scratch', 'release-electron'), token: process.env.GH_TOKEN });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `electron_dist=${destination}\n`);
}
