/**
 * Memory tools: memory_store, memory_search, memory_search_advanced, memory_log,
 * memory_pin, memory_unpin, memory_tag, memory_stats, memory_timeline, memory_audit
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, safeId, readJSON, writeJSON, listJSON, textResult, errorResult } from "../lib/storage.js";
import { embed, cosineSimilarity, EMBEDDING_DIM, getEmbeddingStatus, isSemanticReady } from "../lib/embedder.js";
import { retrieveMemories } from "../lib/retrieval.js";
import { type MemoryEntry, loadMemoryIndex as _loadIndex } from "./context.js";
import { runEpistemicAudit, detectConflict } from "../lib/epistemic.js";

export function registerMemoryTools(
  server: McpServer,
  getMemoryIndex: () => MemoryEntry[] | null,
  setMemoryIndex: (idx: MemoryEntry[] | null) => void,
) {
  // ┌─────────────────────────────────────────────────────────┐
  // │  SEMANTIC MEMORY                                        │
  // └─────────────────────────────────────────────────────────┘

  // In-memory vector index (module-scoped, shared across sessions)
  // (declared at module level so schedulers can invalidate it)

  const loadMemoryIndex = () => _loadIndex(getMemoryIndex, setMemoryIndex);

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
      const embeddingStatus = getEmbeddingStatus();
      const memory = {
        id,
        type,
        content,
        project: project || null,
        tags: tags ? tags.split(",").map((t) => t.trim()) : [],
        refs: refs ? refs.split(",").map((r) => r.trim()) : [],
        embedding,
        embedding_model: embeddingStatus.model,
        embedding_updated: new Date().toISOString(),
        created: new Date().toISOString(),
      };

      writeJSON(path.join(META_DIR, "memory", `${id}.json`), memory);

      // Update in-memory index
      const currentIdx = getMemoryIndex(); if (currentIdx) {
        currentIdx.push({
          id: memory.id,
          type: memory.type,
          content: memory.content,
          project: memory.project,
          tags: memory.tags,
          created: memory.created,
          embedding: memory.embedding,
          archived: false,
          pinned: false,
          refs: memory.refs,
        });
      }

      // ── Proactive contradiction check (harness engineering pattern) ──
      // Lightweight: compare against top-5 most similar existing memories
      // for version/numeric/polarity conflicts. Warns but does not block.
      const warnings: string[] = [];
      try {
        if (!getMemoryIndex()) await loadMemoryIndex();
        const idx = getMemoryIndex();
        if (idx && idx.length > 1) {
          const candidates = idx
            .filter(m => m.id !== id && !m.archived && (!project || m.project === project))
            .map(m => ({ ...m, sim: cosineSimilarity(embedding, m.embedding) }))
            .filter(m => m.sim >= 0.55 && m.sim <= 0.90)
            .sort((a, b) => b.sim - a.sim)
            .slice(0, 5);

          for (const candidate of candidates) {
            const conflict = detectConflict(
              { content, created: memory.created },
              { content: candidate.content, created: candidate.created },
            );
            if (conflict) {
              warnings.push(`⚠️ ${conflict} (vs memory ${candidate.id.slice(0, 8)}…, similarity ${Math.round(candidate.sim * 100)}%)`);
            }
          }
        }
      } catch { /* non-fatal — store succeeds regardless */ }

      return textResult({
        stored: id,
        type,
        project,
        semantic: isSemanticReady(),
        ...(warnings.length > 0 ? { epistemic_warnings: warnings } : {}),
      });
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
      strategy: z.enum(["semantic", "lexical", "hybrid"]).optional().describe("Retrieval strategy (default hybrid)"),
      include_archived: z.boolean().optional().describe("Include archived memories (default false)"),
      min_score: z.number().optional().describe("Minimum retrieval score threshold (0-1)"),
      diagnostics: z.boolean().optional().describe("Include score components for each result"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ query, project, type, strategy, include_archived, min_score, diagnostics, limit }) => {
      if (!getMemoryIndex()) await loadMemoryIndex();
      if (getMemoryIndex()!.length === 0) return textResult("No memories stored yet.");

      const results = await retrieveMemories({
        query,
        memories: getMemoryIndex()!,
        project,
        type,
        strategy: strategy || "hybrid",
        includeArchived: include_archived,
        minScore: min_score,
        limit: Math.min(limit || 10, 50),
        diverse: true,
      });

      return textResult({
        query,
        mode: getEmbeddingStatus().ready ? (strategy || "hybrid") : "lexical",
        semantic_ready: isSemanticReady(),
        count: results.length,
        results: results.map((m) => ({
          id: m.memory.id,
          score: m.score,
          type: m.memory.type,
          project: m.memory.project,
          content: m.memory.content,
          tags: m.memory.tags,
          created: m.memory.created,
          ...(diagnostics ? { retrieval: m.components } : {}),
        })),
        ...(diagnostics ? {
          diagnostics: {
            strategy: strategy || "hybrid",
            diverse_ranking: true,
            include_archived: !!include_archived,
          },
        } : {}),
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
      include_archived: z.boolean().optional().describe("Include archived memories (default false)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ project, type, include_archived, limit }) => {
      const memDir = path.join(META_DIR, "memory");
      let entries = listJSON(memDir);

      if (!include_archived) entries = entries.filter((m) => !m.archived);
      if (project) entries = entries.filter((m) => m.project === project);
      if (type) entries = entries.filter((m) => m.type === type);

      entries.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
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
      results.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
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
      const pinned = active.filter(m => m.pinned);

      // By type
      const byType: Record<string, number> = {};
      for (const m of active) { byType[m.type || "unknown"] = (byType[m.type || "unknown"] || 0) + 1; }

      // By project
      const byProject: Record<string, number> = {};
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
      const tagged = active.filter(m => (m.tags || []).length > 0).length;
      const embeddingModels: Record<string, number> = {};
      for (const m of active.filter((entry) => entry.embedding)) {
        const label = m.embedding_model || "unknown";
        embeddingModels[label] = (embeddingModels[label] || 0) + 1;
      }
      const index = getMemoryIndex() || [];
      const indexedActive = index.filter((m) => !m.archived).length;
      const indexedArchived = index.filter((m) => m.archived).length;
      const embeddingStatus = getEmbeddingStatus();

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
        pinned: pinned.length,
        by_type: byType,
        by_project: byProject,
        age_distribution: ageGroups,
        embedding_coverage: `${withEmbedding}/${active.length} (${active.length > 0 ? Math.round(withEmbedding / active.length * 100) : 0}%)`,
        tag_coverage: `${tagged}/${active.length} (${active.length > 0 ? Math.round(tagged / active.length * 100) : 0}%)`,
        archived_ratio: all.length > 0 ? Math.round((archived.length / all.length) * 1000) / 1000 : 0,
        embedding_models: embeddingModels,
        knowledge_graph: { entities: kgEntities, relationships: kgRelationships },
        retrieval: {
          default_strategy: "hybrid",
          semantic_ready: embeddingStatus.ready,
          embedding_model: embeddingStatus.model,
          embedding_cache_entries: embeddingStatus.cache_entries,
        },
        vector_index: getMemoryIndex()
          ? `loaded (${index.length} entries: ${indexedActive} active, ${indexedArchived} archived)`
          : "not loaded",
      });
    },
  );

  server.tool(
    "memory_backfill_embeddings",
    "Backfill or refresh memory embeddings. Use this after imports, model changes, or when embedding coverage drops below target.",
    {
      project: z.string().optional().describe("Filter to a specific project"),
      type: z.enum(["decision", "insight", "task", "handoff", "observation"]).optional().describe("Filter by type"),
      include_archived: z.boolean().optional().describe("Include archived memories (default false)"),
      force: z.boolean().optional().describe("Recompute embeddings even when one already exists"),
      dry_run: z.boolean().optional().describe("Preview the candidate set without rewriting memories (default true)"),
      limit: z.number().optional().describe("Maximum memories to process (default 100)"),
    },
    async ({ project, type, include_archived, force, dry_run, limit }) => {
      const memDir = path.join(META_DIR, "memory");
      const maxResults = Math.min(limit || 100, 1000);
      const isDryRun = dry_run !== false;

      let targets = listJSON(memDir);
      if (!include_archived) targets = targets.filter((m) => !m.archived);
      if (project) targets = targets.filter((m) => m.project === project);
      if (type) targets = targets.filter((m) => m.type === type);

      targets = targets
        .filter((m) => force || !Array.isArray(m.embedding) || m.embedding.length !== EMBEDDING_DIM || !m.embedding_model)
        .sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

      const selected = targets.slice(0, maxResults);
      if (isDryRun) {
        return textResult({
          mode: "dry_run",
          candidates: targets.length,
          selected: selected.length,
          force: !!force,
          preview: selected.slice(0, 10).map((m) => ({
            id: m.id,
            type: m.type,
            project: m.project,
            has_embedding: Array.isArray(m.embedding) && m.embedding.length > 0,
            embedding_dim: Array.isArray(m.embedding) ? m.embedding.length : 0,
            embedding_model: m.embedding_model || null,
            created: m.created,
          })),
        });
      }

      let updated = 0;
      for (const memory of selected) {
        memory.embedding = await embed(memory.content);
        memory.embedding_model = getEmbeddingStatus().model;
        memory.embedding_updated = new Date().toISOString();
        writeJSON(path.join(memDir, `${memory.id}.json`), memory);
        updated++;
      }

      if (updated > 0) setMemoryIndex(null);

      return textResult({
        mode: "executed",
        updated,
        remaining_candidates: Math.max(0, targets.length - selected.length),
        embedding_model: getEmbeddingStatus().model,
        dimensions: EMBEDDING_DIM,
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
          newTags = existing.filter((t: string) => !tagList.includes(t));
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
      function parseNaturalDate(str: string | undefined) {
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
      if (query) {
        const retrieved = await retrieveMemories({
          query,
          memories,
          project,
          type,
          strategy: "hybrid",
          minScore: 0.15,
          limit: maxResults,
          diverse: true,
        });
        memories = retrieved.map((result) => ({
          ...result.memory,
          relevance: result.score,
          retrieval: result.components,
        }));
      }

      memories.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
      memories = memories.slice(0, maxResults);

      // Group results
      const groupMode = group_by || "day";
      const groups: Record<string, any[]> = {};

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
  // │  EPISTEMIC TRUTH LOOP (v7.1)                             │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "memory_audit",
    "Run the epistemic truth loop: scan for contradictions between memories, stale claims superseded by newer data, and orphaned KG entities. Returns structured findings with severity, explanation, and recommended action. Use to maintain knowledge integrity.",
    {
      project: z.string().optional().describe("Filter to a specific project (omit for all)"),
      dry_run: z.boolean().optional().describe("If true, report findings without modifying memories (default: true)"),
      max_pairs: z.number().optional().describe("Max pairwise comparisons for contradiction scan (default 15000)"),
    },
    async ({ project, dry_run, max_pairs }) => {
      const isDryRun = dry_run !== false; // default true for safety
      const audit = runEpistemicAudit({ project, maxPairs: max_pairs ?? 15_000 });

      if (!isDryRun && audit.findings.length > 0) {
        const memDir = path.join(META_DIR, "memory");
        let tagged = 0, autoArchived = 0;

        for (const finding of audit.findings) {
          for (const memId of finding.memory_ids) {
            const memPath = path.join(memDir, `${memId}.json`);
            const mem = readJSON(memPath);
            if (!mem || mem.archived || mem.pinned) continue;

            const tag = `epistemic:${finding.severity}`;
            const existingTags: string[] = mem.tags || [];
            if (!existingTags.includes(tag)) {
              mem.tags = [...existingTags, tag];
              writeJSON(memPath, mem);
              tagged++;
            }

            if (finding.action === "archive" && finding.severity === "stale" && !mem.pinned) {
              mem.archived = true;
              mem.archived_at = new Date().toISOString();
              mem.archived_by = "epistemic_audit";
              writeJSON(memPath, mem);
              autoArchived++;
            }
          }
        }

        if (autoArchived > 0) setMemoryIndex(null);

        // Emit event
        const eventId = randomUUID().slice(0, 8);
        writeJSON(path.join(META_DIR, "events", `${eventId}.json`), {
          id: eventId, type: "memory.epistemic_audit", source: "memory_audit_tool",
          project: project || null,
          payload: { ...audit.summary, tagged, auto_archived: autoArchived, duration_ms: audit.duration_ms },
          severity: audit.summary.contradictions > 0 ? "warn" : "info",
          timestamp: new Date().toISOString(),
          consumed_by: [],
        });

        return textResult({
          mode: "executed",
          ...audit.summary,
          scanned: audit.scanned,
          pairs_compared: audit.pairs_compared,
          tagged,
          auto_archived: autoArchived,
          findings: audit.findings.map(f => ({
            severity: f.severity,
            explanation: f.explanation,
            action: f.action,
            memory_ids: f.memory_ids,
            ...(f.similarity ? { similarity: f.similarity } : {}),
            ...(f.superseded_by ? { superseded_by: f.superseded_by } : {}),
            ...(f.broken_ref ? { broken_ref: f.broken_ref } : {}),
          })),
          duration_ms: audit.duration_ms,
        });
      }

      return textResult({
        mode: "dry_run",
        ...audit.summary,
        scanned: audit.scanned,
        pairs_compared: audit.pairs_compared,
        findings: audit.findings.map(f => ({
          severity: f.severity,
          explanation: f.explanation,
          action: f.action,
          memory_ids: f.memory_ids,
          ...(f.similarity ? { similarity: f.similarity } : {}),
          ...(f.superseded_by ? { superseded_by: f.superseded_by } : {}),
          ...(f.broken_ref ? { broken_ref: f.broken_ref } : {}),
        })),
        duration_ms: audit.duration_ms,
      });
    },
  );

}
