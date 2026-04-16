/**
 * Core tools: server_status, meta_store, meta_retrieve, meta_list, file_store, file_read, system_qa
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, readJSON, writeJSON, listJSON, safePath, textResult, errorResult } from "../lib/storage.js";
import { embed, cosineSimilarity, getEmbeddingStatus, isSemanticReady } from "../lib/embedder.js";

export function registerCoreTools(server: McpServer) {
  // ┌─────────────────────────────────────────────────────────┐
  // │  CORE TOOLS                                             │
  // └─────────────────────────────────────────────────────────┘

  server.tool("server_status", "Get PAR system status and capabilities", {}, async () => {
    const embeddingStatus = getEmbeddingStatus();
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
      retrieval: {
        default_strategy: "hybrid",
        semantic_ready: embeddingStatus.ready,
        embedding_model: embeddingStatus.model,
        embedding_dimensions: embeddingStatus.dimensions,
        embedding_cache_entries: embeddingStatus.cache_entries,
      },
      counts: {
        projects: projectCount, tasks: taskCount, skills: skillCount,
        snippets: snippetCount, datasets: datasetCount, artifacts: artifactCount,
        agents: agentCount, events: eventCount, workflows: workflowCount,
        procedures: procedureCount, kg_entities: kgEntityCount, kg_relationships: kgRelCount,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ┌─────────────────────────────────────────────────────────┐
  // │  META KV STORE                                          │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "meta_store", "Store a key-value pair in persistent meta storage",
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
    "meta_retrieve", "Retrieve a value from persistent meta storage",
    { key: z.string().describe("Storage key to retrieve") },
    async ({ key }) => {
      const filePath = path.join(META_DIR, "kv", `${key.replace(/\//g, "__")}.json`);
      const entry = readJSON(filePath);
      if (!entry) return errorResult(`Key not found: ${key}`);
      return textResult(entry.value);
    },
  );

  server.tool("meta_list", "List all keys in meta storage", {}, async () => {
    const kvDir = path.join(META_DIR, "kv");
    const files = fs.existsSync(kvDir) ? fs.readdirSync(kvDir).filter(f => f.endsWith(".json")) : [];
    const keys = files.map((f) => {
      const entry = readJSON(path.join(kvDir, f));
      const derivedKey = f.replace(/\.json$/, "").replace(/__/g, "/");
      return {
        key: entry?.key || derivedKey,
        updated: entry?.updated || null,
      };
    });
    return textResult(keys.length ? keys : "No keys stored yet.");
  });

  // ┌─────────────────────────────────────────────────────────┐
  // │  FILE STORE                                             │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "file_store", "Store a file in persistent storage",
    {
      filepath: z.string().describe("Relative path within meta storage (e.g. 'projects/myfile.txt')"),
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
    "file_read", "Read a file from persistent storage",
    { filepath: z.string().describe("Relative path within meta storage") },
    async ({ filepath }) => {
      const fullPath = safePath(path.join(META_DIR, "files"), filepath);
      if (!fs.existsSync(fullPath)) return errorResult(`File not found: ${filepath}`);
      const content = fs.readFileSync(fullPath, "utf-8");
      return textResult(content);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SYSTEM QA — Automated multi-cycle probe                 │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "system_qa",
    "Run N automated QA cycles. Each cycle writes+reads across every subsystem (KV, file, memory, snippet, task, knowledge, events), verifies round-trip identity, checks embedding coverage, and tracks heap growth. Returns structured results per cycle. Use this instead of manually invoking 46 tools.",
    {
      cycles: z.number().optional().describe("Number of complete probe cycles to run (default 1, max 10)"),
    },
    async ({ cycles: rawCycles }) => {
      const cycles = Math.min(Math.max(rawCycles || 1, 1), 10);
      const results: any[] = [];
      const heapSnapshots: number[] = [];
      const t0 = Date.now();

      for (let c = 0; c < cycles; c++) {
        const cycleStart = Date.now();
        const cycleId = `qa-${Date.now().toString(36)}`;
        const probes: { name: string; status: "pass" | "fail" | "warn"; ms: number; detail?: string }[] = [];

        // helper
        const probe = async (name: string, fn: () => Promise<void>) => {
          const s = Date.now();
          try {
            await fn();
            probes.push({ name, status: "pass", ms: Date.now() - s });
          } catch (err: any) {
            probes.push({ name, status: "fail", ms: Date.now() - s, detail: err.message || String(err) });
          }
        };

        // 1. KV round-trip
        await probe("kv_roundtrip", async () => {
          const key = `qa-auto/${cycleId}`;
          const val = JSON.stringify({ cycle: c, ts: Date.now() });
          const kvPath = path.join(META_DIR, "kv", `${key.replace(/\//g, "__")}.json`);
          writeJSON(kvPath, { key, value: val, updated: new Date().toISOString() });
          const read = readJSON(kvPath);
          if (read?.value !== val) throw new Error(`KV mismatch: wrote ${val}, read ${read?.value}`);
          fs.unlinkSync(kvPath); // cleanup
        });

        // 2. File round-trip
        await probe("file_roundtrip", async () => {
          const content = `probe-${cycleId}-${Date.now()}`;
          const fp = safePath(path.join(META_DIR, "files"), `qa-auto/${cycleId}.txt`);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, content);
          const read = fs.readFileSync(fp, "utf-8");
          if (read !== content) throw new Error(`File mismatch: wrote ${content.length}b, read ${read.length}b`);
          fs.unlinkSync(fp);
        });

        // 3. Memory store + semantic search + cleanup
        await probe("memory_roundtrip", async () => {
          const memDir = path.join(META_DIR, "memory");
          const memId = randomUUID();
          const content = `QA-AUTO-PROBE cycle=${c} id=${cycleId} timestamp=${Date.now()}`;
          const embedding = await embed(content);
          if (!embedding || embedding.length === 0) throw new Error("Embedding generation failed");

          writeJSON(path.join(memDir, `${memId}.json`), {
            id: memId, type: "observation", content, project: "diag",
            tags: ["qa-auto", "ephemeral"], embedding, created: new Date().toISOString(),
          });

          // verify it's readable
          const readBack = readJSON(path.join(memDir, `${memId}.json`));
          if (!readBack || readBack.content !== content) throw new Error("Memory read mismatch");

          // verify semantic similarity to itself
          const selfSim = cosineSimilarity(embedding, readBack.embedding);
          if (selfSim < 0.99) throw new Error(`Self-similarity too low: ${selfSim}`);

          // cleanup
          fs.unlinkSync(path.join(memDir, `${memId}.json`));
        });

        // 4. Task round-trip
        await probe("task_roundtrip", async () => {
          const taskId = cycleId.slice(0, 8);
          const taskPath = path.join(META_DIR, "tasks", `${taskId}.json`);
          const task = {
            id: taskId, project: "diag", title: `QA auto probe c${c}`,
            priority: "low", status: "todo", created: new Date().toISOString(),
          };
          writeJSON(taskPath, task);
          const read = readJSON(taskPath);
          if (read?.title !== task.title) throw new Error("Task read mismatch");
          fs.unlinkSync(taskPath);
        });

        // 5. Snippet round-trip
        await probe("snippet_roundtrip", async () => {
          const snipId = `qa-auto-${cycleId}`;
          const snipPath = path.join(META_DIR, "snippets", `${snipId}.json`);
          const snip = {
            id: snipId, title: "QA auto probe", content: `console.log('${cycleId}')`,
            language: "javascript", tags: ["qa-auto"], created: new Date().toISOString(),
          };
          writeJSON(snipPath, snip);
          const read = readJSON(snipPath);
          if (read?.content !== snip.content) throw new Error("Snippet read mismatch");
          fs.unlinkSync(snipPath);
        });

        // 6. Knowledge graph write + read
        await probe("knowledge_roundtrip", async () => {
          const kgDir = path.join(META_DIR, "knowledge");
          const entityId = `qa_probe_${cycleId}`;
          const entityPath = path.join(kgDir, `entity__${entityId}.json`);
          const entity = {
            id: entityId, name: "QA Probe", type: "concept",
            mentions: 1, created: new Date().toISOString(),
          };
          writeJSON(entityPath, entity);
          const read = readJSON(entityPath);
          if (read?.id !== entityId) throw new Error("KG entity read mismatch");
          fs.unlinkSync(entityPath);
        });

        // 7. Event write + read
        await probe("event_roundtrip", async () => {
          const eventId = cycleId.slice(0, 8);
          const eventPath = path.join(META_DIR, "events", `${eventId}.json`);
          const event = {
            id: eventId, type: "qa.auto", source: "system_qa",
            project: "diag", severity: "info", payload: { cycle: c },
            timestamp: new Date().toISOString(), consumed_by: [],
          };
          writeJSON(eventPath, event);
          const read = readJSON(eventPath);
          if (read?.type !== "qa.auto") throw new Error("Event read mismatch");
          fs.unlinkSync(eventPath);
        });

        // 8. Embedding model health
        await probe("embedding_health", async () => {
          if (!isSemanticReady()) throw new Error("Embedding model not loaded");
          const vec = await embed("test probe");
          if (!vec || vec.length !== 384) throw new Error(`Bad embedding dim: ${vec?.length}`);
        });

        // 9. Embedding coverage (existing memories)
        await probe("embedding_coverage", async () => {
          const memDir = path.join(META_DIR, "memory");
          const mems = listJSON(memDir).filter((m: any) => !m.archived);
          const withEmbed = mems.filter((m: any) => m.embedding && m.embedding.length > 0);
          const coverage = mems.length > 0 ? withEmbed.length / mems.length : 1;
          if (coverage < 0.95) throw new Error(`Coverage ${(coverage * 100).toFixed(1)}% < 95%`);
        });

        // 10. Storage integrity (all dirs exist)
        await probe("storage_dirs", async () => {
          const required = ["kv", "files", "projects", "tasks", "snippets", "skills",
            "datasets", "memory", "artifacts", "agents", "events", "workflows",
            "procedures", "knowledge"];
          const missing = required.filter(d => !fs.existsSync(path.join(META_DIR, d)));
          if (missing.length > 0) throw new Error(`Missing dirs: ${missing.join(", ")}`);
        });

        // snapshot heap
        const heap = process.memoryUsage();
        heapSnapshots.push(heap.heapUsed);

        const cycleDuration = Date.now() - cycleStart;
        const passed = probes.filter(p => p.status === "pass").length;
        const failed = probes.filter(p => p.status === "fail").length;

        results.push({
          cycle: c + 1,
          duration_ms: cycleDuration,
          probes_total: probes.length,
          passed,
          failed,
          heap_mb: Math.round(heap.heapUsed / 1024 / 1024 * 10) / 10,
          failures: probes.filter(p => p.status === "fail"),
          slowest: probes.reduce((a, b) => a.ms > b.ms ? a : b).name,
          slowest_ms: probes.reduce((a, b) => a.ms > b.ms ? a : b).ms,
        });
      }

      // compute heap drift
      const heapDrift = heapSnapshots.length > 1
        ? Math.round((heapSnapshots[heapSnapshots.length - 1] - heapSnapshots[0]) / 1024)
        : 0;

      const totalPassed = results.reduce((s, r) => s + r.passed, 0);
      const totalFailed = results.reduce((s, r) => s + r.failed, 0);
      const totalProbes = results.reduce((s, r) => s + r.probes_total, 0);

      return textResult({
        version: "7.0.0",
        cycles_completed: cycles,
        total_probes: totalProbes,
        total_passed: totalPassed,
        total_failed: totalFailed,
        wall_time_ms: Date.now() - t0,
        heap_drift_kb: heapDrift,
        heap_leak_warning: heapDrift > 5000, // warn if >5MB growth
        embedding_model: getEmbeddingStatus().model,
        cycles: results,
      });
    },
  );
}
