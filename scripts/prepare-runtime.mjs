import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'src-tauri', 'resources');
await mkdir(resources, { recursive: true });
const assets = [
  ['ollama-windows-amd64.zip', 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip'],
];
for (const [name, url] of assets) {
  const target = path.join(resources, name);
  try { const info = await stat(target); if (info.size > 1024 * 1024) { console.log(`${name}: archive déjà présente (${(info.size / 1024 ** 2).toFixed(0)} Mo)`); continue; } } catch {}
  const temp = `${target}.download`;
  console.log(`Téléchargement du runtime officiel ${name}…`);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(45 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Téléchargement ${name} impossible: HTTP ${response.status}`);
  const finalUrl = response.url;
  if (!finalUrl.startsWith('https://github.com/') && !finalUrl.startsWith('https://release-assets.githubusercontent.com/')) throw new Error(`Hôte de téléchargement inattendu: ${finalUrl}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  const info = await stat(temp);
  if (info.size < 1024 * 1024) { await rm(temp, { force: true }); throw new Error(`Archive ${name} trop petite ou invalide (${info.size} octets)`); }
  await rm(target, { force: true });
  await rename(temp, target);
  console.log(`${name}: ${(info.size / 1024 ** 2).toFixed(0)} Mo téléchargés.`);
}
