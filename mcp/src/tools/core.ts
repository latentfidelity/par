/**
 * Core tools: server_status, meta_store, meta_retrieve, meta_list, file_store, file_read
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, readJSON, writeJSON, listJSON, safePath, textResult, errorResult } from "../lib/storage.js";

export function registerCoreTools(server: McpServer) {
  // ┌─────────────────────────────────────────────────────────┐
  // │  CORE TOOLS                                             │
  // └─────────────────────────────────────────────────────────┘

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
}
