import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { embed, cosineSimilarity, isSemanticReady, EMBEDDING_DIM } from "./lib/embedder.js";
import { execFileSync, execSync } from "node:child_process";
import type { ToolResult } from "./types.js";
import {
  META_DIR, DIRS,
  safePath, safeId,
  readJSON, writeJSON, listJSON,
  textResult, errorResult, errorMessage,
} from "./lib/storage.js";

const PORT = parseInt(process.env.MCP_PORT || "3100");
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

// ── Tool call telemetry (in-memory, resets on restart) ───────
const _toolCalls = new Map<string, number>(); // tool_name → count
const _bootTime = Date.now();
function trackCall(name: string) { _toolCalls.set(name, (_toolCalls.get(name) || 0) + 1); }

// ── In-memory vector index (shared across MCP sessions, invalidated by schedulers) ──
import type { MemoryEntry } from "./tools/context.js";
let memoryIndex: MemoryEntry[] | null = null;

import { extractKG } from "./lib/knowledge.js";

// ══════════════════════════════════════════════════════════════
//  MCP SERVER FACTORY
// ══════════════════════════════════════════════════════════════

import { registerCoreTools } from "./tools/core.js";
import { registerRegistryTools } from "./tools/registry.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerEventTools } from "./tools/events.js";
import { registerSystemTools } from "./tools/system.js";

function createMcpServer() {
  const _server = new McpServer({
    name: "par",
    version: "7.0.0",
  });

  // Instrument all tools with call tracking
  const _origTool = _server.tool.bind(_server);
  const server = new Proxy(_server, {
    get(target, prop) {
      if (prop === "tool") return (...args: any[]) => {
        const name = args[0] as string;
        const handler = args[args.length - 1] as (...a: any[]) => any;
        args[args.length - 1] = async (...hArgs: any[]) => {
          trackCall(name);
          return handler(...hArgs);
        };
        return (_origTool as any)(...args);
      };
      const val = (target as any)[prop];
      return typeof val === "function" ? val.bind(target) : val;
    }
  });

  // Memory index accessors (shared across tool modules)
  const getIndex = () => memoryIndex;
  const setIndex = (idx: MemoryEntry[] | null) => { memoryIndex = idx; };

  // Register all tool groups
  registerCoreTools(server);
  registerRegistryTools(server);
  registerMemoryTools(server, getIndex, setIndex);
  registerKnowledgeTools(server);
  registerAgentTools(server, getIndex, setIndex);
  registerEventTools(server);
  registerSystemTools(server, getIndex, setIndex);

  return server;
}


import { seedDefaults } from "./seed-defaults.js";


// ══════════════════════════════════════════════════════════════
//  EXPRESS + TRANSPORT SETUP
// ══════════════════════════════════════════════════════════════
const app = express();

// ── Security: CORS (restrict origins) ─────────────────────────
const CORS_ORIGINS = process.env.MCP_CORS_ORIGINS
  ? process.env.MCP_CORS_ORIGINS.split(",").map((s: any) => s.trim())
  : ["http://localhost:3100", "http://localhost:3100"];
app.use(cors({ origin: CORS_ORIGINS }));

// ── Security: Bearer token auth ───────────────────────────────
if (AUTH_TOKEN) {
  app.use((req, res, next) => {
    // Skip auth for health endpoint (Docker healthcheck)
    if (req.path === "/health" || req.path === "/trigger") return next();
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });
  console.log("🔒 Bearer token auth enabled");
} else {
  console.warn("⚠️  No MCP_AUTH_TOKEN set — running WITHOUT authentication!");
}

// Health endpoint (non-MCP, for Docker healthcheck)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "par-mcp",
    version: "7.0.0",
    timestamp: new Date().toISOString(),
    uptime_s: Math.round((Date.now() - _bootTime) / 1000),
    tool_calls_total: [..._toolCalls.values()].reduce((a, b) => a + b, 0),
  });
});

