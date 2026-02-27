'use strict';

const Mustache = require('mustache');
const { getDb } = require('./db');

/**
 * Fire all matching webhooks for a project event.
 * @param {string} projectId
 * @param {string} eventType  - 'status' | 'member' | 'archive' | 'edit'
 * @param {object|null} updateData - the status_update row, or null
 */
async function fireHooks(projectId, eventType, updateData) {
  const db = getDb();

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return;

  const subscriptions = db.prepare(`
    SELECT ph.event_filter, ph.enabled as sub_enabled,
           h.id as hook_id, h.name, h.url, h.method,
           h.headers_json, h.body_template, h.enabled as hook_enabled
    FROM project_hooks ph
    JOIN hooks h ON h.id = ph.hook_id
    WHERE ph.project_id = ? AND ph.enabled = 1 AND h.enabled = 1
  `).all(projectId);

  for (const sub of subscriptions) {
    if (sub.event_filter) {
      const allowed = sub.event_filter.split(',').map(s => s.trim());
      if (!allowed.includes(eventType)) continue;
    }

    const context = {
      project: {
        id: project.id,
        name: project.name,
        description: project.description || ''
      },
      update: updateData ? {
        id: updateData.id || '',
        author: updateData.author || '',
        text: updateData.status_text || updateData.text || '',
        created_at: updateData.created_at || new Date().toISOString()
      } : {},
      event: { type: eventType },
      timestamp: new Date().toISOString()
    };

    let headers = {};
    if (sub.headers_json) {
      try {
        headers = JSON.parse(sub.headers_json);
      } catch (e) {
        console.error(`[hooks] Bad headers JSON for hook ${sub.hook_id}:`, e.message);
      }
    }

    let bodyStr = null;
    let isJson = false;
    if (sub.body_template) {
      try {
        bodyStr = Mustache.render(sub.body_template, context);
        // Try to parse as JSON to send properly typed
        JSON.parse(bodyStr);
        isJson = true;
      } catch (_) {
        isJson = false;
      }
    }

    const method = (sub.method || 'POST').toUpperCase();
    const fetchHeaders = {
      ...(isJson ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'text/plain' }),
      ...headers
    };

    try {
      const fetchOpts = { method, headers: fetchHeaders };
      if (bodyStr !== null && method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = bodyStr;
      }

      const response = await fetch(sub.url, fetchOpts);
      const responseText = await response.text().catch(() => '');

      db.prepare(`
        INSERT INTO hook_log (project_id, hook_id, event_type, status_code, response_body)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, sub.hook_id, eventType, response.status, responseText.slice(0, 2000));

      console.log(`[hooks] ${sub.hook_id} -> ${sub.url}: ${response.status}`);
    } catch (err) {
      db.prepare(`
        INSERT INTO hook_log (project_id, hook_id, event_type, error)
        VALUES (?, ?, ?, ?)
      `).run(projectId, sub.hook_id, eventType, err.message);

      console.error(`[hooks] Failed to fire hook ${sub.hook_id}:`, err.message);
    }
  }
}

module.exports = { fireHooks };
