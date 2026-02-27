# Swarmboard — Project Status Tracker

## Overview

Standalone project status server that tracks what agents and humans are working on, with notifications routed through OpenClaw's existing messaging infrastructure.

## Architecture

- **Server:** Node.js + Express + SQLite
- **Port:** 18800 (TBD)
- **Host:** beelink2, systemd service (not Docker for now, Dockerize for public release later)
- **Web UI:** Built-in at `GET /`, standalone page, embeddable in dashboard via iframe

## API

```
POST   /projects                    — Create project
GET    /projects                    — List projects
GET    /projects/:id                — Get project details + latest status
PUT    /projects/:id                — Update project metadata
DELETE /projects/:id                — Archive project
POST   /projects/:id/status         — Post status update
GET    /projects/:id/history        — Get status update history
CRUD   /projects/:id/notifications  — Manage notification prefs per project
```

## Data Model

```sql
projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  archived INTEGER DEFAULT 0
)

project_members (
  project_id TEXT REFERENCES projects(id),
  member_name TEXT,  -- agent name or human name
  role TEXT,         -- 'owner', 'contributor', 'watcher'
  PRIMARY KEY (project_id, member_name)
)

status_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  author TEXT NOT NULL,
  status_text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)

notification_prefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  channel TEXT,   -- 'discord', 'telegram', etc.
  target TEXT,    -- channel ID or chat ID
  enabled INTEGER DEFAULT 1
)
```

## Notification Strategy (Generic Webhook Hooks)

Pulse has a generic hook system. Hooks are named, templated webhook definitions.
Each project subscribes to one or more hooks, optionally filtered by event type.

### Hook Definitions (server-level)

```sql
hooks (
  id TEXT PRIMARY KEY,           -- e.g. "notify-telegram-clawd"
  name TEXT NOT NULL,            -- human-readable name
  url TEXT NOT NULL,             -- webhook endpoint URL
  method TEXT DEFAULT 'POST',    -- HTTP method
  headers_json TEXT,             -- JSON object of headers (e.g. {"Authorization": "Bearer xxx"})
  body_template TEXT,            -- Mustache/Handlebars template for POST body
  enabled INTEGER DEFAULT 1
)
```

Example hooks:
```json
[
  {
    "id": "notify-telegram-clawd",
    "name": "Telegram via Clawd",
    "url": "http://localhost:18789/hooks/pulse",
    "headers": { "Authorization": "Bearer <token>" },
    "bodyTemplate": {
      "agentId": "clawd",
      "channel": "telegram",
      "accountId": "clawd",
      "target": "8216994955",
      "project": "{{project.name}}",
      "author": "{{update.author}}",
      "text": "{{update.text}}"
    }
  },
  {
    "id": "notify-discord-gilfoyle",
    "name": "Discord via Gilfoyle",
    "url": "http://localhost:18789/hooks/pulse",
    "headers": { "Authorization": "Bearer <token>" },
    "bodyTemplate": {
      "agentId": "gilfoyle",
      "channel": "discord",
      "accountId": "gilfoyle",
      "target": "1476975040150114366",
      "project": "{{project.name}}",
      "author": "{{update.author}}",
      "text": "{{update.text}}"
    }
  },
  {
    "id": "notify-slack-webhook",
    "name": "Slack Channel",
    "url": "https://hooks.slack.com/services/xxx/yyy/zzz",
    "headers": {},
    "bodyTemplate": {
      "text": "📋 *{{project.name}}* — {{update.author}}: {{update.text}}"
    }
  }
]
```

### Project → Hook Subscriptions

```sql
project_hooks (
  project_id TEXT REFERENCES projects(id),
  hook_id TEXT REFERENCES hooks(id),
  event_filter TEXT,    -- NULL = all events, or comma-separated: "status,member,archive"
  enabled INTEGER DEFAULT 1,
  PRIMARY KEY (project_id, hook_id)
)
```

### Event Types
- `status` — new status update posted
- `member` — member added/removed
- `archive` — project archived/unarchived
- `edit` — project metadata changed
- (extensible — just add new event type strings)

### Flow
1. Event occurs (status update, member change, etc.)
2. Pulse looks up project_hooks for that project + event type
3. For each matching hook: render body_template with context, POST to URL with headers
4. Log result (success/failure) for debugging

### OpenClaw Integration (auto-configure)

`pulse` CLI can auto-configure both sides:

```bash
# Creates a hook in Pulse AND adds matching mapping in openclaw.json
pulse hooks add-openclaw \
  --name "Discord via Gilfoyle" \
  --agent gilfoyle \
  --channel discord \
  --target 1476975040150114366 \
  --model openai-codex/gpt-4.1-mini \
  --openclaw-config ~/.openclaw/openclaw.json

# What this does:
# 1. Reads openclaw.json to get hooks.token and gateway port
# 2. Creates a hook in Pulse pointing to http://localhost:<port>/hooks/pulse
# 3. Adds a hook mapping to openclaw.json hooks.mappings (if not already present)
# 4. The openclaw mapping is generic — handles all Pulse notifications:
```

The single OpenClaw hook mapping (added once):
```json
{
  "match": { "path": "pulse" },
  "action": "agent",
  "wakeMode": "now",
  "name": "Pulse Notification",
  "agentId": "{{payload.agentId}}",
  "sessionKey": "hook:pulse-notify",
  "messageTemplate": "Deliver this project status notification using the message tool.\n\nProject: {{payload.project}}\nAuthor: {{payload.author}}\nUpdate: {{payload.text}}\n\nSend to channel={{payload.channel}}, accountId={{payload.accountId}}, target={{payload.target}}.\nAfter sending, reply NO_REPLY.",
  "deliver": false,
  "model": "openai-codex/gpt-4.1-mini"
}
```

Note: The agentId/channel/target come from the Pulse hook's bodyTemplate — 
Pulse controls the routing, OpenClaw just executes delivery.

### Why This Works
- Pulse is fully standalone — hooks are just HTTP POSTs to any URL
- OpenClaw is one possible hook target, not a dependency
- Slack, Discord webhooks, PagerDuty, email APIs — all work the same way
- Per-project, per-event-type granularity
- `swarmboard hooks add-openclaw` makes OpenClaw setup a one-liner
- Publishable: anyone can use Pulse without OpenClaw

## Agent Skill

Thin wrapper around `curl` calls to Pulse API. All agents share it.

Key commands:
- `swarmboard create <name> <description>`
- `swarmboard update <project> <status text>`
- `swarmboard list`
- `swarmboard history <project>`

Skill handles notification delivery after posting updates (reads response, calls message tool).

## Web UI

- Project tiles: name, description, members, latest status, timestamp
- Click to expand: full status history
- Edit forms: create/update projects, post manual updates
- Standalone at Pulse server URL
- Embeddable in OpenClaw dashboard via iframe

## Build Order

1. Server + API + SQLite schema
2. Web UI (standalone page)
3. Agent skill (SKILL.md + wrapper script)
4. Notification hooks (Discord first via OpenClaw message tool)
5. Dashboard embed

## Open Questions

- Exact port number
- Auth for the API (API key? or trust local network only?)
- Name: **Swarmboard** ✅ (Adam approved)
- Should web UI manual updates trigger notifications? (deferred)
- Cron polling for un-notified updates? (deferred)

## Status

**Phase:** Design / Planning
**Decision:** Option B hybrid notifications (agent delivers, Pulse decides where)