// Tool usage telemetry endpoint
app.get("/stats", (req, res) => {
  const sorted = [..._toolCalls.entries()].sort((a: any, b: any) => b[1] - a[1]);
  res.json({
    uptime_s: Math.round((Date.now() - _bootTime) / 1000),
    total_calls: sorted.reduce((a, [, c]) => a + c, 0),
    unique_tools_called: sorted.length,
    calls: Object.fromEntries(sorted),
  });
});

// ── Serve docs/ as static files (dashboard, architecture, KG explorer) ──
const docsDir = fs.existsSync("/app/docs") ? "/app/docs" : path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "docs");
if (fs.existsSync(docsDir)) {
  app.use("/docs", express.static(docsDir));
  console.log(`📄 Docs served at /docs/ from ${docsDir}`);
}

// ── REST API: Dataset search (direct HTTP, no MCP session needed) ──
app.get("/api/search", (req, res) => {
  const indexPath = "/opt/datasets/index.json";
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch (e) {
    return res.status(500).json({ error: "Index not built" });
  }

  const tags = ((req.query.tags as string) || "").split(",").map((t: any) => t.trim().toLowerCase()).filter(Boolean);
  const maxDim = parseInt(req.query.max_size as string) || 512;
  const minDim = parseInt(req.query.min_size as string) || 16;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  if (!tags.length) {
    return res.json({ count: 0, results: [], error: "No tags provided" });
  }

  let results = index.filter((entry: any) => {
    const entryTags = (entry.tags || []).map((t: any) => t.toLowerCase());
    if (!tags.every(st => entryTags.includes(st))) return false;
    const dim = Math.max(entry.width || 0, entry.height || 0);
    return dim >= minDim && dim <= maxDim;
  });

  results.sort((a: any, b: any) => {
    const aScore = (a.tags || []).length;
    const bScore = (b.tags || []).length;
    if (bScore !== aScore) return bScore - aScore;
    return (a.colors || 999) - (b.colors || 999);
  });

  results = results.slice(0, limit);
  res.json({ count: results.length, total_indexed: index.length, results });
});

// ── REST API: Event Trigger (HTTP, for cron/external automation) ──
// Enables autonomous loops: cron can fire events without needing an MCP session.
// Usage: curl -X POST http://localhost:3100/trigger \
//          -H "Content-Type: application/json" \
//          -d '{"type":"maintenance.daily","source":"cron"}'
app.post("/trigger", express.json(), (req, res) => {
  const { type, source, project, payload, severity } = req.body || {};
  if (!type) return res.status(400).json({ error: "Missing required field: type" });

  const eventId = randomUUID().slice(0, 8);
  const event = {
    id: eventId,
    type,
    source: source || "http_trigger",
    project: project || null,
    payload: payload || {},
    severity: severity || "info",
    timestamp: new Date().toISOString(),
    consumed_by: [],
  };
  writeJSON(path.join(META_DIR, "events", `${eventId}.json`), event);

  // Match subscribers
  const kvDir = path.join(META_DIR, "kv");
  const subs = listJSON(kvDir).filter(kv => kv.key?.startsWith("event_sub__"));
  const subscribers = [];
  for (const sub of subs) {
    try {
      const cfg = JSON.parse(sub.value);
      if (cfg.type_pattern && type.startsWith(cfg.type_pattern.replace("*", ""))) {
        subscribers.push({ subscriber: cfg.subscriber, action: cfg.action });
      }
    } catch {}
  }

  // Match workflows
  const workflows = listJSON(path.join(META_DIR, "workflows"));
  const triggered = [];
  for (const wf of workflows) {
    const triggerMatch = wf.trigger?.event_type === type ||
      (wf.trigger && typeof wf.trigger === "string" && type.startsWith(wf.trigger.replace("*", "")));
    if (triggerMatch) {
      const runId = randomUUID().slice(0, 8);
      const run = {
        id: runId, workflow_id: wf.id, workflow_name: wf.name,
        triggered_by: eventId, event_type: type, project,
        steps: wf.steps.map((s: any) => ({ ...s, status: "pending" })),
        status: "triggered", started_at: new Date().toISOString(),
      };
      const runDir = path.join(META_DIR, "workflow_runs");
      if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
      writeJSON(path.join(runDir, `${runId}.json`), run);
      triggered.push({ workflow: wf.id, name: wf.name, run_id: runId });
    }
  }

  res.json({
    event: { id: eventId, type, source: event.source, severity: event.severity, project },
    subscribers: subscribers.length ? subscribers : undefined,
    workflows_triggered: triggered.length,
    workflows: triggered.length ? triggered : undefined,
  });
});

