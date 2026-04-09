# PAR — Persistent Agent Runtime

**A self-hosted cognitive runtime for AI coding agents — memory, knowledge, coordination, and self-maintenance across any provider.**

Your AI agent has memory now. But it's locked to one provider. Switch from Claude to Gemini and you start from zero. Use two agents on the same project and they can't share what they've learned. And nobody's cleaning up — memories pile up until you hit a wall.

PAR is a self-hosted MCP server that gives any agent — Claude, Gemini, GPT, or local models — a persistent brain that carries across providers, builds its own knowledge graph, coordinates multi-agent workflows, and maintains itself autonomously.

## What You Get

```
┌───────────────────────────────────────────────────────┐
│  Any AI Agent (Claude · Gemini · GPT · Local)          │
└────────────────────────┬──────────────────────────────┘
                         │ MCP Protocol (standard)
┌────────────────────────▼──────────────────────────────┐
│  PAR Runtime (your hardware)                           │
│                                                        │
│  ┌───────────┐ ┌──────────┐ ┌───────────┐ ┌────────┐ │
│  │ Memory    │ │ Projects │ │ Knowledge │ │ Key-   │ │
│  │ (11 tools)│ │ + Tasks  │ │ Graph     │ │ Value  │ │
│  │ semantic  │ │ (6 tools)│ │ (5 tools) │ │ + Snip │ │
│  └───────────┘ └──────────┘ └───────────┘ └────────┘ │
│  ┌───────────┐ ┌──────────┐ ┌───────────┐ ┌────────┐ │
│  │ Agent     │ │ Events + │ │ Skills    │ │ Data-  │ │
│  │ Fleet     │ │ Workflows│ │ Library   │ │ sets   │ │
│  │ (4 tools) │ │ (7 tools)│ │ (4 tools) │ │(4 tool)│ │
│  └───────────┘ └──────────┘ └───────────┘ └────────┘ │
│  ┌───────────┐ ┌──────────┐ ┌───────────────────────┐ │
│  │ File      │ │ System   │ │ Autonomous Maintenance│ │
│  │ Index     │ │ Health   │ │ heartbeat · consolidn │ │
│  │ (3 tools) │ │ (4 tools)│ │ retention · triggers  │ │
│  └───────────┘ └──────────┘ └───────────────────────┘ │
│                                                        │
│  Local Embeddings (all-MiniLM-L6-v2) · Zero API cost  │
│  55 tools · Self-hosted · Zero cloud dependency        │
└────────────────────────────────────────────────────────┘
```

## Built-in History vs. PAR

| | Built-in Memory | PAR |
|---|---|---|
| **Switch providers** | Start from zero — memory locked to one vendor | Everything carries over: Claude → Gemini → GPT → local |
| **Data ownership** | Provider's cloud, provider's rules | Your hardware, your data, forever |
| **Search** | Keyword or recent history | Semantic: "why did we pick SQLite over Postgres?" |
| **Structure** | Flat text blobs | Typed: decisions, insights, handoffs — filterable, taggable, pinnable |
| **Knowledge** | None | Auto-built entity graph with relationships across all memories |
| **Multi-agent** | Each agent is alone | Shared memory, events, coordinated workflows across agents |
| **Self-maintaining** | Memories pile up until you hit limits | Auto-consolidation, retention sweep, 15-min heartbeat |
| **Extensible** | Whatever the vendor ships | 55 tools — add skills, datasets, workflows, event triggers |

## Quick Start

### 1. Clone and Configure

```bash
git clone https://github.com/latentfidelity/par.git
cd par
cp .env.example .env
# Edit .env — set your data directory and optional auth token
```

### 2. Deploy

```bash
docker compose up -d --build
```

### 3. Connect Your Agent

