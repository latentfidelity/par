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
import { embed, cosineSimilarity, isSemanticReady, EMBEDDING_DIM } from "./embedder.js";
import { execFileSync, execSync } from "node:child_process";

const PORT = parseInt(process.env.MCP_PORT || "3100");
const META_DIR = process.env.META_DIR || "/data/meta";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

// ── Security: path traversal guard ────────────────────────────
function safePath(base, userPath) {
  const resolved = path.resolve(base, userPath);
  const baseResolved = path.resolve(base);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new Error(`Path traversal blocked: ${userPath}`);
  }
  return resolved;
}

// ── Security: ID sanitization (defense-in-depth) ──────────────
function safeId(id) {
  // Strip path separators, null bytes, and directory traversal
  return id.replace(/[\/\\:\0]/g, "_").replace(/\.\./g, "_");
}

// ── Ensure directories ───────────────────────────────────────
const DIRS = ["kv", "files", "projects", "tasks", "snippets", "skills", "datasets", "memory", "artifacts", "agents", "events", "workflows", "procedures", "knowledge"];
for (const dir of DIRS) {
  fs.mkdirSync(path.join(META_DIR, dir), { recursive: true });
}

// ── Helpers ──────────────────────────────────────────────────
function readJSON(filePath) {
  // Defense-in-depth: reject any path that escapes META_DIR
  const resolved = path.resolve(filePath);
  const metaResolved = path.resolve(META_DIR);
  if (!resolved.startsWith(metaResolved + path.sep) && resolved !== metaResolved) {
    console.error(`[SECURITY] readJSON blocked: ${filePath}`);
    return null;
  }
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJSON(filePath, data) {
  // Defense-in-depth: reject any path that escapes META_DIR
  const resolved = path.resolve(filePath);
  const metaResolved = path.resolve(META_DIR);
  if (!resolved.startsWith(metaResolved + path.sep) && resolved !== metaResolved) {
    throw new Error(`[SECURITY] writeJSON blocked: ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  // Invalidate listJSON cache for the parent directory
  const parentDir = path.dirname(filePath);
  _dirCache.delete(parentDir);
}

// ── Directory cache (TTL-based, invalidated on write) ────────
const _dirCache = new Map(); // key: dirPath → { data, ts }
const DIR_CACHE_TTL_MS = 10_000; // 10 seconds

function listJSON(dir) {
  if (!fs.existsSync(dir)) return [];
  const cached = _dirCache.get(dir);
  if (cached && (Date.now() - cached.ts) < DIR_CACHE_TTL_MS) {
    return cached.data;
  }
  const result = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON(path.join(dir, f)))
    .filter(Boolean);
  _dirCache.set(dir, { data: result, ts: Date.now() });
  return result;
}

function textResult(text) {
  return {
    content: [
      { type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) },
    ],
  };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// ── Tool call telemetry (in-memory, resets on restart) ───────
const _toolCalls = new Map(); // tool_name → count
const _bootTime = Date.now();
function trackCall(name) { _toolCalls.set(name, (_toolCalls.get(name) || 0) + 1); }

/**
 * Extract entities and relationships from text, persisting to the KG.
 * Reusable helper for both knowledge_extract tool and auto-consolidation.
 */
function extractKG(text, project, sourceId) {
  const entities = new Map();
  const relationships = [];

  // Extract project references
  const allProjects = listJSON(path.join(META_DIR, "projects"));
  for (const proj of allProjects) {
    if (text.toLowerCase().includes(proj.id.toLowerCase()) || text.toLowerCase().includes(proj.name.toLowerCase())) {
      entities.set(proj.id, { id: proj.id, name: proj.name, type: "project" });
    }
  }

  // Extract tool references
  const toolPattern = /\b(memory_\w+|artifact_\w+|context_\w+|project_\w+|task_\w+|snippet_\w+|skill_\w+|dataset_\w+|event_\w+|workflow_\w+|agent_\w+|file_\w+|meta_\w+|procedure_\w+|knowledge_\w+|system_health|experiment_log|ping|server_status)\b/g;
  let match;
  while ((match = toolPattern.exec(text)) !== null) {
    entities.set(match[1], { id: match[1], name: match[1], type: "tool" });
  }

  // Extract technology references
  const techTerms = ["docker", "node", "javascript", "python", "d3", "mcp", "discord", "gemini", "claude", "pillow", "numpy", "react", "vite", "tailwind", "minilm", "onnx", "express", "css", "html"];
  for (const tech of techTerms) {
    if (text.toLowerCase().includes(tech)) {
      entities.set(tech, { id: tech, name: tech, type: "technology" });
    }
  }

  // Extract version references
  const versionPattern = /v(\d+\.\d+(?:\.\d+)?)/g;
  while ((match = versionPattern.exec(text)) !== null) {
    entities.set(`v${match[1]}`, { id: `v${match[1]}`, name: `Version ${match[1]}`, type: "concept" });
  }

  // Build relationships between co-occurring entities
  const entityList = [...entities.values()];
  for (let i = 0; i < entityList.length; i++) {
    for (let j = i + 1; j < entityList.length; j++) {
      const e1 = entityList[i], e2 = entityList[j];
      let relType = "related_to";
      if (e1.type === "tool" && e2.type === "project") relType = "used_by";
      else if (e1.type === "project" && e2.type === "tool") relType = "uses";
      else if (e1.type === "project" && e2.type === "technology") relType = "uses";
      else if (e1.type === "technology" && e2.type === "project") relType = "used_by";
      relationships.push({ from: e1.id, to: e2.id, type: relType, source: sourceId || null });
    }
  }

  // Persist entities
  const kgDir = path.join(META_DIR, "knowledge");
  for (const entity of entityList) {
    const entityPath = path.join(kgDir, `entity__${entity.id.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
    const existing = readJSON(entityPath);
    if (existing) {
      existing.mentions = (existing.mentions || 0) + 1;
      existing.last_seen = new Date().toISOString();
      if (sourceId && !existing.sources?.includes(sourceId)) {
        existing.sources = [...(existing.sources || []), sourceId];
      }
      writeJSON(entityPath, existing);
    } else {
      writeJSON(entityPath, {
        ...entity, mentions: 1, sources: sourceId ? [sourceId] : [],
        project: project || null, created: new Date().toISOString(), last_seen: new Date().toISOString(),
      });
    }
  }

  // Persist relationships
  for (const rel of relationships) {
    const relId = `${rel.from}__${rel.type}__${rel.to}`.replace(/[^a-zA-Z0-9_]/g, "_");
    const relPath = path.join(kgDir, `rel__${relId}.json`);
    const existing = readJSON(relPath);
    if (existing) {
      existing.weight = (existing.weight || 1) + 1;
      existing.last_seen = new Date().toISOString();
      writeJSON(relPath, existing);
    } else {
      writeJSON(relPath, { id: relId, ...rel, weight: 1, created: new Date().toISOString(), last_seen: new Date().toISOString() });
    }
  }

  return { entities: entityList, relationships };
}

// ══════════════════════════════════════════════════════════════
//  MCP SERVER FACTORY
// ══════════════════════════════════════════════════════════════
function createMcpServer() {
  const _server = new McpServer({
    name: "par",
    version: "7.0.0",
  });

  // Instrument all tools with call tracking
  const _origTool = _server.tool.bind(_server);
  const server = new Proxy(_server, {
    get(target, prop) {
      if (prop === "tool") return (...args) => {
        const name = args[0];
        const handler = args[args.length - 1];
        args[args.length - 1] = async (...hArgs) => {
          trackCall(name);
          return handler(...hArgs);
        };
        return _origTool(...args);
      };
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    }
  });

  // ┌─────────────────────────────────────────────────────────┐
  // │  CORE TOOLS                                             │
  // └─────────────────────────────────────────────────────────┘

  // NOTE: ping removed in v6.6 — server_status is a strict superset.
  // Docker healthcheck uses /health HTTP endpoint instead.

  server.tool("server_status", "Get PAR system status and capabilities", {}, async () => {
    const projectCount = listJSON(path.join(META_DIR, "projects")).length;
    const taskCount = listJSON(path.join(META_DIR, "tasks")).length;
    const skillCount = listJSON(path.join(META_DIR, "skills")).length;
    const snippetCount = listJSON(path.join(META_DIR, "snippets")).length;
    const datasetCount = listJSON(path.join(META_DIR, "datasets")).length;
    const artifactCount = listJSON(path.join(META_DIR, "artifacts")).length;
    const agentCount = listJSON(path.join(META_DIR, "agents")).length;
    const eventCount = listJSON(path.join(META_DIR, "events")).length;
    const workflowCount = listJSON(path.join(META_DIR, "workflows")).length;
    const procedureCount = listJSON(path.join(META_DIR, "procedures")).length;
    const kgEntityCount = fs.existsSync(path.join(META_DIR, "knowledge")) ? fs.readdirSync(path.join(META_DIR, "knowledge")).filter(f => f.startsWith("entity__")).length : 0;
    const kgRelCount = fs.existsSync(path.join(META_DIR, "knowledge")) ? fs.readdirSync(path.join(META_DIR, "knowledge")).filter(f => f.startsWith("rel__")).length : 0;
    return textResult({
      hostname: "par",
      version: "7.0.0",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      counts: {
        projects: projectCount,
        tasks: taskCount,
        skills: skillCount,
        snippets: snippetCount,
        datasets: datasetCount,
        artifacts: artifactCount,
        agents: agentCount,
        events: eventCount,
        workflows: workflowCount,
        procedures: procedureCount,
        kg_entities: kgEntityCount,
        kg_relationships: kgRelCount,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ┌─────────────────────────────────────────────────────────┐
  // │  META KV STORE                                          │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "meta_store",
    "Store a key-value pair in persistent meta storage",
    {
      key: z.string().describe("Storage key (supports nested paths like 'project/config')"),
      value: z.string().describe("Value to store (JSON string for structured data)"),
    },
    async ({ key, value }) => {
      const filePath = path.join(META_DIR, "kv", `${key.replace(/\//g, "__")}.json`);
      writeJSON(filePath, { key, value, updated: new Date().toISOString() });
      return textResult(`Stored: ${key}`);
    },
  );

  server.tool(
    "meta_retrieve",
    "Retrieve a value from persistent meta storage",
    {
      key: z.string().describe("Storage key to retrieve"),
    },
    async ({ key }) => {
      const filePath = path.join(META_DIR, "kv", `${key.replace(/\//g, "__")}.json`);
      const entry = readJSON(filePath);
      if (!entry) return errorResult(`Key not found: ${key}`);
      return textResult(entry.value);
    },
  );

  server.tool("meta_list", "List all keys in meta storage", {}, async () => {
    const entries = listJSON(path.join(META_DIR, "kv"));
    const keys = entries.map((e) => ({ key: e.key, updated: e.updated }));
    return textResult(keys.length ? keys : "No keys stored yet.");
  });

  // ┌─────────────────────────────────────────────────────────┐
  // │  FILE STORE                                             │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "file_store",
    "Store a file in persistent storage",
    {
      filepath: z
        .string()
        .describe("Relative path within meta storage (e.g. 'projects/myfile.txt')"),
      content: z.string().describe("File content to write"),
    },
    async ({ filepath, content }) => {
      const fullPath = safePath(path.join(META_DIR, "files"), filepath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      return textResult(`File stored: ${filepath} (${content.length} bytes)`);
    },
  );

  server.tool(
    "file_read",
    "Read a file from persistent storage",
    {
      filepath: z.string().describe("Relative path within meta storage"),
    },
    async ({ filepath }) => {
      const fullPath = safePath(path.join(META_DIR, "files"), filepath);
      if (!fs.existsSync(fullPath)) return errorResult(`File not found: ${filepath}`);
      const content = fs.readFileSync(fullPath, "utf-8");
      return textResult(content);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  PROJECT REGISTRY                                       │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "project_register",
    "Register a project in the persistent project registry",
    {
      id: z.string().describe("Unique project identifier (e.g. 'my-project', 'web-app')"),
      name: z.string().describe("Human-readable project name"),
      path: z.string().describe("Local filesystem path to the project"),
      description: z.string().optional().describe("Brief project description"),
      stack: z
        .string()
        .optional()
        .describe("Comma-separated tech stack (e.g. 'python,pillow,numpy')"),
      status: z
        .enum(["active", "paused", "archived", "ideation"])
        .optional()
        .describe("Project status"),
      repo: z.string().optional().describe("Git repository URL"),
    },
    async ({ id, name, path: projPath, description, stack, status, repo }) => {
      const filePath = path.join(META_DIR, "projects", `${id}.json`);
      const existing = readJSON(filePath);
      const project = {
        id,
        name,
        path: projPath,
        description: description || "",
        stack: stack ? stack.split(",").map((s) => s.trim()) : [],
        status: status || "active",
        repo: repo || "",
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(filePath, project);
      return textResult(`Project registered: ${name} (${id})`);
    },
  );

  server.tool(
    "project_list",
    "List all registered projects",
    {
      status: z
        .enum(["active", "paused", "archived", "ideation", "all"])
        .optional()
        .describe("Filter by status"),
    },
    async ({ status }) => {
      let projects = listJSON(path.join(META_DIR, "projects"));
      if (status && status !== "all") {
        projects = projects.filter((p) => p.status === status);
      }
      if (!projects.length) return textResult("No projects registered yet.");
      return textResult(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          stack: p.stack,
          path: p.path,
        })),
      );
    },
  );

  server.tool(
    "project_get",
    "Get full details of a registered project",
    {
      id: z.string().describe("Project identifier"),
    },
    async ({ id }) => {
      const project = readJSON(path.join(META_DIR, "projects", `${id}.json`));
      if (!project) return errorResult(`Project not found: ${id}`);
      // Include open tasks count
      const tasks = listJSON(path.join(META_DIR, "tasks")).filter(
        (t) => t.project === id && t.status !== "done",
      );
      project.openTasks = tasks.length;
      return textResult(project);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  TASK QUEUE                                             │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "task_add",
    "Add a task to the persistent task queue",
    {
      project: z.string().describe("Project identifier this task belongs to"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Detailed task description"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Task priority"),
    },
    async ({ project, title, description, priority }) => {
      const id = randomUUID().slice(0, 8);
      const task = {
        id,
        project,
        title,
        description: description || "",
        priority: priority || "medium",
        status: "todo",
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(path.join(META_DIR, "tasks", `${id}.json`), task);
      return textResult(`Task added: [${id}] ${title} (${project})`);
    },
  );

  server.tool(
    "task_list",
    "List tasks from the persistent task queue",
    {
      project: z.string().optional().describe("Filter by project identifier"),
      status: z
        .enum(["todo", "in-progress", "done", "blocked", "all"])
        .optional()
        .describe("Filter by status"),
    },
    async ({ project, status }) => {
      let tasks = listJSON(path.join(META_DIR, "tasks"));
      if (project) tasks = tasks.filter((t) => t.project === project);
      if (status && status !== "all") tasks = tasks.filter((t) => t.status === status);
      tasks.sort((a, b) => {
        const prio = { critical: 0, high: 1, medium: 2, low: 3 };
        return (prio[a.priority] || 2) - (prio[b.priority] || 2);
      });
      if (!tasks.length) return textResult("No tasks found.");
      return textResult(
        tasks.map((t) => ({
          id: t.id,
          project: t.project,
          title: t.title,
          priority: t.priority,
          status: t.status,
        })),
      );
    },
  );

  server.tool(
    "task_update",
    "Update a task's status, priority, or details",
    {
      id: z.string().describe("Task ID"),
      status: z.enum(["todo", "in-progress", "done", "blocked"]).optional().describe("New status"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority"),
      title: z.string().optional().describe("Updated title"),
      description: z.string().optional().describe("Updated description"),
    },
    async ({ id, status, priority, title, description }) => {
      const filePath = path.join(META_DIR, "tasks", `${id}.json`);
      const task = readJSON(filePath);
      if (!task) return errorResult(`Task not found: ${id}`);
      if (status) task.status = status;
      if (priority) task.priority = priority;
      if (title) task.title = title;
      if (description) task.description = description;
      task.updated = new Date().toISOString();
      writeJSON(filePath, task);
      return textResult(`Task updated: [${id}] ${task.title} → ${task.status}`);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SNIPPET STORE                                          │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "snippet_save",
    "Save a reusable code snippet or pattern",
    {
      title: z.string().describe("Snippet title (e.g. 'Docker healthcheck pattern')"),
      content: z.string().describe("The snippet content"),
      language: z.string().optional().describe("Language (e.g. 'bash', 'yaml', 'javascript')"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags (e.g. 'docker,healthcheck,devops')"),
    },
    async ({ title, content, language, tags }) => {
      const id = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+$/, "");
      const snippet = {
        id,
        title,
        content,
        language: language || "text",
        tags: tags ? tags.split(",").map((t) => t.trim()) : [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(path.join(META_DIR, "snippets", `${id}.json`), snippet);
      return textResult(`Snippet saved: ${title} [${id}]`);
    },
  );

  server.tool(
    "snippet_search",
    "Search saved snippets by keyword or tag",
    {
      query: z.string().describe("Search query (matches title, tags, and content)"),
    },
    async ({ query }) => {
      const snippets = listJSON(path.join(META_DIR, "snippets"));
      const q = query.toLowerCase();
      const matches = snippets.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.content.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q)),
      );
      if (!matches.length) return textResult(`No snippets matched: "${query}"`);
      return textResult(
        matches.map((s) => ({
          id: s.id,
          title: s.title,
          language: s.language,
          tags: s.tags,
          preview: s.content.slice(0, 120) + (s.content.length > 120 ? "..." : ""),
        })),
      );
    },
  );

  server.tool(
    "snippet_get",
    "Get full content of a saved snippet",
    {
      id: z.string().describe("Snippet identifier"),
    },
    async ({ id }) => {
      const snippet = readJSON(path.join(META_DIR, "snippets", `${id}.json`));
      if (!snippet) return errorResult(`Snippet not found: ${id}`);
      return textResult(snippet);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SKILL SYSTEM                                           │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "skill_list",
    "List all available agent skills",
    {
      tag: z.string().optional().describe("Filter by tag"),
      type: z
        .enum(["knowledge", "execution", "hybrid", "all"])
        .optional()
        .describe("Filter by skill type"),
    },
    async ({ tag, type }) => {
      let skills = listJSON(path.join(META_DIR, "skills"));
      if (tag) skills = skills.filter((s) => s.tags?.some((t) => t.includes(tag)));
      if (type && type !== "all") skills = skills.filter((s) => s.type === type);
      if (!skills.length) return textResult("No skills found.");
      return textResult(
        skills.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          tags: s.tags,
          description: s.description,
        })),
      );
    },
  );

  server.tool(
    "skill_get",
    "Get full skill definition including instructions",
    {
      id: z.string().describe("Skill identifier"),
    },
    async ({ id }) => {
      const skill = readJSON(path.join(META_DIR, "skills", `${id}.json`));
      if (!skill) return errorResult(`Skill not found: ${id}`);
      return textResult(skill);
    },
  );

  server.tool(
    "skill_create",
    "Create or update an agent skill",
    {
      id: z.string().describe("Unique skill identifier (e.g. 'deploy-docker')"),
      name: z.string().describe("Human-readable skill name"),
      description: z.string().describe("What the skill does"),
      type: z
        .enum(["knowledge", "execution", "hybrid"])
        .describe(
          "Skill type: knowledge (instructions only), execution (runs on server), hybrid (both)",
        ),
      tags: z.string().optional().describe("Comma-separated tags"),
      instructions: z.string().describe("Step-by-step instructions in markdown"),
      script: z
        .string()
        .optional()
        .describe("Shell script to execute (for execution/hybrid types)"),
    },
    async ({ id, name, description, type, tags, instructions, script }) => {
      const filePath = path.join(META_DIR, "skills", `${id}.json`);
      const existing = readJSON(filePath);
      const skill = {
        id,
        name,
        description,
        type,
        tags: tags ? tags.split(",").map((t) => t.trim()) : [],
        instructions,
        script: script || null,
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(filePath, skill);
      return textResult(`Skill ${existing ? "updated" : "created"}: ${name} [${id}]`);
    },
  );

  server.tool(
    "skill_run",
    "Execute a skill's script on the server",
    {
      id: z.string().describe("Skill identifier to execute"),
      args: z.string().optional().describe("Arguments to pass to the script"),
    },
    async ({ id, args }) => {
      const skill = readJSON(path.join(META_DIR, "skills", `${id}.json`));
      if (!skill) return errorResult(`Skill not found: ${id}`);
      if (!skill.script)
        return errorResult(`Skill "${id}" has no executable script. Type: ${skill.type}`);
      if (skill.type === "knowledge")
        return errorResult(`Skill "${id}" is knowledge-only. Read its instructions instead.`);

      try {
        // Write script to temp file and execute (using execFileSync to prevent shell injection)
        const scriptPath = path.join(META_DIR, "skills", `_run_${id}.sh`);
        fs.writeFileSync(scriptPath, skill.script, { mode: 0o755 });
        const execArgs = [scriptPath, ...(args ? args.split(/\s+/).filter(Boolean) : [])];
        const output = execFileSync("bash", execArgs, {
          timeout: 30000,
          cwd: META_DIR,
          env: { ...process.env, META_DIR, SKILL_ID: id },
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
        // Clean up temp script
        fs.unlinkSync(scriptPath);
        return textResult({ executed: id, output: output.trim() });
      } catch (err) {
        return errorResult(`Skill execution failed: ${err.message}\n${err.stderr || ""}`);
      }
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  DATASET REGISTRY                                       │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "dataset_register",
    "Register or update a dataset in the global registry",
    {
      id: z.string().describe("Unique dataset identifier (e.g. 'lpc-universal', 'kenney-platformer')"),
      name: z.string().describe("Human-readable dataset name"),
      domain: z.string().describe("Domain category (e.g. 'sprites', 'audio', 'text', 'images', 'video', '3d')"),
      format: z.string().describe("Data format (e.g. 'png-spritesheet', 'wav', 'jsonl', 'parquet')"),
      source: z.string().describe("Source URL or repository"),
      license: z.string().describe("License identifier (e.g. 'CC0', 'CC-BY-SA-3.0', 'MIT', 'GPL-3.0')"),
      description: z.string().optional().describe("What this dataset contains and how it's structured"),
      project: z.string().optional().describe("Project that uses this dataset (e.g. 'my-project')"),
      local_path: z.string().optional().describe("Absolute path on local filesystem"),
      size: z.string().optional().describe("Approximate size (e.g. '1.2GB', '86MB')"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'pixel-art,modular,top-down')"),
      status: z.string().optional().describe("Ingestion status: available, downloaded, processed, archived"),
    },
    async ({ id, name, domain, format, source, license, description, project, local_path, size, tags, status }) => {
      const filePath = path.join(META_DIR, "datasets", `${id}.json`);
      const existing = readJSON(filePath);
      const dataset = {
        id, name, domain, format, source, license,
        description: description || existing?.description || null,
        project: project || existing?.project || null,
        local_path: local_path || existing?.local_path || null,
        size: size || existing?.size || null,
        tags: tags ? tags.split(",").map(t => t.trim()) : existing?.tags || [],
        status: status || existing?.status || "available",
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(filePath, dataset);
      return textResult(`Dataset ${existing ? "updated" : "registered"}: ${name} (${id})`);
    },
  );

  server.tool(
    "dataset_list",
    "List registered datasets, optionally filtered by domain, project, or status",
    {
      domain: z.string().optional().describe("Filter by domain (e.g. 'sprites', 'audio')"),
      project: z.string().optional().describe("Filter by project (e.g. 'my-project')"),
      status: z.string().optional().describe("Filter by status (available/downloaded/processed/archived/all)"),
    },
    async ({ domain, project, status }) => {
      let datasets = listJSON(path.join(META_DIR, "datasets"));
      if (domain) datasets = datasets.filter(d => d.domain === domain);
      if (project) datasets = datasets.filter(d => d.project === project);
      if (status && status !== "all") datasets = datasets.filter(d => d.status === status);
      if (datasets.length === 0) return textResult("No datasets found matching filters.");
      const summary = datasets.map(d =>
        `[${d.id}] ${d.name} | ${d.domain}/${d.format} | ${d.size || '?'} | ${d.status} | ${d.license}`
      ).join("\n");
      return textResult(`${datasets.length} dataset(s):\n${summary}`);
    },
  );

  server.tool(
    "dataset_get",
    "Get full details of a specific dataset",
    {
      id: z.string().describe("Dataset identifier"),
    },
    async ({ id }) => {
      const dataset = readJSON(path.join(META_DIR, "datasets", `${id}.json`));
      if (!dataset) return errorResult(`Dataset not found: ${id}`);
      return textResult(dataset);
    },
  );

  server.tool(
    "dataset_search",
    "Search the sprite reference index by tags, size, and format. Returns matching sprite entries with file paths.",
    {
      tags: z.string().describe("Comma-separated tags to match (AND logic). E.g. 'knight,attack,side-view'"),
      max_size: z.number().optional().describe("Maximum pixel dimension (default 512)"),
      min_size: z.number().optional().describe("Minimum pixel dimension (default 16)"),
      limit: z.number().optional().describe("Maximum results to return (default 20)"),
      sheets_only: z.boolean().optional().describe("Only return spritesheets (default false)"),
    },
    async ({ tags, max_size, min_size, limit, sheets_only }) => {
      const indexPath = "/opt/datasets/index.json";
      let index;
      try {
        index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      } catch (e) {
        return errorResult(`Index not found. Run build_index.py on the server first.`);
      }

      const searchTags = tags.split(",").map(t => t.trim().toLowerCase());
      const maxDim = max_size || 512;
      const minDim = min_size || 16;
      const maxResults = Math.min(limit || 20, 100);

      let results = index.filter(entry => {
        // Tag matching: ALL search tags must be present
        const entryTags = (entry.tags || []).map(t => t.toLowerCase());
        if (!searchTags.every(st => entryTags.includes(st))) return false;

        // Size filtering
        const dim = Math.max(entry.width || 0, entry.height || 0);
        if (dim < minDim || dim > maxDim) return false;

        // Sheet filter
        if (sheets_only && !entry.is_sheet) return false;

        return true;
      });

      // Sort by tag match count (more tags = more relevant), then by color count (fewer = purer pixel art)
      results.sort((a, b) => {
        const aTagScore = (a.tags || []).length;
        const bTagScore = (b.tags || []).length;
        if (bTagScore !== aTagScore) return bTagScore - aTagScore;
        return (a.colors || 999) - (b.colors || 999);
      });

      results = results.slice(0, maxResults);

      if (results.length === 0) {
        return textResult(`No sprites found matching tags: [${searchTags.join(", ")}] (${index.length} total indexed)`);
      }

      const summary = results.map(r =>
        `[${r.width}x${r.height}] ${r.path} | tags: ${(r.tags||[]).join(",")} | colors: ${r.colors || "?"}`
      ).join("\n");

      return textResult(`${results.length} match(es) for [${searchTags.join(", ")}]:\n${summary}`);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  COMPOUND CONTEXT LOADER                                │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "context_load",
    "Load full conversation context for a project in a single call: handoff state, project details, open tasks, and recent snippets. Use this at the start of every conversation instead of calling meta_retrieve + project_get + task_list separately.",
    {
      project: z.string().describe("Project identifier (e.g. 'my-project', 'web-app')"),
      snippet_query: z
        .string()
        .optional()
        .describe("Optional keyword to search snippets (omit to skip snippet loading)"),
      depth: z
        .enum(["minimal", "standard", "deep"])
        .optional()
        .describe("Context depth: minimal (handoff+project), standard (default — adds tasks/snippets/memories/artifacts), deep (adds semantic search, profile, cross-project)"),
      query: z
        .string()
        .optional()
        .describe("Current task description — used by 'deep' depth for relevant memory retrieval"),
    },
    async ({ project, snippet_query, depth, query }) => {
      const level = depth || "standard";
      const result = {};

      // ── Tier 0 (always): Handoff + Project meta ──
      const handoffPath = path.join(META_DIR, "kv", `handoff__${project}.json`);
      const handoff = readJSON(handoffPath);
      result.handoff = handoff ? handoff.value : null;

      const projectData = readJSON(path.join(META_DIR, "projects", `${project}.json`));
      result.project = projectData || null;

      if (level === "minimal") {
        result.summary = `Project: ${projectData?.name || project} | Handoff: ${handoff ? "available" : "none"} | Depth: minimal`;
        return textResult(result);
      }

      // ── Tier 1 (standard): Tasks + Snippets + Recent Memories + Artifacts ──
      const allTasks = listJSON(path.join(META_DIR, "tasks"));
      const openTasks = allTasks
        .filter((t) => t.project === project && t.status !== "done")
        .sort((a, b) => {
          const prio = { critical: 0, high: 1, medium: 2, low: 3 };
          return (prio[a.priority] || 2) - (prio[b.priority] || 2);
        });
      result.tasks = openTasks.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        status: t.status,
      }));

      // Snippets
      if (snippet_query) {
        const snippets = listJSON(path.join(META_DIR, "snippets"));
        const q = snippet_query.toLowerCase();
        const matches = snippets
          .filter(
            (s) =>
              s.title.toLowerCase().includes(q) ||
              s.content.toLowerCase().includes(q) ||
              s.tags.some((t) => t.toLowerCase().includes(q)),
          )
          .slice(0, 5);
        result.snippets = matches.map((s) => ({
          id: s.id,
          title: s.title,
          tags: s.tags,
          preview: s.content.slice(0, 200),
        }));
      }

      // Recent memories
      try {
        const memDir = path.join(META_DIR, "memory");
        const allMems = listJSON(memDir)
          .filter((m) => m.project === project)
          .sort((a, b) => new Date(b.created) - new Date(a.created))
          .slice(0, 5);
        result.memories = allMems.map((m) => ({
          id: m.id,
          type: m.type,
          content: m.content,
          tags: m.tags,
          created: m.created,
        }));
      } catch {
        result.memories = [];
      }

      // Recent artifacts
      try {
        const artDir = path.join(META_DIR, "artifacts");
        const recentArts = listJSON(artDir)
          .filter((a) => a.project === project)
          .sort((a, b) => new Date(b.updated) - new Date(a.updated))
          .slice(0, 5);
        result.artifacts = recentArts.map((a) => ({
          id: a.id,
          title: a.title,
          type: a.type,
          version: a.version,
          updated: a.updated,
        }));
      } catch {
        result.artifacts = [];
      }

      result.summary = `Project: ${projectData?.name || project} | ${openTasks.length} open task(s) | Handoff: ${handoff ? "available" : "none"} | Depth: ${level}`;

      if (level === "standard") {
        return textResult(result);
      }

      // ── Tier 2 (deep): Semantic retrieval + Profile + Cross-project ──
      
      // Semantic memory search for the current query/task
      if (query) {
        try {
          if (!memoryIndex) await loadMemoryIndex();
          const queryVec = await embed(query);
          const relevantMems = memoryIndex
            .filter((m) => m.project === project)
            .map((m) => ({ ...m, score: cosineSimilarity(queryVec, m.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .filter((m) => m.score > 0.3);

          result.relevant_memories = relevantMems.map((m) => ({
            id: m.id,
            score: Math.round(m.score * 1000) / 1000,
            type: m.type,
            content: m.content,
            tags: m.tags,
          }));
        } catch {
          result.relevant_memories = [];
        }
      }

      // Project profile (if generated)
      try {
        const profileKey = `profile__${project}.json`;
        const profile = readJSON(path.join(META_DIR, "kv", profileKey));
        if (profile) result.profile = JSON.parse(profile.value);
      } catch {
        result.profile = null;
      }

      // Cross-project patterns (recent memories from related projects)
      try {
        const memDir2 = path.join(META_DIR, "memory");
        const crossMems = listJSON(memDir2)
          .filter((m) => m.project && m.project !== project)
          .sort((a, b) => new Date(b.created) - new Date(a.created))
          .slice(0, 3);
        result.cross_project = crossMems.map((m) => ({
          id: m.id,
          project: m.project,
          type: m.type,
          content: m.content.slice(0, 200),
          created: m.created,
        }));
      } catch {
        result.cross_project = [];
      }

      // ── v4.0+ Agentic Context ──

      // Active agents
      try {
        const agents = listJSON(path.join(META_DIR, "agents"));
        result.agents = agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          capabilities: a.capabilities,
          channel: a.channel,
          last_active: a.stats?.last_active,
        }));
      } catch {
        result.agents = [];
      }

      // Recent events (last 5)
      try {
        const recentEvents = listJSON(path.join(META_DIR, "events"))
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
          .slice(0, 5);
        result.recent_events = recentEvents.map((e) => ({
          type: e.type,
          source: e.source,
          project: e.project,
          severity: e.severity,
          timestamp: e.timestamp,
        }));
      } catch {
        result.recent_events = [];
      }

      // Active workflows
      try {
        let wfs = listJSON(path.join(META_DIR, "workflows"));
        if (project) wfs = wfs.filter((w) => w.project === project);
        result.workflows = wfs.map((w) => ({
          id: w.id,
          name: w.name,
          runs: w.runs,
          trigger: w.trigger,
        }));
      } catch {
        result.workflows = [];
      }

      // ── v5.0+ Cognitive Context ──

      // Learned procedures (relevant to this project)
      try {
        let procs = listJSON(path.join(META_DIR, "procedures"));
        procs = procs.filter((p) => !p.project || p.project === project);
        result.procedures = procs.map((p) => ({
          id: p.id,
          name: p.name,
          trigger: p.trigger,
          confidence: p.confidence,
          times_accepted: p.times_accepted,
        }));
      } catch {
        result.procedures = [];
      }

      // Knowledge graph summary + project neighborhood
      try {
        const kgDir = path.join(META_DIR, "knowledge");
        if (fs.existsSync(kgDir)) {
          const kgFiles = fs.readdirSync(kgDir);
          const entityCount = kgFiles.filter((f) => f.startsWith("entity__")).length;
          const relCount = kgFiles.filter((f) => f.startsWith("rel__")).length;
          // Top 5 entities by mention count
          const topEntities = kgFiles
            .filter((f) => f.startsWith("entity__"))
            .map((f) => readJSON(path.join(kgDir, f)))
            .filter(Boolean)
            .sort((a, b) => (b.mentions || 0) - (a.mentions || 0))
            .slice(0, 5);

          // Project entity neighborhood (1-hop)
          const projEntityId = project.replace(/[^a-zA-Z0-9]/g, "_");
          const projRelFiles = kgFiles.filter(f => f.startsWith("rel__") && f.includes(projEntityId));
          const projectRelationships = projRelFiles
            .map(f => readJSON(path.join(kgDir, f)))
            .filter(Boolean)
            .sort((a, b) => (b.weight || 0) - (a.weight || 0))
            .slice(0, 15)
            .map(r => ({ from: r.from, relationship: r.relationship, to: r.to, weight: r.weight }));

          result.knowledge_graph = {
            entities: entityCount,
            relationships: relCount,
            top_entities: topEntities.map((e) => ({
              id: e.id,
              type: e.type,
              mentions: e.mentions,
            })),
            project_neighborhood: projectRelationships,
          };
        }
      } catch {
        result.knowledge_graph = null;
      }

      result.summary = `Project: ${projectData?.name || project} | ${openTasks.length} open task(s) | ${result.agents?.length || 0} agents | ${result.procedures?.length || 0} procedures | KG: ${result.knowledge_graph?.entities || 0} entities | Depth: deep`;

      return textResult(result);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SEMANTIC MEMORY                                        │
  // └─────────────────────────────────────────────────────────┘

  // In-memory vector index (loaded lazily on first search)
  let memoryIndex = null;

  async function loadMemoryIndex() {
    const memDir = path.join(META_DIR, "memory");
    const entries = listJSON(memDir).filter((m) => m.embedding);
    memoryIndex = entries.map((m) => ({
      id: m.id,
      type: m.type,
      content: m.content,
      project: m.project,
      tags: m.tags || [],
      created: m.created,
      embedding: m.embedding,
    }));
    console.log(`[memory] Index loaded: ${memoryIndex.length} entries (${isSemanticReady() ? "semantic" : "keyword"} mode)`);
    return memoryIndex;
  }

  server.tool(
    "memory_store",
    "Store a structured memory with semantic embedding. Use this to record decisions, insights, observations, and handoff context that should be retrievable by meaning across conversations.",
    {
      content: z.string().describe("The memory content — what happened, what was decided, what was learned"),
      type: z
        .enum(["decision", "insight", "task", "handoff", "observation"])
        .describe("Memory type for filtering"),
      project: z.string().optional().describe("Associated project ID (e.g. 'my-project', 'web-app')"),
      tags: z.string().optional().describe("Comma-separated tags for categorization"),
      refs: z.string().optional().describe("Comma-separated memory IDs this memory relates to"),
    },
    async ({ content, type, project, tags, refs }) => {
      const id = randomUUID();
      const embedding = await embed(content);
      const memory = {
        id,
        type,
        content,
        project: project || null,
        tags: tags ? tags.split(",").map((t) => t.trim()) : [],
        refs: refs ? refs.split(",").map((r) => r.trim()) : [],
        embedding,
        created: new Date().toISOString(),
      };

      writeJSON(path.join(META_DIR, "memory", `${id}.json`), memory);

      // Update in-memory index
      if (memoryIndex) {
        memoryIndex.push({
          id: memory.id,
          type: memory.type,
          content: memory.content,
          project: memory.project,
          tags: memory.tags,
          created: memory.created,
          embedding: memory.embedding,
        });
      }

      return textResult({ stored: id, type, project, semantic: isSemanticReady() });
    },
  );

  server.tool(
    "memory_search",
    "Search memories by semantic similarity. Returns the most relevant memories matching the query meaning, not just keywords.",
    {
      query: z.string().describe("Natural language search query"),
      project: z.string().optional().describe("Filter to a specific project"),
      type: z
        .enum(["decision", "insight", "task", "handoff", "observation"])
        .optional()
        .describe("Filter by memory type"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ query, project, type, limit }) => {
      if (!memoryIndex) await loadMemoryIndex();
      if (memoryIndex.length === 0) return textResult("No memories stored yet.");

      const queryVec = await embed(query);
      const maxResults = Math.min(limit || 10, 50);

      let candidates = memoryIndex;
      if (project) candidates = candidates.filter((m) => m.project === project);
      if (type) candidates = candidates.filter((m) => m.type === type);

      const scored = candidates
        .map((m) => ({
          ...m,
          score: cosineSimilarity(queryVec, m.embedding),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      const results = scored.map((m) => ({
        id: m.id,
        score: Math.round(m.score * 1000) / 1000,
        type: m.type,
        project: m.project,
        content: m.content,
        tags: m.tags,
        created: m.created,
      }));

      return textResult({
        query,
        mode: isSemanticReady() ? "semantic" : "keyword",
        count: results.length,
        results,
      });
    },
  );

  server.tool(
    "memory_log",
    "Retrieve recent memories chronologically. Use for reviewing what happened in recent sessions.",
    {
      project: z.string().optional().describe("Filter to a specific project"),
      type: z
        .enum(["decision", "insight", "task", "handoff", "observation"])
        .optional()
        .describe("Filter by memory type"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ project, type, limit }) => {
      const memDir = path.join(META_DIR, "memory");
      let entries = listJSON(memDir);

      if (project) entries = entries.filter((m) => m.project === project);
      if (type) entries = entries.filter((m) => m.type === type);

      entries.sort((a, b) => new Date(b.created) - new Date(a.created));
      entries = entries.slice(0, Math.min(limit || 20, 100));

      const results = entries.map((m) => ({
        id: m.id,
        type: m.type,
        project: m.project,
        content: m.content,
        tags: m.tags || [],
        created: m.created,
      }));

      return textResult({
        count: results.length,
        results,
      });
    },
  );

  server.tool(
    "memory_search_advanced",
    "Structured memory search with compound filters (AND/OR/NOT). Complements semantic search for precise queries like 'all decisions tagged architecture NOT archived from last 30 days'. All filters are ANDed together.",
    {
      project: z.string().optional().describe("Filter by project"),
      type: z.enum(["decision", "insight", "task", "handoff", "observation"]).optional().describe("Filter by type"),
      tags_include: z.string().optional().describe("Comma-separated tags — memory must have ALL of these"),
      tags_exclude: z.string().optional().describe("Comma-separated tags — memory must have NONE of these"),
      content_contains: z.string().optional().describe("Substring that must appear in memory content (case-insensitive)"),
      content_not_contains: z.string().optional().describe("Substring that must NOT appear in memory content"),
      pinned: z.boolean().optional().describe("Filter by pinned status"),
      include_archived: z.boolean().optional().describe("Include archived memories (default: false)"),
      from_date: z.string().optional().describe("Earliest date (ISO or 'YYYY-MM-DD')"),
      to_date: z.string().optional().describe("Latest date (ISO or 'YYYY-MM-DD')"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ project, type, tags_include, tags_exclude, content_contains, content_not_contains, pinned, include_archived, from_date, to_date, limit }) => {
      const memDir = path.join(META_DIR, "memory");
      let results = listJSON(memDir);

      // AND filters
      if (!include_archived) results = results.filter(m => !m.archived);
      if (project) results = results.filter(m => m.project === project);
      if (type) results = results.filter(m => m.type === type);
      if (pinned !== undefined) results = results.filter(m => !!m.pinned === pinned);

      if (tags_include) {
        const required = tags_include.split(",").map(t => t.trim());
        results = results.filter(m => required.every(t => (m.tags || []).includes(t)));
      }
      if (tags_exclude) {
        const excluded = tags_exclude.split(",").map(t => t.trim());
        results = results.filter(m => !excluded.some(t => (m.tags || []).includes(t)));
      }
      if (content_contains) {
        const lc = content_contains.toLowerCase();
        results = results.filter(m => m.content?.toLowerCase().includes(lc));
      }
      if (content_not_contains) {
        const lc = content_not_contains.toLowerCase();
        results = results.filter(m => !m.content?.toLowerCase().includes(lc));
      }
      if (from_date) {
        const from = new Date(from_date);
        results = results.filter(m => new Date(m.created) >= from);
      }
      if (to_date) {
        const to = new Date(to_date);
        results = results.filter(m => new Date(m.created) <= to);
      }

      // Sort by recency
      results.sort((a, b) => new Date(b.created) - new Date(a.created));
      const maxResults = Math.min(limit || 20, 50);
      results = results.slice(0, maxResults);

      return textResult({
        count: results.length,
        results: results.map(m => ({
          id: m.id,
          type: m.type,
          project: m.project,
          content: m.content?.slice(0, 300),
          tags: m.tags || [],
          pinned: !!m.pinned,
          created: m.created,
          ...(m.archived ? { archived: true } : {}),
        })),
      });
    },
  );

  server.tool(
    "memory_stats",
    "Dashboard view of memory system health. Shows distribution by type, project, and age; consolidation metrics; KG entity/relationship counts; embedding coverage. Use to monitor memory growth and decide when to consolidate.",
    {
      project: z.string().optional().describe("Filter to specific project"),
    },
    async ({ project }) => {
      const memDir = path.join(META_DIR, "memory");
      let all = listJSON(memDir);
      if (project) all = all.filter(m => m.project === project);

      const active = all.filter(m => !m.archived);
      const archived = all.filter(m => m.archived);
      const consolidated = all.filter(m => m.consolidated_from);

      // By type
      const byType = {};
      for (const m of active) { byType[m.type || "unknown"] = (byType[m.type || "unknown"] || 0) + 1; }

      // By project
      const byProject = {};
      for (const m of active) { const p = m.project || "_unscoped"; byProject[p] = (byProject[p] || 0) + 1; }

      // Age distribution
      const now = Date.now();
      const ageGroups = { "today": 0, "this_week": 0, "this_month": 0, "older": 0 };
      for (const m of active) {
        const age = now - new Date(m.created).getTime();
        if (age < 24 * 60 * 60 * 1000) ageGroups.today++;
        else if (age < 7 * 24 * 60 * 60 * 1000) ageGroups.this_week++;
        else if (age < 30 * 24 * 60 * 60 * 1000) ageGroups.this_month++;
        else ageGroups.older++;
      }

      // Embedding coverage
      const withEmbedding = active.filter(m => m.embedding).length;

      // KG stats
      const kgDir = path.join(META_DIR, "knowledge");
      let kgEntities = 0, kgRelationships = 0;
      if (fs.existsSync(kgDir)) {
        const kgFiles = fs.readdirSync(kgDir);
        kgEntities = kgFiles.filter(f => f.startsWith("entity__")).length;
        kgRelationships = kgFiles.filter(f => f.startsWith("rel__")).length;
      }

      return textResult({
        total: all.length,
        active: active.length,
        archived: archived.length,
        consolidated: consolidated.length,
        by_type: byType,
        by_project: byProject,
        age_distribution: ageGroups,
        embedding_coverage: `${withEmbedding}/${active.length} (${active.length > 0 ? Math.round(withEmbedding / active.length * 100) : 0}%)`,
        knowledge_graph: { entities: kgEntities, relationships: kgRelationships },
        vector_index: memoryIndex ? `loaded (${memoryIndex.length} entries)` : "not loaded",
      });
    },
  );

  server.tool(
    "memory_pin",
    "Pin a memory to protect it from retention policies and auto-consolidation. Pinned memories are never archived automatically. Use for critical decisions, architecture notes, and important handoffs.",
    {
      id: z.string().describe("Memory ID to pin"),
      reason: z.string().optional().describe("Why this memory is pinned"),
    },
    async ({ id, reason }) => {
      const memDir = path.join(META_DIR, "memory");
      const memPath = path.join(memDir, `${safeId(id)}.json`);
      const mem = readJSON(memPath);
      if (!mem) return errorResult(`Memory not found: ${id}`);

      mem.pinned = true;
      mem.pinned_at = new Date().toISOString();
      mem.pin_reason = reason || "Manually pinned";
      writeJSON(memPath, mem);

      return textResult({
        pinned: true,
        id: mem.id,
        type: mem.type,
        content: mem.content.slice(0, 150),
        reason: mem.pin_reason,
      });
    },
  );

  server.tool(
    "memory_unpin",
    "Remove pin protection from a memory, making it eligible for retention policies and auto-consolidation again.",
    {
      id: z.string().describe("Memory ID to unpin"),
    },
    async ({ id }) => {
      const memDir = path.join(META_DIR, "memory");
      const memPath = path.join(memDir, `${safeId(id)}.json`);
      const mem = readJSON(memPath);
      if (!mem) return errorResult(`Memory not found: ${id}`);

      mem.pinned = false;
      delete mem.pinned_at;
      delete mem.pin_reason;
      writeJSON(memPath, mem);

      return textResult({ unpinned: true, id: mem.id });
    },
  );

  server.tool(
    "memory_tag",
    "Add, remove, or set tags on memories. Works on a single memory by ID, or batch-updates all memories matching project+type filters. Use to organize and categorize memories for better retrieval.",
    {
      id: z.string().optional().describe("Specific memory ID to tag (omit for batch mode)"),
      project: z.string().optional().describe("Batch mode: filter by project"),
      type: z.enum(["decision", "insight", "task", "handoff", "observation"]).optional().describe("Batch mode: filter by type"),
      action: z.enum(["add", "remove", "set"]).describe("add: append tags, remove: delete tags, set: replace all tags"),
      tags: z.string().describe("Comma-separated tags to add/remove/set"),
    },
    async ({ id, project, type, action, tags }) => {
      const memDir = path.join(META_DIR, "memory");
      const tagList = tags.split(",").map(t => t.trim()).filter(Boolean);
      if (tagList.length === 0) return errorResult("No tags provided");

      let targets = [];
      if (id) {
        const mem = readJSON(path.join(memDir, `${safeId(id)}.json`));
        if (!mem) return errorResult(`Memory not found: ${id}`);
        targets = [mem];
      } else {
        targets = listJSON(memDir).filter(m => !m.archived);
        if (project) targets = targets.filter(m => m.project === project);
        if (type) targets = targets.filter(m => m.type === type);
        if (targets.length === 0) return errorResult("No memories matched the filters");
      }

      let modified = 0;
      for (const mem of targets) {
        const existing = mem.tags || [];
        let newTags;

        if (action === "add") {
          newTags = [...new Set([...existing, ...tagList])];
        } else if (action === "remove") {
          newTags = existing.filter(t => !tagList.includes(t));
        } else {
          newTags = [...tagList];
        }

        if (JSON.stringify(newTags) !== JSON.stringify(existing)) {
          mem.tags = newTags;
          writeJSON(path.join(memDir, `${mem.id}.json`), mem);
          modified++;
        }
      }

      return textResult({
        action,
        tags: tagList,
        matched: targets.length,
        modified,
        ...(id ? { memory_id: id, result_tags: targets[0].tags } : {}),
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  TEMPORAL MEMORY (v6.0)                                  │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "memory_timeline",
    "Query memories by time range using natural language or dates. Answers questions like 'what did I work on yesterday?' or 'show decisions from last week'. Groups results by day for chronological review.",
    {
      query: z.string().optional().describe("Optional semantic filter (e.g. 'deployment issues')"),
      project: z.string().optional().describe("Filter to project"),
      type: z.enum(["decision", "insight", "task", "handoff", "observation"]).optional().describe("Filter by type"),
      from: z.string().optional().describe("Start date (ISO 8601 or natural: 'yesterday', '3 days ago', 'last monday', 'last week')"),
      to: z.string().optional().describe("End date (ISO 8601 or natural, defaults to now)"),
      group_by: z.enum(["day", "week", "project"]).optional().describe("Grouping mode (default: day)"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ query, project, type, from, to, group_by, limit }) => {
      const now = new Date();

      // Parse natural language dates
      function parseNaturalDate(str) {
        if (!str) return null;
        const s = str.toLowerCase().trim();
        if (s === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (s === "yesterday") { const d = new Date(now); d.setDate(d.getDate() - 1); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
        if (s === "last week") { const d = new Date(now); d.setDate(d.getDate() - 7); return d; }
        if (s === "last month") { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d; }
        const daysAgo = s.match(/^(\d+)\s*days?\s*ago$/);
        if (daysAgo) { const d = new Date(now); d.setDate(d.getDate() - parseInt(daysAgo[1])); return d; }
        const hoursAgo = s.match(/^(\d+)\s*hours?\s*ago$/);
        if (hoursAgo) { const d = new Date(now); d.setHours(d.getHours() - parseInt(hoursAgo[1])); return d; }
        const weeksAgo = s.match(/^(\d+)\s*weeks?\s*ago$/);
        if (weeksAgo) { const d = new Date(now); d.setDate(d.getDate() - parseInt(weeksAgo[1]) * 7); return d; }
        const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
        const lastDay = s.match(/^last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
        if (lastDay) {
          const target = dayNames.indexOf(lastDay[1]);
          const d = new Date(now);
          const diff = (now.getDay() - target + 7) % 7 || 7;
          d.setDate(d.getDate() - diff);
          return new Date(d.getFullYear(), d.getMonth(), d.getDate());
        }
        // Fall back to ISO parse
        const parsed = new Date(s);
        return isNaN(parsed.getTime()) ? null : parsed;
      }

      const fromDate = parseNaturalDate(from) || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // default: last 7 days
      const toDate = parseNaturalDate(to) || now;
      const maxResults = Math.min(limit || 50, 200);

      const memDir = path.join(META_DIR, "memory");
      let memories = listJSON(memDir).filter(m => !m.archived);

      // Time filter
      memories = memories.filter(m => {
        const created = new Date(m.created);
        return created >= fromDate && created <= toDate;
      });

      if (project) memories = memories.filter(m => m.project === project);
      if (type) memories = memories.filter(m => m.type === type);

      // Optional semantic filter
      if (query && isSemanticReady()) {
        const queryVec = await embed(query);
        memories = memories
          .filter(m => m.embedding)
          .map(m => ({ ...m, relevance: cosineSimilarity(queryVec, m.embedding) }))
          .filter(m => m.relevance > 0.25)
          .sort((a, b) => b.relevance - a.relevance);
      }

      memories.sort((a, b) => new Date(b.created) - new Date(a.created));
      memories = memories.slice(0, maxResults);

      // Group results
      const groupMode = group_by || "day";
      const groups = {};

      for (const m of memories) {
        let key;
        const d = new Date(m.created);
        if (groupMode === "day") {
          key = d.toISOString().split("T")[0]; // YYYY-MM-DD
        } else if (groupMode === "week") {
          const weekStart = new Date(d);
          weekStart.setDate(weekStart.getDate() - weekStart.getDay());
          key = `week_of_${weekStart.toISOString().split("T")[0]}`;
        } else {
          key = m.project || "_unscoped";
        }
        if (!groups[key]) groups[key] = [];
        groups[key].push({
          id: m.id,
          type: m.type,
          project: m.project,
          content: m.content.slice(0, 200),
          tags: m.tags,
          relevance: m.relevance ? Math.round(m.relevance * 1000) / 1000 : undefined,
          created: m.created,
        });
      }

      return textResult({
        range: { from: fromDate.toISOString(), to: toDate.toISOString() },
        query: query || null,
        total: memories.length,
        group_by: groupMode,
        groups,
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  KG-POWERED CONTEXT (v6.0)                               │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "knowledge_context",
    "Get rich context for an entity from the knowledge graph. Returns entity details, all relationships, related entities, and connected project/memory metadata. Use to answer 'how does X relate to Y?' or 'what do we know about this technology?'",
    {
      entity: z.string().describe("Entity ID to explore (e.g. 'docker', 'myproject', 'css')"),
      include_memories: z.boolean().optional().describe("If true, fetch recent memories mentioning this entity (default false)"),
      depth: z.number().optional().describe("Relationship traversal depth (1-3, default 1)"),
    },
    async ({ entity, include_memories, depth }) => {
      const kgDir = path.join(META_DIR, "knowledge");
      if (!fs.existsSync(kgDir)) return errorResult("Knowledge graph not initialized. Run knowledge_ingest first.");

      const maxDepth = Math.min(depth || 1, 3);
      const entityFile = path.join(kgDir, `entity__${entity.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
      const entityData = readJSON(entityFile);

      if (!entityData) return errorResult(`Entity not found: ${entity}`);

      // BFS to collect neighborhood
      const visited = new Set([entity]);
      const relationships = [];
      const relatedEntities = new Map();
      let frontier = [entity];

      for (let hop = 0; hop < maxDepth; hop++) {
        const nextFrontier = [];
        const kgFiles = fs.readdirSync(kgDir);

        for (const currentEntity of frontier) {
          const relFiles = kgFiles.filter(f => f.startsWith("rel__") && f.includes(currentEntity.replace(/[^a-zA-Z0-9]/g, "_")));
          for (const rf of relFiles) {
            const rel = readJSON(path.join(kgDir, rf));
            if (!rel) continue;
            relationships.push({ ...rel, hop: hop + 1 });

            const other = rel.from === currentEntity ? rel.to : rel.from;
            if (!visited.has(other)) {
              visited.add(other);
              nextFrontier.push(other);
              const otherFile = path.join(kgDir, `entity__${other.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
              const otherData = readJSON(otherFile);
              if (otherData) relatedEntities.set(other, { ...otherData, hop: hop + 1 });
            }
          }
        }
        frontier = nextFrontier;
      }

      const result = {
        entity: entityData,
        relationships: relationships.sort((a, b) => (b.weight || 0) - (a.weight || 0)),
        related_entities: [...relatedEntities.values()].sort((a, b) => (b.mentions || 0) - (a.mentions || 0)),
        stats: {
          total_relationships: relationships.length,
          total_related: relatedEntities.size,
          max_hop: maxDepth,
        },
      };

      // Optionally include memories that mention this entity
      if (include_memories) {
        const memDir = path.join(META_DIR, "memory");
        const entityLower = entity.toLowerCase();
        const mentioning = listJSON(memDir)
          .filter(m => !m.archived && (m.content || "").toLowerCase().includes(entityLower))
          .sort((a, b) => new Date(b.created) - new Date(a.created))
          .slice(0, 10);
        result.memories = mentioning.map(m => ({
          id: m.id, type: m.type, project: m.project,
          content: m.content.slice(0, 200), created: m.created,
        }));
      }

      return textResult(result);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  AGENT MATCHING & HANDOFF (v6.0)                        │
  // └─────────────────────────────────────────────────────────┘

  // agent_match — removed in v6.6 (zero production usage)
  // agent_handoff — removed in v6.6 (zero production usage)
  server.tool(
    "system_health",
    "One-shot infrastructure health check. Returns status of all services, memory stats, disk usage, and container health. Use this instead of manually curling endpoints.",
    {},
    async () => {
      const health = {
        timestamp: new Date().toISOString(),
        services: {},
        storage: {},
        memory: {},
      };

      // MCP Gateway (self)
      health.services.mcp_gateway = {
        status: "healthy",
        version: "7.0.0",
        uptime: process.uptime(),
        embedding_model: isSemanticReady() ? "all-MiniLM-L6-v2 (semantic)" : "fallback (keyword)",
      };

      // Count stored entities
      for (const dir of DIRS) {
        const dirPath = path.join(META_DIR, dir);
        try {
          const count = fs.existsSync(dirPath) ? fs.readdirSync(dirPath).filter(f => f.endsWith(".json")).length : 0;
          health.storage[dir] = count;
        } catch { health.storage[dir] = "error"; }
      }

      // Memory stats
      const memDir = path.join(META_DIR, "memory");
      const memories = listJSON(memDir);
      const byType = {};
      const byProject = {};
      for (const m of memories) {
        byType[m.type] = (byType[m.type] || 0) + 1;
        if (m.project) byProject[m.project] = (byProject[m.project] || 0) + 1;
      }
      health.memory = { total: memories.length, by_type: byType, by_project: byProject };

      // Disk usage
      try {
        const du = execSync("du -sh /data/meta 2>/dev/null || echo 'unknown'").toString().trim();
        health.storage.disk_usage = du.split("\t")[0];
      } catch { health.storage.disk_usage = "unknown"; }

      // Docker containers (if accessible)
      try {
        const containers = execSync(
          "docker ps --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null || true"
        ).toString().trim();
        if (containers) {
          health.services.containers = containers.split("\n").map(line => {
            const [name, status, ports] = line.split("|");
            return { name, status, ports };
          });
        }
      } catch { /* Docker not accessible from container — expected */ }

      return textResult(health);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  FILE INDEX                                             │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "file_index",
    "Build or retrieve a project file tree with key file summaries. Stores the index in memory so subsequent conversations can skip the exploration phase.",
    {
      project: z.string().describe("Project ID (e.g. 'my-project', 'web-app')"),
      root_path: z.string().describe("Absolute path to project root"),
      max_depth: z.number().optional().describe("Max directory depth (default 3)"),
      refresh: z.boolean().optional().describe("Force re-index even if cached"),
    },
    async ({ project, root_path, max_depth, refresh }) => {
      const indexKey = `file_index/${project}`;
      const indexPath = path.join(META_DIR, "kv", `${indexKey.replace(/\//g, "_")}.json`);

      // Return cached if available and not refreshing
      if (!refresh && fs.existsSync(indexPath)) {
        const cached = readJSON(indexPath);
        if (cached && Date.now() - new Date(cached.indexed_at).getTime() < 24 * 3600 * 1000) {
          return textResult({ ...cached, source: "cached" });
        }
      }

      // Build file tree via find command
      const depth = max_depth || 3;
      const IGNORE = [
        "node_modules", ".git", "__pycache__", ".venv", ".next", "dist",
        ".pytest_cache", ".mypy_cache", "*.pyc", ".DS_Store", "*.egg-info",
      ];
      const excludes = IGNORE.map(p => `--exclude='${p}'`).join(" ");

      let tree;
      try {
        tree = execSync(
          `find ${root_path} -maxdepth ${depth} -type f ${IGNORE.map(p => `-not -path '*/${p}/*' -not -name '${p}'`).join(" ")} 2>/dev/null | head -500`,
          { timeout: 10000 }
        ).toString().trim().split("\n").filter(Boolean);
      } catch {
        return errorResult(`Cannot read directory: ${root_path}`);
      }

      // Classify files
      const KEY_FILES = [
        "package.json", "pyproject.toml", "Makefile", "Dockerfile",
        "docker-compose.yml", "docker-compose.yaml", ".env", ".env.example",
        "README.md", "requirements.txt", "tsconfig.json", "vite.config.ts",
        "vite.config.js", "next.config.js", "next.config.ts",
      ];

      const KEY_EXTENSIONS = [".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs"];

      const files = tree.map(f => {
        const rel = f.replace(root_path + "/", "");
        const name = path.basename(f);
        const ext = path.extname(f);
        return {
          path: rel,
          name,
          ext,
          is_key: KEY_FILES.includes(name),
          is_code: KEY_EXTENSIONS.includes(ext),
          is_config: [".json", ".yml", ".yaml", ".toml", ".env"].includes(ext) || KEY_FILES.includes(name),
        };
      });

      // Summarize key files
      const key_files = files.filter(f => f.is_key).map(f => f.path);

      // Compute directory structure
      const dirs = new Set();
      for (const f of files) {
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join("/"));
        }
      }

      // Language breakdown
      const langCount = {};
      for (const f of files) {
        if (f.is_code) langCount[f.ext] = (langCount[f.ext] || 0) + 1;
      }

      const index = {
        project,
        root_path,
        indexed_at: new Date().toISOString(),
        total_files: files.length,
        directories: dirs.size,
        key_files,
        languages: langCount,
        tree: files.map(f => f.path),
      };

      // Cache it
      writeJSON(indexPath, index);

      // Also store as a memory for semantic retrieval
      const content = `FILE INDEX for ${project}: ${index.total_files} files across ${dirs.size} directories at ${root_path}. Key files: ${key_files.join(", ")}. Languages: ${Object.entries(langCount).map(([k,v]) => `${k}(${v})`).join(", ")}.`;
      await embed(content); // pre-warm
      const memId = randomUUID();
      writeJSON(path.join(META_DIR, "memory", `${memId}.json`), {
        id: memId,
        type: "insight",
        content,
        project,
        tags: ["file-index", "structure"],
        refs: [],
        embedding: await embed(content),
        created: new Date().toISOString(),
      });

      return textResult({ ...index, source: "fresh" });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  EXPERIMENT TRACKER                                     │
  // └─────────────────────────────────────────────────────────┘

  const EXPERIMENTS_DIR = path.join(META_DIR, "experiments");
  fs.mkdirSync(EXPERIMENTS_DIR, { recursive: true });

  // experiment_log — removed in v6.6 (zero production usage)
  // artifact_store — removed in v6.6 (zero production usage)
  // artifact_get — removed in v6.6 (zero production usage)
  // artifact_list — removed in v6.6 (zero production usage)
  // artifact_search — removed in v6.6 (zero production usage)
  // artifact_versions — removed in v6.6 (zero production usage)
  // memory_compact — removed in v6.6 (zero production usage)
  // memory_profile — removed in v6.6 (zero production usage)
  server.tool(
    "memory_retain",
    "Apply memory retention policies. Archive memories older than N days, optionally filtered by type or project. Protects pinned and consolidated memories. Use with dry_run first to preview what would be archived.",
    {
      max_age_days: z.number().describe("Archive memories older than this many days"),
      project: z.string().optional().describe("Filter to specific project"),
      type: z.enum(["decision", "insight", "task", "handoff", "observation"]).optional().describe("Filter to specific type"),
      protect_types: z.string().optional().describe("Comma-separated types to NEVER archive (default: 'decision,handoff')"),
      dry_run: z.boolean().optional().describe("Preview what would be archived without modifying"),
    },
    async ({ max_age_days, project, type, protect_types, dry_run }) => {
      const memDir = path.join(META_DIR, "memory");
      const cutoff = new Date(Date.now() - max_age_days * 24 * 60 * 60 * 1000);
      const protectedTypes = (protect_types || "decision,handoff").split(",").map(t => t.trim());

      let candidates = listJSON(memDir).filter(m =>
        !m.archived &&
        !m.consolidated_from && // never archive consolidated memories
        !m.pinned &&
        new Date(m.created) < cutoff &&
        !protectedTypes.includes(m.type)
      );

      if (project) candidates = candidates.filter(m => m.project === project);
      if (type) candidates = candidates.filter(m => m.type === type);

      if (dry_run) {
        return textResult({
          mode: "dry_run",
          max_age_days,
          cutoff: cutoff.toISOString(),
          protected_types: protectedTypes,
          would_archive: candidates.length,
          by_project: Object.entries(candidates.reduce((acc, m) => { const p = m.project || "_unscoped"; acc[p] = (acc[p] || 0) + 1; return acc; }, {})),
          by_type: Object.entries(candidates.reduce((acc, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc; }, {})),
          preview: candidates.slice(0, 10).map(m => ({
            id: m.id.slice(0, 8), type: m.type, project: m.project,
            content: m.content.slice(0, 100), created: m.created,
          })),
        });
      }

      // Execute retention
      for (const mem of candidates) {
        mem.archived = true;
        mem.archived_at = new Date().toISOString();
        mem.archived_by = "retention_policy";
        mem.retention_rule = { max_age_days, applied: new Date().toISOString() };
        writeJSON(path.join(memDir, `${mem.id}.json`), mem);
      }

      if (candidates.length > 0) memoryIndex = null;

      return textResult({
        mode: "executed",
        archived: candidates.length,
        max_age_days,
        cutoff: cutoff.toISOString(),
        protected_types: protectedTypes,
        by_project: Object.entries(candidates.reduce((acc, m) => { const p = m.project || "_unscoped"; acc[p] = (acc[p] || 0) + 1; return acc; }, {})),
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SNIPPET UPDATE (v3.2)                                   │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "snippet_update",
    "Update an existing snippet's content, tags, or language.",
    {
      id: z.string().describe("Snippet identifier"),
      content: z.string().optional().describe("Updated content"),
      title: z.string().optional().describe("Updated title"),
      language: z.string().optional().describe("Updated language"),
      tags: z.string().optional().describe("Updated comma-separated tags"),
    },
    async ({ id, content, title, language, tags }) => {
      const filePath = path.join(META_DIR, "snippets", `${id}.json`);
      const snippet = readJSON(filePath);
      if (!snippet) return errorResult(`Snippet not found: ${id}`);

      if (content) snippet.content = content;
      if (title) snippet.title = title;
      if (language) snippet.language = language;
      if (tags) snippet.tags = tags.split(",").map(t => t.trim());
      snippet.updated = new Date().toISOString();

      writeJSON(filePath, snippet);
      return textResult(`Snippet updated: ${snippet.title} [${id}]`);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  GRAPH MEMORY + CROSS-PROJECT (v3.3)                     │
  // └─────────────────────────────────────────────────────────┘

  // memory_graph — removed in v6.6 (zero production usage)
  // memory_xproject — removed in v6.6 (zero production usage)
  server.tool(
    "agent_register",
    "Register or update an agent persona. Agents are first-class entities with capabilities, preferences, and interaction history. Use to onboard custom agents.",
    {
      id: z.string().describe("Unique agent ID (e.g. 'agent-alpha', 'my-bot')"),
      name: z.string().describe("Human-readable agent name"),
      role: z.string().describe("Agent role/persona description"),
      capabilities: z.string().optional().describe("Comma-separated capabilities (e.g. 'code-review,deploy,chat')"),
      model: z.string().optional().describe("Underlying model (e.g. 'gemini-2.5-pro', 'claude-sonnet')"),
      channel: z.string().optional().describe("Communication channel (e.g. 'discord', 'mcp', 'cli')"),
      status: z.enum(["active", "idle", "offline", "maintenance"]).optional().describe("Current agent status"),
      preferences: z.string().optional().describe("JSON string of agent-specific preferences/config"),
    },
    async ({ id, name, role, capabilities, model, channel, status, preferences }) => {
      const agentPath = path.join(META_DIR, "agents", `${id}.json`);
      const existing = readJSON(agentPath);

      const agent = {
        id,
        name,
        role,
        capabilities: capabilities ? capabilities.split(",").map(c => c.trim()) : existing?.capabilities || [],
        model: model || existing?.model || null,
        channel: channel || existing?.channel || null,
        status: status || existing?.status || "active",
        preferences: preferences ? JSON.parse(preferences) : existing?.preferences || {},
        stats: existing?.stats || { messages_sent: 0, tasks_completed: 0, last_active: null },
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };

      writeJSON(agentPath, agent);
      return textResult({ registered: id, name, status: agent.status, capabilities: agent.capabilities });
    },
  );

  server.tool(
    "agent_list",
    "List all registered agents with their status and capabilities",
    {
      status: z.enum(["active", "idle", "offline", "maintenance", "all"]).optional().describe("Filter by status (default: all)"),
    },
    async ({ status }) => {
      const agents = listJSON(path.join(META_DIR, "agents"));
      const filtered = (!status || status === "all") ? agents : agents.filter(a => a.status === status);
      return textResult({
        total: filtered.length,
        agents: filtered.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role.slice(0, 100),
          status: a.status,
          capabilities: a.capabilities,
          model: a.model,
          channel: a.channel,
          last_active: a.stats?.last_active,
        })),
      });
    },
  );

  server.tool(
    "agent_get",
    "Get full details of a registered agent including preferences and stats",
    {
      id: z.string().describe("Agent identifier"),
    },
    async ({ id }) => {
      const agent = readJSON(path.join(META_DIR, "agents", `${id}.json`));
      if (!agent) return errorResult(`Agent not found: ${id}`);
      return textResult(agent);
    },
  );

  server.tool(
    "agent_update",
    "Update an agent's status, stats, or preferences. Use to track activity and manage agent lifecycle.",
    {
      id: z.string().describe("Agent identifier"),
      status: z.enum(["active", "idle", "offline", "maintenance"]).optional().describe("New status"),
      increment_messages: z.boolean().optional().describe("Increment message count"),
      increment_tasks: z.boolean().optional().describe("Increment completed task count"),
      preferences: z.string().optional().describe("JSON string of updated preferences (merged)"),
    },
    async ({ id, status, increment_messages, increment_tasks, preferences }) => {
      const agentPath = path.join(META_DIR, "agents", `${id}.json`);
      const agent = readJSON(agentPath);
      if (!agent) return errorResult(`Agent not found: ${id}`);

      if (status) agent.status = status;
      if (increment_messages) {
        agent.stats.messages_sent = (agent.stats.messages_sent || 0) + 1;
        agent.stats.last_active = new Date().toISOString();
      }
      if (increment_tasks) {
        agent.stats.tasks_completed = (agent.stats.tasks_completed || 0) + 1;
      }
      if (preferences) {
        agent.preferences = { ...agent.preferences, ...JSON.parse(preferences) };
      }
      agent.updated = new Date().toISOString();

      writeJSON(agentPath, agent);
      return textResult({ updated: id, status: agent.status, stats: agent.stats });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  EVENT SYSTEM (v4.0)                                     │
  // └─────────────────────────────────────────────────────────┘

  // NOTE: event_emit removed in v6.6 — event_trigger is a strict superset
  // (emits event + matches subscribers + triggers workflows).

  server.tool(
    "event_subscribe",
    "Subscribe an agent or service to specific event types. Subscriptions are stored persistently and matched on event_trigger.",
    {
      subscriber: z.string().describe("Agent or service ID subscribing (e.g. 'my-agent')"),
      type_pattern: z.string().describe("Event type pattern to match (e.g. 'deploy.*', 'task.updated')"),
      action: z.string().optional().describe("Action to take on match (e.g. 'notify_discord', 'log', 'run_workflow')"),
    },
    async ({ subscriber, type_pattern, action }) => {
      const subId = `event_sub__${subscriber}__${type_pattern.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const kvPath = path.join(META_DIR, "kv", `${subId}.json`);

      writeJSON(kvPath, {
        key: subId,
        value: JSON.stringify({
          subscriber,
          type_pattern,
          action: action || "log",
          created: new Date().toISOString(),
        }),
        updated: new Date().toISOString(),
      });

      return textResult({ subscribed: subscriber, pattern: type_pattern, action: action || "log" });
    },
  );

  server.tool(
    "event_log",
    "Query the event log. Retrieve recent events filtered by type, source, project, or severity.",
    {
      type: z.string().optional().describe("Filter by event type prefix (e.g. 'deploy')"),
      source: z.string().optional().describe("Filter by source agent/service"),
      project: z.string().optional().describe("Filter by project"),
      severity: z.enum(["info", "warn", "error", "critical"]).optional().describe("Filter by severity"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ type, source, project, severity, limit }) => {
      let events = listJSON(path.join(META_DIR, "events"));

      if (type) events = events.filter(e => e.type.startsWith(type));
      if (source) events = events.filter(e => e.source === source);
      if (project) events = events.filter(e => e.project === project);
      if (severity) events = events.filter(e => e.severity === severity);

      events = events
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, Math.min(limit || 20, 100));

      return textResult({ total: events.length, events });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  WORKFLOW ENGINE (v4.0)                                  │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "workflow_register",
    "Register or update a workflow definition. Workflows are executable step sequences with optional conditions and parallel branches.",
    {
      id: z.string().describe("Unique workflow ID (e.g. 'deploy-par', 'morning-standup')"),
      name: z.string().describe("Human-readable workflow name"),
      description: z.string().optional().describe("What this workflow does"),
      project: z.string().optional().describe("Associated project"),
      steps: z.string().describe("JSON array of steps: [{id, name, command?, tool?, depends_on?, gate?}]"),
      trigger: z.string().optional().describe("Event type that auto-triggers this workflow (e.g. 'deploy.requested')"),
    },
    async ({ id, name, description, project, steps, trigger }) => {
      const wfPath = path.join(META_DIR, "workflows", `${id}.json`);
      const existing = readJSON(wfPath);

      const workflow = {
        id,
        name,
        description: description || "",
        project: project || null,
        steps: JSON.parse(steps),
        trigger: trigger || null,
        version: (existing?.version || 0) + 1,
        runs: existing?.runs || 0,
        last_run: existing?.last_run || null,
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };

      writeJSON(wfPath, workflow);
      return textResult({
        registered: id,
        name,
        step_count: workflow.steps.length,
        version: workflow.version,
        trigger: workflow.trigger,
      });
    },
  );

  server.tool(
    "workflow_run",
    "Start or advance a workflow execution. Creates a run record tracking step completion, timing, and outputs.",
    {
      workflow_id: z.string().describe("Workflow definition ID"),
      run_id: z.string().optional().describe("Existing run ID to advance (omit to start new)"),
      step_id: z.string().optional().describe("Step to mark complete (for advancing)"),
      step_output: z.string().optional().describe("Output/result from completed step"),
      status: z.enum(["running", "completed", "failed", "paused"]).optional().describe("Set run status (default: running)"),
    },
    async ({ workflow_id, run_id, step_id, step_output, status }) => {
      const wfPath = path.join(META_DIR, "workflows", `${workflow_id}.json`);
      const workflow = readJSON(wfPath);
      if (!workflow) return errorResult(`Workflow not found: ${workflow_id}`);

      // New run
      if (!run_id) {
        const newRunId = randomUUID().slice(0, 8);
        const run = {
          run_id: newRunId,
          workflow_id,
          workflow_name: workflow.name,
          status: "running",
          started: new Date().toISOString(),
          updated: new Date().toISOString(),
          completed: null,
          steps: workflow.steps.map(s => ({
            id: s.id,
            name: s.name,
            status: "pending",
            started: null,
            completed: null,
            output: null,
          })),
          current_step: workflow.steps[0]?.id || null,
        };

        // Store run as KV
        writeJSON(path.join(META_DIR, "kv", `wf_run__${newRunId}.json`), {
          key: `wf_run__${newRunId}`,
          value: JSON.stringify(run),
          updated: run.updated,
        });

        workflow.runs = (workflow.runs || 0) + 1;
        workflow.last_run = newRunId;
        writeJSON(wfPath, workflow);

        // Emit event
        const eventId = randomUUID();
        writeJSON(path.join(META_DIR, "events", `${eventId}.json`), {
          id: eventId,
          type: "workflow.started",
          source: "workflow-engine",
          project: workflow.project,
          payload: { workflow_id, run_id: newRunId },
          severity: "info",
          timestamp: new Date().toISOString(),
          consumed_by: [],
        });

        return textResult({ started: newRunId, workflow: workflow_id, steps: run.steps.length, current_step: run.current_step });
      }

      // Advance existing run
      const runKv = readJSON(path.join(META_DIR, "kv", `wf_run__${run_id}.json`));
      if (!runKv) return errorResult(`Run not found: ${run_id}`);
      const run = JSON.parse(runKv.value);

      if (step_id) {
        const step = run.steps.find(s => s.id === step_id);
        if (step) {
          step.status = "completed";
          step.completed = new Date().toISOString();
          step.output = step_output || null;
        }

        // Advance to next pending step
        const nextStep = run.steps.find(s => s.status === "pending");
        if (nextStep) {
          nextStep.status = "running";
          nextStep.started = new Date().toISOString();
          run.current_step = nextStep.id;
        } else {
          run.current_step = null;
        }
      }

      if (status) {
        run.status = status;
        if (status === "completed" || status === "failed") {
          run.completed = new Date().toISOString();
        }
      }

      // Auto-complete if all steps done
      if (run.steps.every(s => s.status === "completed")) {
        run.status = "completed";
        run.completed = new Date().toISOString();
        run.current_step = null;
      }

      run.updated = new Date().toISOString();
      writeJSON(path.join(META_DIR, "kv", `wf_run__${run_id}.json`), {
        key: `wf_run__${run_id}`,
        value: JSON.stringify(run),
        updated: run.updated,
      });

      return textResult({
        run_id,
        status: run.status,
        current_step: run.current_step,
        completed_steps: run.steps.filter(s => s.status === "completed").length,
        total_steps: run.steps.length,
      });
    },
  );

  server.tool(
    "workflow_status",
    "Get the status of a workflow run including step-by-step progress",
    {
      run_id: z.string().describe("Workflow run ID"),
    },
    async ({ run_id }) => {
      const runKv = readJSON(path.join(META_DIR, "kv", `wf_run__${run_id}.json`));
      if (!runKv) return errorResult(`Run not found: ${run_id}`);
      const run = JSON.parse(runKv.value);
      return textResult(run);
    },
  );

  server.tool(
    "workflow_list",
    "List registered workflow definitions with their run counts and triggers",
    {
      project: z.string().optional().describe("Filter by project"),
    },
    async ({ project }) => {
      let workflows = listJSON(path.join(META_DIR, "workflows"));
      if (project) workflows = workflows.filter(w => w.project === project);

      return textResult({
        total: workflows.length,
        workflows: workflows.map(w => ({
          id: w.id,
          name: w.name,
          project: w.project,
          step_count: w.steps?.length || 0,
          trigger: w.trigger,
          runs: w.runs || 0,
          last_run: w.last_run,
          version: w.version,
          updated: w.updated,
        })),
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  PROCEDURAL MEMORY (v5.0)                                │
  // └─────────────────────────────────────────────────────────┘

  // procedure_learn — removed in v6.6 (zero production usage)
  // procedure_suggest — removed in v6.6 (zero production usage)
  // procedure_feedback — removed in v6.6 (zero production usage)
  server.tool(
    "memory_consolidate",
    "Run a full 'sleep consolidation' cycle on project memories. Clusters semantically similar memories, generates distilled summaries, archives originals, and rebuilds the vector index. More thorough than memory_compact — inspired by human memory consolidation during sleep.",
    {
      project: z.string().describe("Project to consolidate"),
      similarity_threshold: z.number().optional().describe("Cosine similarity threshold for clustering (default 0.75)"),
      min_cluster_size: z.number().optional().describe("Minimum memories in a cluster to consolidate (default 3)"),
      dry_run: z.boolean().optional().describe("If true, preview clusters without modifying anything"),
    },
    async ({ project, similarity_threshold, min_cluster_size, dry_run }) => {
      const threshold = similarity_threshold ?? 0.75;
      const minSize = min_cluster_size ?? 3;
      const memDir = path.join(META_DIR, "memory");

      const allMems = listJSON(memDir).filter(m => m.project === project && m.embedding && !m.archived);
      if (allMems.length < minSize) {
        return textResult({ message: `Only ${allMems.length} active memories for ${project} — below minimum cluster size of ${minSize}`, clusters: [] });
      }

      // Greedy clustering by similarity
      const used = new Set();
      const clusters = [];

      for (let i = 0; i < allMems.length; i++) {
        if (used.has(allMems[i].id)) continue;
        const cluster = [allMems[i]];
        used.add(allMems[i].id);

        for (let j = i + 1; j < allMems.length; j++) {
          if (used.has(allMems[j].id)) continue;
          const sim = cosineSimilarity(allMems[i].embedding, allMems[j].embedding);
          if (sim >= threshold) {
            cluster.push(allMems[j]);
            used.add(allMems[j].id);
          }
        }

        if (cluster.length >= minSize) {
          clusters.push(cluster);
        }
      }

      if (dry_run) {
        return textResult({
          mode: "dry_run",
          project,
          total_memories: allMems.length,
          cluster_count: clusters.length,
          memories_to_consolidate: clusters.reduce((sum, c) => sum + c.length, 0),
          clusters: clusters.map((c, i) => ({
            cluster: i + 1,
            size: c.length,
            types: [...new Set(c.map(m => m.type))],
            preview: c.map(m => m.content.slice(0, 80)),
          })),
        });
      }

      // Execute consolidation
      const results = [];
      for (const cluster of clusters) {
        // Generate distilled summary
        const combinedContent = cluster.map(m => `[${m.type}] ${m.content}`).join("\n\n");
        const types = [...new Set(cluster.map(m => m.type))];
        const tags = [...new Set(cluster.flatMap(m => m.tags || []))];

        const distilled = `[CONSOLIDATED from ${cluster.length} ${types.join("/")} memories]\n\n${combinedContent}`;
        const distilledEmbed = await embed(distilled);

        // Create consolidated memory
        const consolidatedId = randomUUID();
        const consolidated = {
          id: consolidatedId,
          type: types.length === 1 ? types[0] : "insight",
          content: distilled,
          project,
          tags: [...tags, "consolidated"],
          refs: cluster.map(m => m.id),
          embedding: distilledEmbed,
          consolidated_from: cluster.length,
          created: new Date().toISOString(),
        };
        writeJSON(path.join(memDir, `${consolidatedId}.json`), consolidated);

        // Archive originals
        for (const mem of cluster) {
          mem.archived = true;
          mem.archived_at = new Date().toISOString();
          mem.consolidated_into = consolidatedId;
          writeJSON(path.join(memDir, `${mem.id}.json`), mem);
        }

        results.push({
          consolidated_id: consolidatedId,
          cluster_size: cluster.length,
          types,
          archived_ids: cluster.map(m => m.id),
        });
      }

      // Invalidate memory index
      memoryIndex = null;

      return textResult({
        project,
        mode: "executed",
        total_memories_before: allMems.length,
        clusters_consolidated: results.length,
        memories_archived: results.reduce((sum, r) => sum + r.cluster_size, 0),
        new_consolidated_memories: results.length,
        total_memories_after: allMems.length - results.reduce((sum, r) => sum + r.cluster_size, 0) + results.length,
        details: results,
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  CONTEXT BOOKMARKS (v6.3)                                │
  // └─────────────────────────────────────────────────────────┘

  // context_bookmark — removed in v6.6 (zero production usage)
  // context_predict — removed in v6.6 (zero production usage)
  server.tool(
    "knowledge_extract",
    "Extract entity-relationship triples from text. Entities are typed (person, project, tool, concept, decision, technology), relationships are labeled (uses, depends_on, part_of, created_by, supersedes, etc.). Builds the knowledge graph incrementally.",
    {
      text: z.string().describe("Text to extract entities and relationships from"),
      project: z.string().optional().describe("Project context for disambiguation"),
      source_id: z.string().optional().describe("Source memory/artifact ID for provenance tracking"),
    },
    async ({ text, project, source_id }) => {
      const result = extractKG(text, project, source_id);
      return textResult({
        entities_found: result.entities.length,
        relationships_found: result.relationships.length,
        entities: result.entities,
        relationships: result.relationships.map(r => `${r.from} --[${r.type}]--> ${r.to}`),
      });
    },
  );

  server.tool(
    "knowledge_query",
    "Query the knowledge graph. Look up an entity and discover all its relationships, or explore the neighborhood by walking N hops out.",
    {
      entity: z.string().describe("Entity ID to look up"),
      hops: z.number().optional().describe("Number of relationship hops to traverse (default 1, max 3)"),
      relationship_type: z.string().optional().describe("Filter by relationship type (e.g. 'uses', 'depends_on')"),
    },
    async ({ entity, hops, relationship_type }) => {
      const maxHops = Math.min(hops || 1, 3);
      const kgDir = path.join(META_DIR, "knowledge");
      const allFiles = fs.existsSync(kgDir) ? fs.readdirSync(kgDir) : [];

      // Load entity
      const entityFile = allFiles.find(f => f === `entity__${entity.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
      const entityData = entityFile ? readJSON(path.join(kgDir, entityFile)) : null;

      // Load all relationships
      const allRels = allFiles
        .filter(f => f.startsWith("rel__"))
        .map(f => readJSON(path.join(kgDir, f)))
        .filter(Boolean);

      // BFS from entity
      const visited = new Set([entity]);
      const graph = { center: entityData || { id: entity, type: "unknown" }, nodes: [], edges: [] };
      let frontier = [entity];

      for (let hop = 0; hop < maxHops; hop++) {
        const nextFrontier = [];
        for (const current of frontier) {
          const connected = allRels.filter(r => {
            const matches = r.from === current || r.to === current;
            if (!matches) return false;
            if (relationship_type) return r.type === relationship_type;
            return true;
          });

          for (const rel of connected) {
            graph.edges.push({
              from: rel.from,
              to: rel.to,
              type: rel.type,
              weight: rel.weight,
            });

            const neighbor = rel.from === current ? rel.to : rel.from;
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              nextFrontier.push(neighbor);

              // Load neighbor entity data
              const neighborFile = allFiles.find(f => f === `entity__${neighbor.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
              const neighborData = neighborFile ? readJSON(path.join(kgDir, neighborFile)) : { id: neighbor, type: "unknown" };
              graph.nodes.push({ ...neighborData, hop: hop + 1 });
            }
          }
        }
        frontier = nextFrontier;
      }

      return textResult({
        entity,
        hops: maxHops,
        connected_entities: graph.nodes.length,
        relationships: graph.edges.length,
        graph,
      });
    },
  );

  server.tool(
    "knowledge_ingest",
    "Bulk-process project memories to build the knowledge graph. Extracts entities and relationships from all memories for a project. Run this once to bootstrap the graph, then rely on incremental knowledge_extract calls.",
    {
      project: z.string().describe("Project to ingest memories from"),
      limit: z.number().optional().describe("Max memories to process (default 50)"),
    },
    async ({ project, limit }) => {
      const maxMems = Math.min(limit || 50, 200);
      const memDir = path.join(META_DIR, "memory");
      const memories = listJSON(memDir)
        .filter(m => m.project === project && !m.archived)
        .sort((a, b) => new Date(b.created) - new Date(a.created))
        .slice(0, maxMems);

      let totalEntities = 0, totalRelationships = 0;
      const kgDir = path.join(META_DIR, "knowledge");
      const allProjects = listJSON(path.join(META_DIR, "projects"));

      const toolPattern = /\b(memory_\w+|artifact_\w+|context_\w+|project_\w+|task_\w+|snippet_\w+|skill_\w+|dataset_\w+|event_\w+|workflow_\w+|agent_\w+|file_\w+|meta_\w+|procedure_\w+|knowledge_\w+|system_health|experiment_log|ping|server_status)\b/g;
      const techTerms = ["docker", "node", "javascript", "python", "d3", "mcp", "discord", "gemini", "claude", "pillow", "numpy", "react", "vite", "tailwind", "minilm", "onnx"];

      for (const mem of memories) {
        const entities = new Map();
        const text = mem.content;

        // Projects
        for (const proj of allProjects) {
          if (text.toLowerCase().includes(proj.id.toLowerCase())) {
            entities.set(proj.id, { id: proj.id, name: proj.name, type: "project" });
          }
        }
        // Tools
        let match;
        const tp = new RegExp(toolPattern.source, toolPattern.flags);
        while ((match = tp.exec(text)) !== null) {
          entities.set(match[1], { id: match[1], name: match[1], type: "tool" });
        }
        // Tech
        for (const tech of techTerms) {
          if (text.toLowerCase().includes(tech)) {
            entities.set(tech, { id: tech, name: tech, type: "technology" });
          }
        }

        // Persist
        for (const entity of entities.values()) {
          const entityPath = path.join(kgDir, `entity__${entity.id.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
          const existing = readJSON(entityPath);
          if (existing) {
            existing.mentions = (existing.mentions || 0) + 1;
            existing.last_seen = new Date().toISOString();
            writeJSON(entityPath, existing);
          } else {
            writeJSON(entityPath, { ...entity, project, mentions: 1, sources: [mem.id], created: new Date().toISOString(), last_seen: new Date().toISOString() });
          }
          totalEntities++;
        }

        // Co-occurrence relationships
        const entityList = [...entities.values()];
        for (let i = 0; i < entityList.length; i++) {
          for (let j = i + 1; j < entityList.length; j++) {
            const relId = `${entityList[i].id}__related_to__${entityList[j].id}`.replace(/[^a-zA-Z0-9_]/g, "_");
            const relPath = path.join(kgDir, `rel__${relId}.json`);
            const existing = readJSON(relPath);
            if (existing) {
              existing.weight = (existing.weight || 1) + 1;
              writeJSON(relPath, existing);
            } else {
              writeJSON(relPath, { id: relId, from: entityList[i].id, to: entityList[j].id, type: "related_to", weight: 1, created: new Date().toISOString(), last_seen: new Date().toISOString() });
            }
            totalRelationships++;
          }
        }
      }

      return textResult({
        project,
        memories_processed: memories.length,
        entities_extracted: totalEntities,
        relationships_found: totalRelationships,
        message: `Knowledge graph built from ${memories.length} memories`,
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  KG ENTITY MERGE (v6.5)                                  │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "knowledge_merge",
    "Merge two duplicate KG entities. Keeps the primary entity, transfers all relationships from the secondary, accumulates mention counts, and deletes the secondary. Use to clean up duplicates like 'nodejs' and 'node' or 'mcp-gateway' and 'gateway'.",
    {
      primary: z.string().describe("Entity ID to keep"),
      secondary: z.string().describe("Entity ID to merge into primary and delete"),
    },
    async ({ primary, secondary }) => {
      if (primary === secondary) return errorResult("Cannot merge an entity with itself");
      const kgDir = path.join(META_DIR, "knowledge");
      if (!fs.existsSync(kgDir)) return errorResult("Knowledge graph not initialized");

      // Find entities
      const files = fs.readdirSync(kgDir);
      const findEntity = (id) => {
        const f = files.find(f => f === `entity__${id.replace(/[^a-zA-Z0-9]/g, "_")}.json`);
        return f ? readJSON(path.join(kgDir, f)) : null;
      };

      const pri = findEntity(primary);
      const sec = findEntity(secondary);
      if (!pri) return errorResult(`Primary entity not found: ${primary}`);
      if (!sec) return errorResult(`Secondary entity not found: ${secondary}`);

      // Merge: accumulate mentions, merge sources
      pri.mentions = (pri.mentions || 1) + (sec.mentions || 1);
      pri.sources = [...new Set([...(pri.sources || []), ...(sec.sources || [])])];
      pri.aliases = [...new Set([...(pri.aliases || []), secondary, sec.name || secondary])];
      pri.last_seen = new Date().toISOString();

      // Transfer relationships: repoint secondary → primary
      const relFiles = files.filter(f => f.startsWith("rel__"));
      let transferred = 0;
      for (const rf of relFiles) {
        const rel = readJSON(path.join(kgDir, rf));
        if (!rel) continue;
        let changed = false;
        if (rel.from === secondary) { rel.from = primary; changed = true; }
        if (rel.to === secondary) { rel.to = primary; changed = true; }
        if (changed) {
          // Rename rel file
          const newRelId = `${rel.from}__${rel.type}__${rel.to}`.replace(/[^a-zA-Z0-9_]/g, "_");
          fs.unlinkSync(path.join(kgDir, rf));
          writeJSON(path.join(kgDir, `rel__${newRelId}.json`), { ...rel, id: newRelId });
          transferred++;
        }
      }

      // Save primary, delete secondary
      writeJSON(path.join(kgDir, `entity__${primary.replace(/[^a-zA-Z0-9]/g, "_")}.json`), pri);
      const secFile = `entity__${secondary.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
      if (fs.existsSync(path.join(kgDir, secFile))) fs.unlinkSync(path.join(kgDir, secFile));

      return textResult({
        merged: true,
        primary: { id: primary, mentions: pri.mentions, aliases: pri.aliases },
        secondary_deleted: secondary,
        relationships_transferred: transferred,
      });
    },
  );
  // ┌─────────────────────────────────────────────────────────┐
  // │  EVENT TRIGGER — unified event emission (v6.6)           │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "event_trigger",
    "Emit a structured event, match subscribers, and auto-start any workflows with matching triggers. Unified event tool (replaces event_emit).",
    {
      type: z.string().describe("Event type (e.g. 'deploy.requested', 'task.updated')"),
      source: z.string().optional().describe("Emitting agent or service (default: 'event_trigger')"),
      project: z.string().optional().describe("Associated project"),
      payload: z.string().optional().describe("JSON payload string"),
      severity: z.enum(["info", "warn", "error", "critical"]).optional().describe("Event severity (default: info)"),
    },
    async ({ type, source, project, payload, severity }) => {
      const eventId = randomUUID().slice(0, 8);
      const event = {
        id: eventId,
        type,
        source: source || "event_trigger",
        project: project || null,
        payload: payload ? JSON.parse(payload) : {},
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
            steps: wf.steps.map(s => ({ ...s, status: "pending" })),
            status: "triggered", started_at: new Date().toISOString(),
          };
          const runDir = path.join(META_DIR, "workflow_runs");
          if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
          writeJSON(path.join(runDir, `${runId}.json`), run);
          triggered.push({ workflow: wf.id, name: wf.name, run_id: runId });
        }
      }

      return textResult({
        event: { id: eventId, type, source: event.source, severity: event.severity, project },
        subscribers: subscribers.length ? subscribers : undefined,
        workflows_triggered: triggered.length,
        workflows: triggered.length ? triggered : undefined,
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SYSTEM CHANGELOG (v6.5)                                 │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "system_changelog",
    "Generate a human-readable changelog of system activity. Aggregates recent events, workflow runs, memory operations, and KG changes into a chronological summary. Use to understand what happened since your last session.",
    {
      hours: z.number().optional().describe("Look back N hours (default 24)"),
      project: z.string().optional().describe("Filter to specific project"),
    },
    async ({ hours, project }) => {
      const lookback = (hours || 24) * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - lookback);

      // Events
      const events = listJSON(path.join(META_DIR, "events"))
        .filter(e => new Date(e.timestamp) > cutoff)
        .filter(e => !project || e.project === project)
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Memories created/archived
      const allMems = listJSON(path.join(META_DIR, "memory"));
      const newMems = allMems
        .filter(m => new Date(m.created) > cutoff)
        .filter(m => !project || m.project === project);
      const archivedMems = allMems
        .filter(m => m.archived && m.archived_at && new Date(m.archived_at) > cutoff)
        .filter(m => !project || m.project === project);

      // Workflow runs
      const runDir = path.join(META_DIR, "workflow_runs");
      const runs = fs.existsSync(runDir)
        ? listJSON(runDir).filter(r => new Date(r.started_at) > cutoff).filter(r => !project || r.project === project)
        : [];

      // Tasks changed
      const tasks = listJSON(path.join(META_DIR, "tasks"))
        .filter(t => !project || t.project === project);
      const recentTasks = tasks.filter(t =>
        (t.updated && new Date(t.updated) > cutoff) ||
        new Date(t.created) > cutoff
      );

      // Build timeline
      const timeline = [];

      for (const e of events) {
        timeline.push({ time: e.timestamp, category: "event", detail: `[${e.type}] ${e.source}${e.project ? ` (${e.project})` : ""}` });
      }
      for (const m of newMems) {
        timeline.push({ time: m.created, category: "memory", detail: `New ${m.type}: ${m.content?.slice(0, 80)}...` });
      }
      for (const m of archivedMems) {
        timeline.push({ time: m.archived_at, category: "archive", detail: `Archived ${m.type}: ${m.content?.slice(0, 60)}...` });
      }
      for (const r of runs) {
        timeline.push({ time: r.started_at, category: "workflow", detail: `Workflow ${r.workflow_name || r.workflow_id} → ${r.status}` });
      }

      timeline.sort((a, b) => new Date(a.time) - new Date(b.time));

      return textResult({
        period: `Last ${hours || 24} hours`,
        ...(project ? { project } : {}),
        summary: {
          events: events.length,
          new_memories: newMems.length,
          archived_memories: archivedMems.length,
          workflow_runs: runs.length,
          task_changes: recentTasks.length,
        },
        timeline: timeline.slice(-50).map(t => ({
          time: new Date(t.time).toLocaleString(),
          category: t.category,
          detail: t.detail,
        })),
      });
    },
  );

  return server;
}

// ══════════════════════════════════════════════════════════════
//  SEED DEFAULT SKILLS
// ══════════════════════════════════════════════════════════════
function seedDefaults() {
  const skillsDir = path.join(META_DIR, "skills");

  const defaults = [
    {
      id: "deploy-par",
      name: "Deploy PAR",
      description:
        "Deploy PAR changes to your server via rsync + docker compose",
      type: "knowledge",
      tags: ["deploy", "docker", "devops"],
      instructions: `# Deploy PAR

## Steps

1. **Sync files to the server** (excluding node_modules):
\`\`\`bash
rsync -avz --exclude='node_modules' ./par/ yourserver:/opt/par/
\`\`\`

2. **Rebuild and restart containers**:
\`\`\`bash
ssh yourserver 'cd /opt/par && docker compose up -d --build 2>&1 | tail -20'
\`\`\`

3. **Verify all services are healthy**:
\`\`\`bash
ssh yourserver 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"' && echo "---" && curl -s http://localhost:3100/health && echo && curl -s http://localhost:3200/health
\`\`\`

## Notes
- Your deployment server
- Meta storage persists at /opt/par/meta on the host
- Watchtower handles automatic image updates (daily)
`,
      script: null,
    },
    {
      id: "conversation-handoff",
      name: "Conversation Handoff",
      description: "How to persist context between AI conversations using the meta store",
      type: "knowledge",
      tags: ["workflow", "context", "meta"],
      instructions: `# Conversation Handoff

Use this skill to preserve important context when ending a conversation so the next conversation can pick up seamlessly.

## At End of Conversation

Store key decisions, progress, and next steps:

1. Use \`meta_store\` with key \`handoff/<project-id>\` to save:
   - What was accomplished
   - Key decisions made  
   - Current blockers
   - Immediate next steps
   - Any important file paths or references

2. If there are open tasks, use \`task_add\` to persist them.

## At Start of New Conversation

1. Use \`meta_retrieve\` with key \`handoff/<project-id>\` to load context
2. Use \`task_list\` with the project filter to see pending work
3. Use \`project_get\` to review project details

## Example Handoff

\`\`\`
meta_store(
  key: "handoff/example-project",
  value: JSON.stringify({
    summary: "Implemented skeletal rigging for Knight class",
    decisions: ["Using hierarchical bone system", "10fps target"],
    nextSteps: ["Implement IK solver", "Add Sorcerer class rig"],
    files: ["src/rigger.py", "src/animations/knight.json"]
  })
)
\`\`\`
`,
      script: null,
    },
    {
      id: "project-onboard",
      name: "Project Onboarding",
      description: "Register a new project in the system with full tracking setup",
      type: "knowledge",
      tags: ["workflow", "setup", "projects"],
      instructions: `# Project Onboarding

When starting work on a new or existing project, register it in the system for cross-conversation tracking.

## Steps

1. **Register the project**:
\`\`\`
project_register(
  id: "my-project",
  name: "My Project",
  path: "/path/to/my-project",
  description: "What this project does",
  stack: "python,fastapi,docker",
  status: "active",
  repo: "https://github.com/user/my-project"
)
\`\`\`

2. **Add initial tasks** for known work items:
\`\`\`
task_add(project: "my-project", title: "Set up CI/CD", priority: "high")
task_add(project: "my-project", title: "Write tests", priority: "medium")
\`\`\`

3. **Save any reusable patterns** discovered during setup:
\`\`\`
snippet_save(
  title: "Project dev server command",
  content: "npm run dev -- --port 3000",
  language: "bash",
  tags: "my-project,dev"
)
\`\`\`

4. **Store initial handoff context** so the next conversation has context:
\`\`\`
meta_store(key: "handoff/my-project", value: "Initial setup complete. Ready for development.")
\`\`\`
`,
      script: null,
    },
    {
      id: "health-check",
      name: "Infrastructure Health Check",
      description: "Check the health of all PAR services",
      type: "execution",
      tags: ["devops", "monitoring", "health"],
      instructions: `# Infrastructure Health Check

Run this skill to verify all PAR services are operational.

The script checks:
- MCP Gateway (port 3100)
- Meta Store API (port 3200)
- Storage directory status
`,
      script: `#!/bin/bash
echo "=== PAR Health Check ==="
echo ""
echo "MCP Gateway:"
curl -s http://localhost:3100/health 2>/dev/null || echo "  ✗ UNREACHABLE"
echo ""
echo "Meta Store:"
curl -s http://localhost:3200/health 2>/dev/null || echo "  ✗ UNREACHABLE"
echo ""
echo "Storage:"
echo "  Projects: $(ls -1 /data/meta/projects/*.json 2>/dev/null | wc -l) registered"
echo "  Tasks:    $(ls -1 /data/meta/tasks/*.json 2>/dev/null | wc -l) total"
echo "  Skills:   $(ls -1 /data/meta/skills/*.json 2>/dev/null | wc -l) available"
echo "  Snippets: $(ls -1 /data/meta/snippets/*.json 2>/dev/null | wc -l) saved"
echo ""
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
`,
    },
    {
      id: "experiment-runner",
      name: "Model Experiment Runner",
      description: "Standardized workflow for tracking and evaluating model training experiments",
      type: "knowledge",
      tags: ["ml", "models", "workflow"],
      instructions: `# Model Experiment Runner

When tasked with running a machine learning experiment or evaluating a model, enforce rigorous tracking.

## Steps

1. **Parameterize the run**: Ensure all hyperparameters (learning rate, batch size, seed) are extracted into an explicit config file before starting.
2. **Execute the run**:
   - Run the training process in a detached or logged process.
   - Use standard tools (Weights & Biases, MLflow, or a local JSON metrics logger) to capture loss and accuracy per epoch.
3. **Evaluate**: Execute a standardized evaluation script against holdout/adversarial datasets.
4. **Persist the results back to PAR**:
   - Save the best metrics to the project's meta store or tasks.
   - Example: \\\`meta_store("experiments/\${project_id}/run_\${timestamp}", ...)\\\`
`,
      script: null,
    },
    {
      id: "deep-code-audit",
      name: "Deep Code Audit",
      description: "Automated gatekeeper process to guarantee SOTA code quality and security",
      type: "knowledge",
      tags: ["quality", "security", "workflow"],
      instructions: `# Deep Code Audit

When tasked with preparing a codebase for a SOTA release, run this comprehensive audit.

## Steps

1. **Static Analysis**: Run the industry-standard linter for the stack (e.g. \\\`pylint\\\`, \\\`eslint\\\`, \\\`clippy\\\`). Fix all warnings.
2. **Cyclomatic Complexity**: Use automated tools to enforce low cognitive limits on all functions. If a function is too complex, refactor it.
3. **Memory & Performance**: Profile crucial execution paths. If memory leaks are possible (e.g., C/C++), run Valgrind.
4. **Security Scan**: Check dependencies for known CVEs. Check for SQL injection, proper API key obfuscation, and input validation.
5. **Report**: Generate an artifact summarizing the audit results and any remaining architectural debt.
`,
      script: null,
    },
  ];

  for (const skill of defaults) {
    const filePath = path.join(skillsDir, `${skill.id}.json`);
    if (!fs.existsSync(filePath)) {
      skill.created = new Date().toISOString();
      skill.updated = new Date().toISOString();
      writeJSON(filePath, skill);
      console.log(`  Seeded skill: ${skill.id}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  EXPRESS + TRANSPORT SETUP
// ══════════════════════════════════════════════════════════════
const app = express();

// ── Security: CORS (restrict origins) ─────────────────────────
const CORS_ORIGINS = process.env.MCP_CORS_ORIGINS
  ? process.env.MCP_CORS_ORIGINS.split(",").map(s => s.trim())
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
  const sorted = [..._toolCalls.entries()].sort((a, b) => b[1] - a[1]);
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

  const tags = (req.query.tags || "").split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
  const maxDim = parseInt(req.query.max_size) || 512;
  const minDim = parseInt(req.query.min_size) || 16;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  if (!tags.length) {
    return res.json({ count: 0, results: [], error: "No tags provided" });
  }

  let results = index.filter(entry => {
    const entryTags = (entry.tags || []).map(t => t.toLowerCase());
    if (!tags.every(st => entryTags.includes(st))) return false;
    const dim = Math.max(entry.width || 0, entry.height || 0);
    return dim >= minDim && dim <= maxDim;
  });

  results.sort((a, b) => {
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
        steps: wf.steps.map(s => ({ ...s, status: "pending" })),
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
const streamableTransports = {};

app.post("/mcp", express.json(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

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
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && streamableTransports[sessionId]) {
    await streamableTransports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "Invalid or missing session ID" });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && streamableTransports[sessionId]) {
    await streamableTransports[sessionId].handleRequest(req, res);
    delete streamableTransports[sessionId];
    return;
  }
  res.status(400).json({ error: "Invalid or missing session ID" });
});

// ── Legacy SSE Transport (backward compat) ───────────────────
const sseTransports = {};

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
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

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
  console.log(`✅ Ready`);

  // Pre-warm embedding model (async, non-blocking)
  embed("warmup").then(() => {
    console.log(`🧠 Embedding model: ${isSemanticReady() ? "all-MiniLM-L6-v2 ✓" : "keyword fallback"}`);
    const memCount = fs.readdirSync(path.join(META_DIR, "memory")).filter(f => f.endsWith(".json")).length;
    const kgCount = fs.existsSync(path.join(META_DIR, "knowledge")) ? fs.readdirSync(path.join(META_DIR, "knowledge")).filter(f => f.startsWith("entity__")).length : 0;
    console.log(`📊 Memories: ${memCount} | KG Entities: ${kgCount}`);
  }).catch(() => {});

  // ── Scheduled Consolidation (every 6 hours) ──────────────
  const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const CONSOLIDATION_THRESHOLD = 200; // only consolidate if project has >200 active memories

  setInterval(async () => {
    try {
      const memDir = path.join(META_DIR, "memory");
      const allMems = listJSON(memDir).filter(m => m.embedding && !m.archived);

      // Group by project
      const byProject = {};
      for (const m of allMems) {
        const p = m.project || "_unscoped";
        byProject[p] = (byProject[p] || 0) + 1;
      }

      for (const [proj, count] of Object.entries(byProject)) {
        if (count < CONSOLIDATION_THRESHOLD) continue;

        console.log(`🌙 Auto-consolidation triggered for "${proj}" (${count} active memories)`);

        // Run consolidation with conservative defaults
        const projMems = allMems.filter(m => m.project === proj);
        const threshold = 0.78; // slightly higher than manual default for safety
        const minSize = 4;
        const used = new Set();
        const clusters = [];

        for (let i = 0; i < projMems.length; i++) {
          if (used.has(projMems[i].id)) continue;
          const cluster = [projMems[i]];
          used.add(projMems[i].id);
          for (let j = i + 1; j < projMems.length; j++) {
            if (used.has(projMems[j].id)) continue;
            const sim = cosineSimilarity(projMems[i].embedding, projMems[j].embedding);
            if (sim >= threshold) { cluster.push(projMems[j]); used.add(projMems[j].id); }
          }
          if (cluster.length >= minSize) clusters.push(cluster);
        }

        for (const cluster of clusters) {
          const combinedContent = cluster.map(m => `[${m.type}] ${m.content}`).join("\n\n");
          const types = [...new Set(cluster.map(m => m.type))];
          const tags = [...new Set(cluster.flatMap(m => m.tags || []))];
          const distilled = `[AUTO-CONSOLIDATED from ${cluster.length} ${types.join("/")} memories]\n\n${combinedContent}`;
          const distilledEmbed = await embed(distilled);
          const consolidatedId = randomUUID();
          writeJSON(path.join(memDir, `${consolidatedId}.json`), {
            id: consolidatedId, type: types.length === 1 ? types[0] : "insight",
            content: distilled, project: proj, tags: [...tags, "auto-consolidated"],
            refs: cluster.map(m => m.id), embedding: distilledEmbed,
            consolidated_from: cluster.length, created: new Date().toISOString(),
          });
          for (const mem of cluster) {
            mem.archived = true; mem.archived_at = new Date().toISOString();
            mem.consolidated_into = consolidatedId;
            writeJSON(path.join(memDir, `${mem.id}.json`), mem);
          }
        }

        if (clusters.length > 0) {
          memoryIndex = null; // invalidate vector index
          const archived = clusters.reduce((sum, c) => sum + c.length, 0);
          console.log(`🌙 Consolidated ${clusters.length} cluster(s), archived ${archived} memories for "${proj}"`);

          // Incremental KG extraction from consolidated memories
          let kgEntities = 0, kgRels = 0;
          try {
            for (const cluster of clusters) {
              const combinedText = cluster.map(m => m.content).join("\n\n");
              const kg = extractKG(combinedText, proj, `auto-consolidation-${new Date().toISOString().split("T")[0]}`);
              kgEntities += kg.entities.length;
              kgRels += kg.relationships.length;
            }
            if (kgEntities > 0) console.log(`🌙 KG enriched: +${kgEntities} entities, +${kgRels} relationships for "${proj}"`);
          } catch (kgErr) {
            console.error(`🌙 KG extraction error during consolidation: ${kgErr.message}`);
          }

          // Emit event
          const eventId = randomUUID().slice(0, 8);
          writeJSON(path.join(META_DIR, "events", `${eventId}.json`), {
            id: eventId, type: "memory.auto_consolidated", source: "scheduler",
            project: proj, payload: { clusters: clusters.length, archived, kg_entities: kgEntities, kg_relationships: kgRels },
            severity: "info", timestamp: new Date().toISOString(), consumed_by: [],
          });
        }
      }
    } catch (err) {
      console.error(`🌙 Auto-consolidation error: ${err.message}`);
    }

    // ── Automated Retention Sweep ──────────────────────────────
    try {
      const RETENTION_MAX_AGE_DAYS = 90;
      const RETENTION_PROTECTED_TYPES = ["decision", "handoff"];
      const cutoff = new Date(Date.now() - RETENTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
      const memDir = path.join(META_DIR, "memory");

      const retainCandidates = listJSON(memDir).filter(m =>
        !m.archived && !m.consolidated_from && !m.pinned &&
        new Date(m.created) < cutoff &&
        !RETENTION_PROTECTED_TYPES.includes(m.type)
      );

      if (retainCandidates.length > 0) {
        for (const mem of retainCandidates) {
          mem.archived = true;
          mem.archived_at = new Date().toISOString();
          mem.archived_by = "retention_scheduler";
          mem.retention_rule = { max_age_days: RETENTION_MAX_AGE_DAYS, applied: new Date().toISOString() };
          writeJSON(path.join(memDir, `${mem.id}.json`), mem);
        }
        memoryIndex = null;
        console.log(`🌙 Retention sweep: archived ${retainCandidates.length} memories older than ${RETENTION_MAX_AGE_DAYS} days`);

        const eventId = randomUUID().slice(0, 8);
        writeJSON(path.join(META_DIR, "events", `${eventId}.json`), {
          id: eventId, type: "memory.retention_sweep", source: "scheduler",
          payload: { archived: retainCandidates.length, max_age_days: RETENTION_MAX_AGE_DAYS },
          severity: "info", timestamp: new Date().toISOString(), consumed_by: [],
        });
      }
    } catch (retErr) {
      console.error(`🌙 Retention sweep error: ${retErr.message}`);
    }
  }, CONSOLIDATION_INTERVAL_MS);

  // ── Heartbeat (every 15 minutes) ─────────────────────────────
  const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(() => {
    try {
      const memDir = path.join(META_DIR, "memory");
      const activeMemories = listJSON(memDir).filter(m => !m.archived).length;
      const totalCalls = [..._toolCalls.values()].reduce((a, b) => a + b, 0);
      const uptimeS = Math.round((Date.now() - _bootTime) / 1000);

      const heartbeatId = randomUUID().slice(0, 8);
      writeJSON(path.join(META_DIR, "events", `${heartbeatId}.json`), {
        id: heartbeatId, type: "system.heartbeat", source: "scheduler",
        payload: {
          uptime_s: uptimeS,
          active_memories: activeMemories,
          tool_calls_total: totalCalls,
          unique_tools_used: _toolCalls.size,
          heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
        severity: "info", timestamp: new Date().toISOString(), consumed_by: [],
      });
      console.log(`💓 Heartbeat: uptime=${uptimeS}s, memories=${activeMemories}, calls=${totalCalls}`);
    } catch (hbErr) {
      console.error(`💓 Heartbeat error: ${hbErr.message}`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // ── Seed Workflow Templates ──────────────────────────────────
  const wfDir = path.join(META_DIR, "workflows");
  const templates = [
    {
      id: "deploy-par", name: "Deploy PAR",
      description: "Standard deployment pipeline: rsync → docker compose → health check",
      steps: [
        { id: "sync", name: "Rsync to Server", action: "rsync -avz --exclude=node_modules . yourserver:/opt/par/" },
        { id: "build", name: "Docker Compose Build", action: "ssh yourserver 'cd /opt/par && docker compose up -d --build'" },
        { id: "health", name: "Health Check", action: "curl -s http://localhost:3100/health" },
        { id: "verify", name: "Verify Version", action: "check response.version matches expected" },
      ],
      trigger: { event_type: "deploy.requested" },
      created: new Date().toISOString(),
    },
    {
      id: "memory-maintenance", name: "Memory Maintenance",
      description: "Full memory hygiene cycle: stats → consolidate (dry_run) → consolidate → retain (dry_run) → retain",
      steps: [
        { id: "stats", name: "Memory Stats", action: "memory_stats()" },
        { id: "consolidate-preview", name: "Preview Consolidation", action: "memory_consolidate(project, dry_run=true)" },
        { id: "consolidate", name: "Execute Consolidation", action: "memory_consolidate(project)" },
        { id: "retain-preview", name: "Preview Retention", action: "memory_retain(max_age_days=90, dry_run=true)" },
        { id: "retain", name: "Execute Retention", action: "memory_retain(max_age_days=90)" },
      ],
      trigger: { event_type: "maintenance.requested" },
      created: new Date().toISOString(),
    },
    {
      id: "agent-onboard", name: "Agent Onboarding",
      description: "Register and initialize a new agent in the PAR",
      steps: [
        { id: "register", name: "Register Agent", action: "agent_register(id, name, role, capabilities)" },
        { id: "subscribe", name: "Subscribe to Events", action: "event_subscribe(subscriber=agent_id, type_pattern=relevant_pattern)" },
        { id: "context", name: "Load Context", action: "context_load(project, depth='deep')" },
        { id: "handoff", name: "Receive Handoff", action: "Check for pending agent_handoff memories" },
      ],
      trigger: { event_type: "agent.onboard" },
      created: new Date().toISOString(),
    },
  ];

  for (const tmpl of templates) {
    const wfPath = path.join(wfDir, `${tmpl.id}.json`);
    if (!readJSON(wfPath)) {
      writeJSON(wfPath, tmpl);
    }
  }

  console.log(`🌙 Consolidation + retention: every 6h (threshold: ${CONSOLIDATION_THRESHOLD} memories, retention: 90 days)`);
  console.log(`💓 Heartbeat: every 15min`);
});
