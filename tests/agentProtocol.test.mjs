import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentPlan, isSafeProjectRelativePath } from '../src/desktop/agentProtocol.js';

test('parses a JSON agent plan wrapped in markdown fences', () => {
  const plan = parseAgentPlan('```json\n{"summary":"ok","actions":[{"type":"write_file","path":"src/a.js","content":"ok"}]}\n```');
  assert.equal(plan.summary, 'ok');
  assert.equal(plan.actions.length, 1);
});

test('rejects invalid agent JSON', () => { assert.throws(() => parseAgentPlan('not json')); });

test('allows safe relative paths', () => { assert.equal(isSafeProjectRelativePath('src/components/App.jsx'), true); });

test('rejects traversal and absolute paths', () => {
  for (const path of ['../secret.txt', 'src/../../secret', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share']) assert.equal(isSafeProjectRelativePath(path), false);
});
