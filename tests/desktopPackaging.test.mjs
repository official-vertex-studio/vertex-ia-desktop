import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [packageJson, tauriConfig, ollamaClient, desktopUi, runtimeScript] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/desktop/ollama.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/desktop/DesktopApp.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/prepare-runtime.mjs', import.meta.url), 'utf8'),
]);

test('Windows package embeds the standalone runtime and offline WebView2', () => {
  assert.equal(tauriConfig.version, '2.9.0');
  assert.ok(tauriConfig.bundle.resources.includes('resources/ollama-windows-amd64.zip'));
  assert.equal(tauriConfig.bundle.windows.webviewInstallMode.type, 'offlineInstaller');
  assert.equal(tauriConfig.bundle.windows.bundleVCRuntime, true);
});

test('desktop uses a private local engine port and no winget install flow', () => {
  assert.match(ollamaClient, /127\.0\.0\.1:11435/);
  assert.doesNotMatch(desktopUi, /ollama_install_or_update|winget/);
  assert.match(desktopUi, /ollama_runtime_update/);
});

test('Windows build prepares the official Ollama runtime archive', () => {
  assert.match(packageJson.scripts['tauri:build'], /prepare:runtime/);
  assert.match(runtimeScript, /github\.com\/ollama\/ollama\/releases\/latest\/download\/ollama-windows-amd64\.zip/);
});
