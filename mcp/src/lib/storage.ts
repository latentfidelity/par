/**
 * PAR Storage Layer — JSON file I/O with security guards and caching.
 *
 * All file access to META_DIR flows through these functions.
 * readJSON/writeJSON enforce path-traversal protection.
 * listJSON caches directory reads with TTL-based invalidation.
 */
import fs from "fs";
import path from "path";

export const META_DIR = process.env.META_DIR || "/data/meta";

// ── Ensure directories ───────────────────────────────────────
export const DIRS = ["kv", "files", "projects", "tasks", "snippets", "skills", "datasets", "memory", "artifacts", "agents", "events", "workflows", "procedures", "knowledge"];
for (const dir of DIRS) {
  fs.mkdirSync(path.join(META_DIR, dir), { recursive: true });
}

// ── Security: path traversal guard ────────────────────────────
export function safePath(base: string, userPath: string): string {
  const resolved = path.resolve(base, userPath);
  const baseResolved = path.resolve(base);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new Error(`Path traversal blocked: ${userPath}`);
  }
  return resolved;
}

// ── Security: ID sanitization (defense-in-depth) ──────────────
export function safeId(id: string): string {
  return id.replace(/[\/\\:\0]/g, "_").replace(/\.\./g, "_");
}

// ── JSON I/O ─────────────────────────────────────────────────
export function readJSON(filePath: string): any | null {
  const resolved = path.resolve(filePath);
  const metaResolved = path.resolve(META_DIR);
  if (!resolved.startsWith(metaResolved + path.sep) && resolved !== metaResolved) {
    console.error(`[SECURITY] readJSON blocked: ${filePath}`);
    return null;
  }
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function writeJSON(filePath: string, data: any): void {
  const resolved = path.resolve(filePath);
  const metaResolved = path.resolve(META_DIR);
  if (!resolved.startsWith(metaResolved + path.sep) && resolved !== metaResolved) {
    throw new Error(`[SECURITY] writeJSON blocked: ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  const parentDir = path.dirname(filePath);
  _dirCache.delete(parentDir);
}

// ── Directory cache (TTL-based, invalidated on write) ────────
const _dirCache = new Map<string, { data: any[]; ts: number }>();
const DIR_CACHE_TTL_MS = 10_000;

export function listJSON(dir: string): any[] {
  if (!fs.existsSync(dir)) return [];
  const cached = _dirCache.get(dir);
  if (cached && (Date.now() - cached.ts) < DIR_CACHE_TTL_MS) {
    return cached.data;
  }
  const result = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON(path.join(dir, f)))
    .filter(Boolean);
  _dirCache.set(dir, { data: result, ts: Date.now() });
  return result;
}

// ── MCP response helpers ─────────────────────────────────────
export function textResult(text: any) {
  return {
    content: [
      { type: "text" as const, text: typeof text === "string" ? text : JSON.stringify(text, null, 2) },
    ],
  };
}

export function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Safely extract an error message from an unknown catch value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
