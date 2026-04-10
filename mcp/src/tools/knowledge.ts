/**
 * Knowledge tools: knowledge_extract, knowledge_query, knowledge_context,
 * knowledge_ingest, knowledge_merge
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, readJSON, writeJSON, listJSON, textResult, errorResult, errorMessage } from "../lib/storage.js";
import { embed, cosineSimilarity, isSemanticReady } from "../lib/embedder.js";
import { extractKG } from "../lib/knowledge.js";

export function registerKnowledgeTools(server: McpServer) {
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

      const result: Record<string, any> = {
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
          .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
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
      const findEntity = (id: string) => {
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
}
