/**
 * PAR Schedulers — Background tasks: consolidation, retention sweep, heartbeat.
 *
 * Each scheduler runs on a fixed interval after boot.
 * They share the module-scoped memoryIndex (set to null to invalidate).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { META_DIR, readJSON, writeJSON, listJSON, errorMessage } from "./lib/storage.js";
import { embed, cosineSimilarity } from "./lib/embedder.js";
import { extractKG } from "./lib/knowledge.js";

/** Module-level memoryIndex invalidator — call this from server.ts */
export type MemoryIndexInvalidator = () => void;

/** Telemetry counters injected by the caller. */
export interface TelemetryCtx {
  toolCalls: Map<string, number>;
  bootTime: number;
}

/**
 * Boot all scheduled tasks. Returns cleanup handles.
 */
export function startSchedulers(
  invalidateIndex: MemoryIndexInvalidator,
  telemetry: TelemetryCtx,
) {
  // ── Scheduled Consolidation (every 6 hours) ──────────────
  const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const CONSOLIDATION_THRESHOLD = 200;

  const consolidationTimer = setInterval(async () => {
    try {
      const memDir = path.join(META_DIR, "memory");
      const allMems = listJSON(memDir).filter(m => m.embedding && !m.archived);

      const byProject: Record<string, number> = {};
      for (const m of allMems) {
        const p = m.project || "_unscoped";
        byProject[p] = (byProject[p] || 0) + 1;
      }

      for (const [proj, count] of Object.entries(byProject)) {
        if (count < CONSOLIDATION_THRESHOLD) continue;

        console.log(`🌙 Auto-consolidation triggered for "${proj}" (${count} active memories)`);

        const projMems = allMems.filter(m => m.project === proj);
        const threshold = 0.78;
        const minSize = 4;
        const used = new Set<string>();
        const clusters: any[][] = [];

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
          invalidateIndex();
          const archived = clusters.reduce((sum, c) => sum + c.length, 0);
          console.log(`🌙 Consolidated ${clusters.length} cluster(s), archived ${archived} memories for "${proj}"`);

          let kgEntities = 0, kgRels = 0;
          try {
            for (const cluster of clusters) {
              const combinedText = cluster.map(m => m.content).join("\n\n");
              const kg = extractKG(combinedText, proj, `auto-consolidation-${new Date().toISOString().split("T")[0]}`);
              kgEntities += kg.entities.length;
              kgRels += kg.relationships.length;
            }
            if (kgEntities > 0) console.log(`🌙 KG enriched: +${kgEntities} entities, +${kgRels} relationships for "${proj}"`);
          } catch (kgErr: unknown) {
            console.error(`🌙 KG extraction error during consolidation: ${errorMessage(kgErr)}`);
          }

          const eventId = randomUUID().slice(0, 8);
          writeJSON(path.join(META_DIR, "events", `${eventId}.json`), {
            id: eventId, type: "memory.auto_consolidated", source: "scheduler",
            project: proj, payload: { clusters: clusters.length, archived, kg_entities: kgEntities, kg_relationships: kgRels },
            severity: "info", timestamp: new Date().toISOString(), consumed_by: [],
          });
        }
      }
    } catch (err: unknown) {
      console.error(`🌙 Auto-consolidation error: ${errorMessage(err)}`);
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
        invalidateIndex();
        console.log(`🌙 Retention sweep: archived ${retainCandidates.length} memories older than ${RETENTION_MAX_AGE_DAYS} days`);

        const eventId = randomUUID().slice(0, 8);
        writeJSON(path.join(META_DIR, "events", `${eventId}.json`), {
          id: eventId, type: "memory.retention_sweep", source: "scheduler",
          payload: { archived: retainCandidates.length, max_age_days: RETENTION_MAX_AGE_DAYS },
          severity: "info", timestamp: new Date().toISOString(), consumed_by: [],
        });
      }
    } catch (retErr: unknown) {
      console.error(`🌙 Retention sweep error: ${errorMessage(retErr)}`);
    }
  }, CONSOLIDATION_INTERVAL_MS);

  // ── Heartbeat (every 15 minutes) ─────────────────────────────
  const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
  const heartbeatTimer = setInterval(() => {
    try {
      const memDir = path.join(META_DIR, "memory");
      const activeMemories = listJSON(memDir).filter(m => !m.archived).length;
      const totalCalls = [...telemetry.toolCalls.values()].reduce((a, b) => a + b, 0);
      const uptimeS = Math.round((Date.now() - telemetry.bootTime) / 1000);

      const heartbeatId = randomUUID().slice(0, 8);
      writeJSON(path.join(META_DIR, "events", `${heartbeatId}.json`), {
        id: heartbeatId, type: "system.heartbeat", source: "scheduler",
        payload: {
          uptime_s: uptimeS,
          active_memories: activeMemories,
          tool_calls_total: totalCalls,
          unique_tools_used: telemetry.toolCalls.size,
          heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
        severity: "info", timestamp: new Date().toISOString(), consumed_by: [],
      });
      console.log(`💓 Heartbeat: uptime=${uptimeS}s, memories=${activeMemories}, calls=${totalCalls}`);
    } catch (hbErr: unknown) {
      console.error(`💓 Heartbeat error: ${errorMessage(hbErr)}`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`🌙 Consolidation + retention: every 6h (threshold: ${CONSOLIDATION_THRESHOLD} memories, retention: 90 days)`);
  console.log(`💓 Heartbeat: every 15min`);

  return { consolidationTimer, heartbeatTimer };
}

/**
 * Seed default workflow templates on first boot.
 */
export function seedWorkflows() {
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
      description: "Full memory hygiene cycle: stats → consolidate → retain",
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
}
