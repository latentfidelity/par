/**
 * Agent tools: system_health, memory_consolidate, knowledge_extract/query/ingest,
 * plus procedural memory and context bookmarks
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, DIRS, safeId, readJSON, writeJSON, listJSON, textResult, errorResult, errorMessage } from "../lib/storage.js";
import { embed, cosineSimilarity, isSemanticReady } from "../lib/embedder.js";
import { extractKG } from "../lib/knowledge.js";
import type { MemoryEntry } from "./context.js";

export function registerAgentTools(
  server: McpServer,
  getMemoryIndex: () => MemoryEntry[] | null,
  setMemoryIndex: (idx: MemoryEntry[] | null) => void,
) {
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
      const byType: Record<string, number> = {};
      const byProject: Record<string, number> = {};
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
      const graph = { center: entityData || { id: entity, type: "unknown" }, nodes: [] as any[], edges: [] as any[] };
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
        .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
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

}
