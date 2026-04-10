/**
 * PAR Epistemic Engine — Contradiction, staleness, and orphan detection.
 *
 * Three detection layers:
 *   1. Semantic Contradiction Scan — high-similarity memories with opposing claims
 *   2. Temporal Staleness Detection — superseded versions, metrics, counts
 *   3. KG Orphan Detection — entities referencing deleted projects/tools
 *
 * Returns structured Findings that the scheduler can act on (tag, archive, flag).
 * Contradictions are always flagged for human review, never auto-resolved.
 */
import path from "path";
import { META_DIR, readJSON, listJSON } from "./storage.js";
import { cosineSimilarity } from "./embedder.js";

// ── Finding types ────────────────────────────────────────────

export type FindingSeverity = "contradiction" | "stale" | "orphan";
export type FindingAction = "tag" | "archive" | "merge" | "review";

export interface Finding {
  severity: FindingSeverity;
  memory_ids: string[];
  explanation: string;
  action: FindingAction;
  /** For contradictions: similarity score between the pair */
  similarity?: number;
  /** For staleness: which memory supersedes which */
  superseded_by?: string;
  /** For orphans: what reference is broken */
  broken_ref?: string;
}

export interface AuditResult {
  project: string | null;
  scanned: number;
  pairs_compared: number;
  findings: Finding[];
  summary: {
    contradictions: number;
    stale: number;
    orphans: number;
    total: number;
  };
  duration_ms: number;
}

// ── Negation & conflict signals ──────────────────────────────

const NEGATION_PATTERNS = [
  /\bnot\b/i, /\bno longer\b/i, /\bremoved\b/i, /\breplaced\b/i,
  /\bdeleted\b/i, /\bdeprecated\b/i, /\bdisabled\b/i, /\bstopped\b/i,
  /\babandoned\b/i, /\bbroken\b/i, /\bfailed\b/i, /\bsuperseded\b/i,
  /\bwon't\b/i, /\bdon't\b/i, /\bdoesn't\b/i, /\bisn't\b/i,
  /\brolled back\b/i, /\breverted\b/i, /\bundo\b/i,
];

const VERSION_PATTERN = /v(\d+)\.(\d+)\.(\d+)/g;
const NUMERIC_CLAIM_PATTERN = /(\d+)\s*(tools?|memories|projects?|skills?|agents?|workflows?|tasks?|snippets?|containers?|entities|relationships)/gi;

// ── Core audit function ──────────────────────────────────────

export function runEpistemicAudit(
  options: { project?: string; maxPairs?: number } = {},
): AuditResult {
  const start = Date.now();
  const memDir = path.join(META_DIR, "memory");
  let memories = listJSON(memDir).filter(m => !m.archived && m.embedding);

  if (options.project) {
    memories = memories.filter(m => m.project === options.project);
  }

  const findings: Finding[] = [];
  const maxPairs = options.maxPairs ?? 15_000; // safety cap for large stores

  // ── Layer 1: Semantic Contradiction Scan ──────────────────
  const contradictions = scanContradictions(memories, maxPairs);
  findings.push(...contradictions);

  // ── Layer 2: Temporal Staleness Detection ─────────────────
  const stale = scanStaleness(memories);
  findings.push(...stale);

  // ── Layer 3: KG Orphan Detection ─────────────────────────
  const orphans = scanOrphans();
  findings.push(...orphans);

  const pairsCompared = Math.min(
    (memories.length * (memories.length - 1)) / 2,
    maxPairs,
  );

  return {
    project: options.project || null,
    scanned: memories.length,
    pairs_compared: pairsCompared,
    findings,
    summary: {
      contradictions: contradictions.length,
      stale: stale.length,
      orphans: orphans.length,
      total: findings.length,
    },
    duration_ms: Date.now() - start,
  };
}

// ── Layer 1: Contradiction Scanner ───────────────────────────

