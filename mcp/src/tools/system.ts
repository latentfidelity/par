/**
 * System tools: context_load, system_health, file_index, experiment_log, snippet_update
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, DIRS, readJSON, writeJSON, listJSON, safePath, textResult, errorResult, errorMessage } from "../lib/storage.js";
import { embed, cosineSimilarity, isSemanticReady } from "../lib/embedder.js";
import { type MemoryEntry, loadMemoryIndex as _loadIndex } from "./context.js";

export function registerSystemTools(
  server: McpServer,
  getMemoryIndex: () => MemoryEntry[] | null,
  setMemoryIndex: (idx: MemoryEntry[] | null) => void,
) {
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
      const result: Record<string, any> = {};

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
          return (prio[a.priority as keyof typeof prio] || 2) - (prio[b.priority as keyof typeof prio] || 2);
        });
      result.tasks = openTasks.map((t: any) => ({
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
              s.tags.some((t: string) => t.toLowerCase().includes(q)),
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
          .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
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
          .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
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
          if (!getMemoryIndex()) await _loadIndex(getMemoryIndex, setMemoryIndex);
          const queryVec = await embed(query);
          const relevantMems = getMemoryIndex()!
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
          .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
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
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
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
      const langCount: Record<string, number> = {};
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

      if (candidates.length > 0) setMemoryIndex(null);

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

}