// ── Streamable HTTP Transport (MCP spec 2025-03-26) ──────────
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", express.json(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && streamableTransports[sessionId]) {
    const transport = streamableTransports[sessionId];
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });
    streamableTransports[newSessionId] = transport;
    transport.onclose = () => {
      console.log(`[session] Closed: ${newSessionId.slice(0, 8)}`);
      delete streamableTransports[newSessionId];
    };
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    console.log(`[session] New: ${newSessionId.slice(0, 8)} (active: ${Object.keys(streamableTransports).length})`);
    return;
  }

  console.warn(`[session] Rejected stale session: ${(sessionId || "none").slice(0, 8)} (active: ${Object.keys(streamableTransports).length})`);
  res.status(400).json({ error: "Invalid session or missing initialization" });
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && streamableTransports[sessionId]) {
    await streamableTransports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "Invalid or missing session ID" });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && streamableTransports[sessionId]) {
    await streamableTransports[sessionId].handleRequest(req, res);
    delete streamableTransports[sessionId];
    return;
  }
  res.status(400).json({ error: "Invalid or missing session ID" });
});

// ── Legacy SSE Transport (backward compat) ───────────────────
const sseTransports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", () => {
    delete sseTransports[transport.sessionId];
  });
  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const transport = sessionId ? sseTransports[sessionId] : undefined;
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

import { startSchedulers, seedWorkflows } from "./schedulers.js";

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🧠 PAR MCP Gateway v7.0.0 on port ${PORT}`);
  console.log(`   Streamable HTTP: http://0.0.0.0:${PORT}/mcp`);
  console.log(`   Legacy SSE:      http://0.0.0.0:${PORT}/sse`);
  console.log(`   Health:          http://0.0.0.0:${PORT}/health`);
  console.log(`   Event Trigger:   http://0.0.0.0:${PORT}/trigger (POST)`);
  console.log(`   Meta storage:    ${META_DIR}`);
  console.log(`   Security:        safePath ✓ | safeId ✓ | execFileSync ✓ | readJSON/writeJSON guards ✓`);
  console.log(`\n📦 Seeding defaults...`);
  seedDefaults();
  seedWorkflows();
  console.log(`✅ Ready`);

  // Pre-warm embedding model (async, non-blocking)
  embed("warmup").then(() => {
    console.log(`🧠 Embedding model: ${isSemanticReady() ? "all-MiniLM-L6-v2 ✓" : "keyword fallback"}`);
    const memCount = fs.readdirSync(path.join(META_DIR, "memory")).filter(f => f.endsWith(".json")).length;
    const kgCount = fs.existsSync(path.join(META_DIR, "knowledge")) ? fs.readdirSync(path.join(META_DIR, "knowledge")).filter(f => f.startsWith("entity__")).length : 0;
    console.log(`📊 Memories: ${memCount} | KG Entities: ${kgCount}`);
  }).catch(() => {});

  // Start background schedulers
  startSchedulers(
    () => { memoryIndex = null; },
    { toolCalls: _toolCalls, bootTime: _bootTime },
  );
});


