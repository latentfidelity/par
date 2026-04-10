/**
 * PAR Knowledge Graph — Entity and relationship extraction + persistence.
 *
 * Extracts entities (projects, tools, technologies, versions) from text,
 * builds co-occurrence relationships, and persists to the KG store.
 */
import path from "path";
import { META_DIR, readJSON, writeJSON, listJSON } from "./storage.js";

export function extractKG(text: string, project?: string, sourceId?: string) {
  const entities = new Map<string, any>();
  const relationships: any[] = [];

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
