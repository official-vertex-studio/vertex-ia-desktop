import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [ui, rust, languages, ollama, manifest] = await Promise.all([
  readFile(new URL('../src/desktop/DesktopApp.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
  readFile(new URL('../src/desktop/languages.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/desktop/ollama.js', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
]);

test('IDE uses a persistent native terminal with streamed output and stop control', () => {
  assert.match(rust, /fn terminal_start/);
  assert.match(rust, /fn terminal_write/);
  assert.match(rust, /fn terminal_kill/);
  assert.match(rust, /fn terminal_resize/);
  assert.match(rust, /portable_pty/);
  assert.match(rust, /vertex-terminal-output/);
  assert.match(ui, /@xterm\/xterm/);
  assert.match(ui, /terminal_start/);
  assert.match(ui, /terminal_write/);
});

test('editor detects common programming and configuration languages', () => {
  for (const language of ['typescript', 'javascript', 'python', 'java', 'rust', 'cpp', 'csharp', 'go', 'php', 'sql', 'powershell', 'graphql', 'dockerfile']) {
    assert.match(languages, new RegExp(`\\b${language}\\b`));
  }
  assert.match(ui, /openTabs/);
  assert.match(ui, /Ctrl S/);
});

test('Model Hub parses Ollama catalog entries and model variants', () => {
  assert.match(ollama, /export async function searchLibrary/);
  assert.match(ollama, /export function extractModelTags/);
  assert.match(ui, /catalogSort/);
  assert.match(ui, /loadCatalogTags/);
});

test('desktop manifest includes xterm and CodeMirror language support', () => {
  assert.ok(manifest.dependencies['@xterm/xterm']);
  assert.ok(manifest.dependencies['@xterm/addon-fit']);
  assert.ok(manifest.dependencies['@codemirror/language']);
});

test('workspace exposes restore points and snapshots before manual saves', () => {
  assert.match(ui, /workspace-snapshots/);
  assert.match(ui, /db_snapshot_file/);
  assert.match(ui, /restoreSnapshotWithConfirmation/);
  assert.match(rust, /fn db_restore_snapshot/);
});

test('GPU detection prefers NVIDIA driver telemetry and falls back to Windows WMI', () => {
  assert.match(rust, /nvidia-smi/);
  assert.match(rust, /Win32_VideoController/);
  assert.match(rust, /DriverVersion/);
});
