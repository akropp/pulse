'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('fireHooks safely renders JSON body templates with special characters', async (t) => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-webhook-test-'));

  let db;
  const originalFetch = global.fetch;
  const captured = { options: null };

  t.after(() => {
    global.fetch = originalFetch;
    if (db) db.close();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  process.chdir(tempDir);

  const dbModulePath = path.resolve(__dirname, '..', 'db.js');
  const webhookEngineModulePath = path.resolve(__dirname, '..', 'webhook-engine.js');

  delete require.cache[dbModulePath];
  delete require.cache[webhookEngineModulePath];

  const { getDb } = require(dbModulePath);
  const { fireHooks } = require(webhookEngineModulePath);

  db = getDb();
  db.prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').run('p1', 'Project One', 'Demo');
  db.prepare(`
    INSERT INTO hooks (id, name, url, method, headers_json, body_template, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
    'h1',
    'Test Hook',
    'https://example.test/hook',
    'POST',
    null,
    JSON.stringify({
      payload: {
        message: '{{{update.text}}}',
        author: '{{{update.author}}}'
      },
      items: ['{{{project.name}}}', '{{{update.text}}}']
    })
  );
  db.prepare(`
    INSERT INTO project_hooks (project_id, hook_id, event_filter, enabled)
    VALUES (?, ?, ?, 1)
  `).run('p1', 'h1', 'status');

  global.fetch = async (_url, options) => {
    captured.options = options;
    return {
      status: 200,
      text: async () => 'ok'
    };
  };

  const unsafeText = 'He said "hello"\nand used a backslash \\\\.';
  await fireHooks('p1', 'status', {
    id: 99,
    author: 'A "quoted" user',
    status_text: unsafeText,
    created_at: new Date().toISOString()
  });

  assert.ok(captured.options, 'fetch should be called');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');

  const parsedBody = JSON.parse(captured.options.body);
  assert.equal(parsedBody.payload.message, unsafeText);
  assert.equal(parsedBody.payload.author, 'A "quoted" user');
  assert.equal(parsedBody.items[0], 'Project One');
  assert.equal(parsedBody.items[1], unsafeText);
});
