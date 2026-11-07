import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [packageJson, tauriConfig, ollamaClient, desktopUi, runtimeScript, rustBackend, workflow] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/desktop/ollama.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/desktop/DesktopApp.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/prepare-runtime.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8'),
]);

test('Windows package embeds the standalone runtime and offline WebView2', () => {
  assert.equal(tauriConfig.version, '2.9.4');
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


test('engine start is confirmed by the real Ollama API before reporting success', () => {
  assert.match(rustBackend, /embedded_ollama_ready\(Duration::from_secs\(90\)\)/);
  assert.match(rustBackend, /API est prête/);
  assert.match(ollamaClient, /waitForOllama/);
  assert.match(desktopUi, /await waitForOllama\(DEFAULT_OLLAMA_URL, 95000\)/);
});

test('model downloads re-check the live API instead of trusting stale UI state', () => {
  assert.match(rustBackend, /health_url = format!\("\{\}\/api\/version"/);
  assert.match(rustBackend, /Vertex Local Engine inaccessible/);
  assert.match(desktopUi, /let liveStatus = await getOllamaStatus\(baseUrl\)/);
  assert.match(desktopUi, /runtimeCheckRef/);
});


test('runtime startup is serialized, logged and automatically self-healing', () => {
  assert.match(rustBackend, /OLLAMA_START_LOCK/);
  assert.match(rustBackend, /fn ollama_start_lock\(\) -> &'static tokio::sync::Mutex/);
  assert.match(rustBackend, /append_runtime_log/);
  assert.match(rustBackend, /ollama-staging-/);
  assert.match(rustBackend, /Extraction de \{label\}/);
  assert.match(rustBackend, /Runtime extrait et validé/);
  assert.match(rustBackend, /Duration::from_secs\(90\)/);
  assert.match(rustBackend, /API locale/);
  assert.match(rustBackend, /resource_dir\(\)/);
});

test('Model Hub and chat attempt to start the embedded engine automatically', () => {
  assert.match(desktopUi, /const started = await startEngine\(\)/);
  assert.match(desktopUi, /startPromiseRef/);
  assert.match(desktopUi, /await runtimeEventsReadyRef\.current/);
  assert.match(rustBackend, /start_embedded_ollama\(&app, false\)\.await\?/);
});


test('GitHub release workflow runs on v* tags and publishes both installers', () => {
  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/);
  assert.match(workflow, /softprops\/action-gh-release/);
  assert.match(workflow, /bundle\/msi\/\*\.msi/);
  assert.match(workflow, /bundle\/nsis\/\*\.exe/);
});

test('runtime monitor automatically retries a crashed local engine', () => {
  assert.match(desktopUi, /autoRestartAtRef/);
  assert.match(desktopUi, /Date\.now\(\) - autoRestartAtRef\.current > 30000/);
});

test('runtime extraction reports progress and UI displays extraction percent', () => {
  assert.match(rustBackend, /phase\":\"extract/);
  assert.match(desktopUi, /\['download','extract'\]\.includes\(runtimeProgress\.phase\)/);
});