Add to your MCP client config (Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "par": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### 4. Verify

```bash
curl http://localhost:3100/health
# → {"status":"ok","server":"par-mcp","version":"7.0.0",...}
```

## Tools (55)

### Core (2)
| Tool | Description |
|------|-------------|
| `server_status` | Full system status with counts |
| `context_load` | One-shot project init (handoff + project + tasks + memories + KG) |

### Semantic Memory (11)
| Tool | Description |
|------|-------------|
| `memory_store` | Store with semantic embedding (decision, insight, task, handoff, observation) |
| `memory_search` | Search by meaning, not keywords |
| `memory_search_advanced` | Compound filters (AND/OR/NOT, date ranges, tags, pinned) |
| `memory_log` | Chronological retrieval |
| `memory_timeline` | Natural language time queries ("show decisions from last week") |
| `memory_tag` | Add/remove/set tags on memories |
| `memory_pin` | Protect memories from auto-archival |
| `memory_unpin` | Remove pin protection |
| `memory_consolidate` | Cluster and distill similar memories (sleep consolidation) |
| `memory_retain` | Archive old memories with type-based protection |
| `memory_stats` | Dashboard of memory health |

### Knowledge Graph (5)
| Tool | Description |
|------|-------------|
| `knowledge_extract` | Extract entity-relationship triples from text |
| `knowledge_query` | Query entities and traverse relationships |
| `knowledge_context` | Rich context for an entity with all connections |
| `knowledge_merge` | Merge duplicate entities |
| `knowledge_ingest` | Bulk-process memories to build the graph |

### Project Management (6)
| Tool | Description |
|------|-------------|
| `project_register` | Register a project |
| `project_list` | List all projects |
| `project_get` | Get project details + open tasks |
| `task_add` | Add a work item |
| `task_list` | List tasks by project/status |
| `task_update` | Update task fields |

### Agent Fleet (4)
| Tool | Description |
|------|-------------|
| `agent_register` | Register an agent with capabilities and preferences |
| `agent_list` | List all agents with status |
| `agent_get` | Get agent details |
| `agent_update` | Update status, increment stats |

### Events & Workflows (7)
| Tool | Description |
|------|-------------|
| `event_trigger` | Emit events, match subscribers, auto-start workflows |
| `event_subscribe` | Subscribe agents to event patterns |
| `event_log` | Query event history |
| `workflow_register` | Define multi-step workflows with triggers |
| `workflow_run` | Start or advance workflow executions |
| `workflow_status` | Track step-by-step progress |
| `workflow_list` | List registered workflows |

### Knowledge Store (7)
| Tool | Description |
|------|-------------|
| `meta_store` / `meta_retrieve` / `meta_list` | Key-value storage |
| `snippet_save` / `snippet_search` / `snippet_get` / `snippet_update` | Code snippet management |

### Skills (4)
| Tool | Description |
|------|-------------|
| `skill_list` | List all registered skills |
| `skill_get` | Get skill details by ID |
| `skill_create` | Register a new skill |
| `skill_run` | Execute a skill script |

### Datasets (4)
| Tool | Description |
|------|-------------|
| `dataset_register` | Register a dataset with metadata |
| `dataset_list` | List all datasets |
| `dataset_get` | Get dataset details |
| `dataset_search` | Search by tags |

### Infrastructure (5)
| Tool | Description |
|------|-------------|
| `system_health` | One-shot infrastructure audit |
| `system_changelog` | Human-readable activity summary |
| `file_index` | Project file tree with 24h cache |
| `file_store` / `file_read` | Remote file storage |


## Autonomous Maintenance

PAR maintains itself:

- **💓 Heartbeat** — emits `system.heartbeat` every 15 minutes with uptime, memory count, heap usage
- **🌙 Memory Consolidation** — every 6 hours, clusters similar memories and distills them (threshold: 200+ active)
- **🗑️ Retention Sweep** — every 6 hours, archives memories older than 90 days (protects decisions and handoffs)
- **🔔 Event-Driven Workflows** — `deploy.complete` auto-triggers post-deploy QA; `maintenance.requested` triggers memory maintenance
- **POST /trigger** — HTTP endpoint for cron-based automation (no MCP session needed)

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PORT` | `3100` | Gateway port |
| `META_DIR` | `/data/meta` | Persistent storage directory |
| `MCP_AUTH_TOKEN` | _(none)_ | Optional bearer token for authentication |
| `MCP_CORS_ORIGINS` | `localhost:3100` | Comma-separated allowed CORS origins |

### Data Storage

All state persists in `META_DIR` as flat JSON files:

```
/data/meta/
├── memory/        # Semantic memories with embeddings
├── knowledge/     # Entity-relationship graph
├── projects/      # Project registrations
├── tasks/         # Work items
├── kv/            # Key-value pairs
├── snippets/      # Code snippets
├── skills/        # Registered skills
├── datasets/      # Dataset registry
├── agents/        # Agent registrations
├── events/        # Event log
├── workflows/     # Workflow definitions
├── workflow_runs/ # Workflow execution tracking
├── experiments/   # ML experiment logs
├── artifacts/     # Versioned artifacts
└── files/         # General file storage
```

### Backups

Use the included backup script:

```bash
# Manual backup
./backup.sh

# Automated daily (add to crontab)
0 3 * * * /path/to/par/backup.sh >> /path/to/par/backups/cron.log 2>&1
```

## How Memory Works

1. **Store**: When you store a memory, PAR generates a 384-dimensional embedding using `all-MiniLM-L6-v2` running locally on CPU
2. **Search**: Queries are embedded and compared via cosine similarity against all stored memories
3. **Consolidate**: Similar memories are automatically clustered and distilled into summaries (like sleep consolidation)
4. **Knowledge Graph**: Entities and relationships are auto-extracted from memories, building a queryable graph
5. **Zero cost**: The embedding model runs locally — no API calls, no cloud dependency

## Limitations

PAR treats memories as **orientation, not gospel**. The agent should always verify stored context against the live codebase before acting on it.

Current gaps:

- **No staleness detection** — if a remembered file gets deleted or refactored, PAR won't flag the drift
- **No memory versioning** — you can't see how a decision evolved over time
- **No conflict resolution** — when two memories contradict, the agent must resolve it manually
- **In-memory index** — the embedding index rebuilds on restart; works fine at thousands of memories, unclear at millions
- **Single node** — no clustering or replication; designed for a single self-hosted machine

## Roadmap

### Shipped
- [x] **Discord adapters** — agent fleet connects to team chat via bot framework
- [x] **Dataset registry** — register, search, and manage training datasets (4 tools)
- [x] **Experiment tracking** — log ML experiments with built-in experiment-runner skill
- [x] **Snippet versioning** — store, search, and update reusable code/prompt templates (4 tools)

### Next
- [ ] **Staleness detection** — flag memories that reference files changed since the memory was stored
- [ ] **Conflict detection** — surface contradictory memories before the agent acts on stale context
- [ ] **Memory versioning** — track how decisions evolve across conversations
- [ ] **Pluggable embeddings** — swap `all-MiniLM-L6-v2` for larger models when hardware allows

### Later
- [ ] **Multi-node** — replicate state across machines for teams
- [ ] **Persistent vector index** — avoid full index rebuild on restart for large memory stores
- [ ] **Webhook integrations** — push event notifications to external services (Slack, HTTP endpoints)

### Non-goals
- Cloud hosting — PAR is self-hosted by design
- GUI dashboard — agents are the interface
- Framework lock-in — PAR uses standard MCP, not a custom SDK

## License

MIT
