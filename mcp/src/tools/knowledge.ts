/**
 * Knowledge graph tools: knowledge_context, knowledge_extract, knowledge_query,
 * knowledge_ingest, knowledge_merge
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, readJSON, writeJSON, listJSON, textResult, errorResult, errorMessage } from "../lib/storage.js";
import { extractKG } from "../lib/knowledge.js";

export function registerKnowledgeTools(server: McpServer) {
  // ┌─────────────────────────────────────────────────────────┐
  // │  KNOWLEDGE CONTEXT (v6.0)                                │
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
  // │  KNOWLEDGE EXTRACTION (v4.0)                             │
  // └─────────────────────────────────────────────────────────┘

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

  // ┌─────────────────────────────────────────────────────────┐
  // │  KNOWLEDGE QUERY (v4.0)                                  │
  // └─────────────────────────────────────────────────────────┘

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

  // ┌─────────────────────────────────────────────────────────┐
  // │  KNOWLEDGE INGEST (v4.0)                                 │
  // └─────────────────────────────────────────────────────────┘

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
