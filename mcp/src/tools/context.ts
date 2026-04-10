/**
 * Shared context passed to each tool registration module.
 *
 * Avoids each module importing module-level state directly —
 * instead the server.ts factory injects what tools need.
 */
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, listJSON } from "../lib/storage.js";
import { isSemanticReady } from "../lib/embedder.js";

export interface ToolContext {
  /** The MCP server to register tools on. */
  server: McpServer;
  /** Module-scoped vector index, nullable (lazy-loaded). */
  getMemoryIndex: () => MemoryEntry[] | null;
  setMemoryIndex: (idx: MemoryEntry[] | null) => void;
  /** Telemetry tracker. */
  trackCall: (name: string) => void;
}

export interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  project: string | null;
  tags: string[];
  created: string;
  embedding: number[];
}

/**
 * Shared index loader used by memory and system tool modules.
 */
export async function loadMemoryIndex(
  getIndex: () => MemoryEntry[] | null,
  setIndex: (idx: MemoryEntry[] | null) => void,
): Promise<MemoryEntry[]> {
  const existing = getIndex();
  if (existing) return existing;
  const memDir = path.join(META_DIR, "memory");
  const entries = listJSON(memDir).filter((m) => m.embedding);
  const loaded: MemoryEntry[] = entries.map((m) => ({
    id: m.id,
    type: m.type,
    content: m.content,
    project: m.project,
    tags: m.tags || [],
    created: m.created,
    embedding: m.embedding,
  }));
  console.log(`[memory] Index loaded: ${loaded.length} entries (${isSemanticReady() ? "semantic" : "keyword"} mode)`);
  setIndex(loaded);
  return loaded;
}
