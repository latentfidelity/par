/**
 * Agent tools: agent_register, agent_list, agent_get, agent_update,
 * system_health, memory_consolidate
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, DIRS, readJSON, writeJSON, listJSON, textResult, errorResult } from "../lib/storage.js";
import { embed, cosineSimilarity, getEmbeddingStatus, isSemanticReady } from "../lib/embedder.js";
import type { MemoryEntry } from "./context.js";

export function registerAgentTools(
  server: McpServer,
  getMemoryIndex: () => MemoryEntry[] | null,
  setMemoryIndex: (idx: MemoryEntry[] | null) => void,
) {
  // ┌─────────────────────────────────────────────────────────┐
  // │  AGENT REGISTRY                                          │
  // └─────────────────────────────────────────────────────────┘

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
  // │  SYSTEM HEALTH                                           │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "system_health",
    "One-shot infrastructure health check. Returns status of all services, memory stats, disk usage, and container health. Use this instead of manually curling endpoints.",
    {},
    async () => {
      const embeddingStatus = getEmbeddingStatus();
      const health: Record<string, any> = {
        timestamp: new Date().toISOString(),
        services: {} as Record<string, any>,
        storage: {} as Record<string, any>,
        memory: {} as Record<string, any>,
      };

      // MCP Gateway (self)
      health.services.mcp_gateway = {
        status: "healthy",
        version: "7.0.0",
        uptime: process.uptime(),
        embedding_model: embeddingStatus.ready ? `${embeddingStatus.model} (semantic)` : "fallback (keyword)",
        retrieval_strategy: "hybrid",
        embedding_cache_entries: embeddingStatus.cache_entries,
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
      const byType: Record<string, number> = {};
      const byProject: Record<string, number> = {};
      for (const m of memories) {
        byType[m.type] = (byType[m.type] || 0) + 1;
        if (m.project) byProject[m.project] = (byProject[m.project] || 0) + 1;
      }
      const activeMemories = memories.filter((m) => !m.archived);
      const embeddedActive = activeMemories.filter((m) => Array.isArray(m.embedding) && m.embedding.length > 0);
      health.memory = {
        total: memories.length,
        active: activeMemories.length,
        by_type: byType,
        by_project: byProject,
        embedding_coverage: `${embeddedActive.length}/${activeMemories.length || 0}`,
      };

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
  // │  MEMORY CONSOLIDATION                                    │
  // └─────────────────────────────────────────────────────────┘

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
      setMemoryIndex(null);

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

}