function scanContradictions(memories: any[], maxPairs: number): Finding[] {
  const findings: Finding[] = [];

  // Sort by date descending so newer memory is always 'i' in early iterations
  const sorted = [...memories].sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
  );

  let pairsChecked = 0;

  for (let i = 0; i < sorted.length && pairsChecked < maxPairs; i++) {
    for (let j = i + 1; j < sorted.length && pairsChecked < maxPairs; j++) {
      pairsChecked++;

      const sim = cosineSimilarity(sorted[i].embedding, sorted[j].embedding);

      // Sweet spot: similar enough to be about the same topic,
      // but not so similar they're just duplicates (consolidation handles those)
      if (sim < 0.55 || sim > 0.90) continue;

      const conflict = detectConflict(sorted[i], sorted[j]);
      if (conflict) {
        findings.push({
          severity: "contradiction",
          memory_ids: [sorted[i].id, sorted[j].id],
          explanation: conflict,
          action: "review",
          similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
  }

  return findings;
}

export function detectConflict(newer: any, older: any): string | null {
  const newerContent = newer.content || "";
  const olderContent = older.content || "";

  // 1. Version conflicts: same project context but different version claims
  const newerVersions = extractVersions(newerContent);
  const olderVersions = extractVersions(olderContent);

  for (const [key, newerVer] of newerVersions) {
    const olderVer = olderVersions.get(key);
    if (olderVer && olderVer !== newerVer) {
      return `Version conflict: newer memory claims ${key} ${newerVer}, older claims ${key} ${olderVer}`;
    }
  }

  // 2. Numeric claim conflicts: "31 tools" vs "55 tools" on the same topic
  const newerClaims = extractNumericClaims(newerContent);
  const olderClaims = extractNumericClaims(olderContent);

  for (const [subject, newerCount] of newerClaims) {
    const olderCount = olderClaims.get(subject);
    if (olderCount !== undefined && olderCount !== newerCount) {
      // Only flag if the difference is significant (>20% or >5 absolute)
      const diff = Math.abs(newerCount - olderCount);
      const pctDiff = diff / Math.max(newerCount, olderCount, 1);
      if (diff > 5 || pctDiff > 0.2) {
        return `Numeric conflict: newer says ${newerCount} ${subject}, older says ${olderCount} ${subject}`;
      }
    }
  }

  // 3. Negation asymmetry: one memory affirms what the other negates
  const newerNeg = countNegations(newerContent);
  const olderNeg = countNegations(olderContent);
  // If one has significantly more negation signal on the same topic
  if (Math.abs(newerNeg - olderNeg) >= 3 && (newerNeg > 0 || olderNeg > 0)) {
    return `Content polarity mismatch: newer has ${newerNeg} negation signals, older has ${olderNeg} — likely describes reversal or rollback`;
  }

  return null;
}

// ── Layer 2: Staleness Scanner ───────────────────────────────

function scanStaleness(memories: any[]): Finding[] {
  const findings: Finding[] = [];

  // Sort newest first
  const sorted = [...memories].sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
  );

  // Build a map of the "latest" version claims per project
  const latestVersions = new Map<string, { version: string; memoryId: string; created: string }>();
  const latestCounts = new Map<string, { count: number; subject: string; memoryId: string; created: string }>();

  for (const mem of sorted) {
    const project = mem.project || "_global";
    const content = mem.content || "";

    // Track latest version per project
    const versions = extractVersions(content);
    for (const [, ver] of versions) {
      const key = `${project}:version`;
      if (!latestVersions.has(key)) {
        latestVersions.set(key, { version: ver, memoryId: mem.id, created: mem.created });
      }
    }

    // Track latest numeric claims per (project, subject)
    const claims = extractNumericClaims(content);
    for (const [subject, count] of claims) {
      const key = `${project}:${subject}`;
      if (!latestCounts.has(key)) {
        latestCounts.set(key, { count, subject, memoryId: mem.id, created: mem.created });
      }
    }
  }

  // Now scan older memories and flag those with outdated claims
  for (const mem of sorted) {
    const project = mem.project || "_global";
    const content = mem.content || "";
    let stalenessSignals = 0;
    const reasons: string[] = [];

    // Check version staleness
    const versions = extractVersions(content);
    for (const [, ver] of versions) {
      const key = `${project}:version`;
      const latest = latestVersions.get(key);
      if (latest && latest.memoryId !== mem.id && compareVersions(ver, latest.version) < 0) {
        stalenessSignals++;
        reasons.push(`references ${ver}, latest is ${latest.version}`);
      }
    }

    // Check numeric claim staleness
    const claims = extractNumericClaims(content);
    for (const [subject, count] of claims) {
      const key = `${project}:${subject}`;
      const latest = latestCounts.get(key);
      if (latest && latest.memoryId !== mem.id && count !== latest.count) {
        const diff = Math.abs(count - latest.count);
        const pctDiff = diff / Math.max(count, latest.count, 1);
        if (diff > 5 || pctDiff > 0.2) {
          stalenessSignals++;
          reasons.push(`claims ${count} ${subject}, latest is ${latest.count}`);
        }
      }
    }

    if (stalenessSignals >= 2) {
      // Multiple staleness signals → high confidence it's outdated
      findings.push({
        severity: "stale",
        memory_ids: [mem.id],
        explanation: `Memory has ${stalenessSignals} outdated claims: ${reasons.join("; ")}`,
        action: stalenessSignals >= 3 ? "archive" : "tag",
        superseded_by: latestVersions.get(`${project}:version`)?.memoryId ||
                       latestCounts.values().next().value?.memoryId,
      });
    }
  }

  return findings;
}

// ── Layer 3: KG Orphan Scanner ───────────────────────────────

function scanOrphans(): Finding[] {
  const findings: Finding[] = [];
  const kgDir = path.join(META_DIR, "knowledge");

  // Get all active project IDs
  const projectIds = new Set(
    listJSON(path.join(META_DIR, "projects"))
      .filter(p => p.status !== "archived")
      .map(p => p.id),
  );

  // Check entity orphans
  const entities = listJSON(kgDir).filter(e => e.id && !e.id.startsWith("rel__"));
  for (const entity of entities) {
    if (entity.type === "project" && !projectIds.has(entity.id)) {
      findings.push({
        severity: "orphan",
        memory_ids: entity.sources || [],
        explanation: `KG entity "${entity.id}" references archived/deleted project`,
        action: "tag",
        broken_ref: entity.id,
      });
    }
  }

  // Check relationship orphans — relationships where both endpoints are gone
  const entityIds = new Set(entities.map(e => e.id));
  const relationships = listJSON(kgDir).filter(r => r.from && r.to);
  for (const rel of relationships) {
    if (!entityIds.has(rel.from) && !entityIds.has(rel.to)) {
      findings.push({
        severity: "orphan",
        memory_ids: rel.source ? [rel.source] : [],
        explanation: `KG relationship "${rel.from}" → "${rel.to}" (${rel.type}): both endpoints missing`,
        action: "archive",
        broken_ref: `${rel.from}→${rel.to}`,
      });
    }
  }

  return findings;
}

// ── Utility functions ────────────────────────────────────────

export function extractVersions(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  const matches = text.matchAll(VERSION_PATTERN);
  for (const match of matches) {
    // Use "version" as key since we typically track one version per context
    versions.set("version", `v${match[1]}.${match[2]}.${match[3]}`);
  }
  return versions;
}

export function extractNumericClaims(text: string): Map<string, number> {
  const claims = new Map<string, number>();
  const matches = text.matchAll(NUMERIC_CLAIM_PATTERN);
  for (const match of matches) {
    const count = parseInt(match[1]);
    const subject = match[2].toLowerCase().replace(/s$/, ""); // normalize plural
    if (count > 0 && count < 10000) { // sanity bounds
      // Keep the claim with the higher count for this subject (avoids partial matches)
      const existing = claims.get(subject);
      if (existing === undefined || count > existing) {
        claims.set(subject, count);
      }
    }
  }
  return claims;
}

function countNegations(text: string): number {
  let count = 0;
  for (const pattern of NEGATION_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, "gi"));
    if (matches) count += matches.length;
  }
  return count;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
