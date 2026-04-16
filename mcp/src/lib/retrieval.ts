import { embed, cosineSimilarity, isSemanticReady } from "./embedder.js";

export interface RetrievableMemory {
  id: string;
  type: string;
  content: string;
  project: string | null;
  tags?: string[];
  created: string;
  embedding?: number[];
  archived?: boolean;
  pinned?: boolean;
}

export interface RetrievalComponents {
  semantic: number;
  lexical: number;
  recency: number;
  exact: number;
  pinned: number;
}

export interface RetrievalResult {
  memory: RetrievableMemory;
  score: number;
  components: RetrievalComponents;
}

export interface RetrievalOptions {
  query: string;
  memories: RetrievableMemory[];
  project?: string;
  type?: string;
  includeArchived?: boolean;
  limit?: number;
  minScore?: number;
  strategy?: "semantic" | "lexical" | "hybrid";
  diverse?: boolean;
}

const TOKEN_RE = /[a-z0-9][a-z0-9_-]*/g;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "we", "with",
]);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const matches = normalized.match(TOKEN_RE) || [];
  const filtered = matches.filter((token) => !STOPWORDS.has(token));
  return filtered.length > 0 ? filtered : matches;
}

function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function lexicalSignals(query: string, memory: RetrievableMemory) {
  const queryNorm = normalizeText(query);
  const textNorm = normalizeText(`${memory.content} ${(memory.tags || []).join(" ")}`);
  const queryTokens = uniqueTokens(queryNorm);
  const candidateTokens = uniqueTokens(textNorm);
  const candidateSet = new Set(candidateTokens);
  const overlap = queryTokens.filter((token) => candidateSet.has(token));
  const queryCoverage = queryTokens.length > 0 ? overlap.length / queryTokens.length : 0;
  const union = new Set([...queryTokens, ...candidateTokens]);
  const jaccard = union.size > 0 ? overlap.length / union.size : 0;
  const exact = queryNorm.length > 2 && textNorm.includes(queryNorm) ? 1 : 0;
  const tagHit = (memory.tags || []).some((tag) => queryTokens.includes(normalizeText(tag))) ? 1 : 0;

  return {
    lexical: clamp01(queryCoverage * 0.65 + jaccard * 0.2 + exact * 0.1 + tagHit * 0.05),
    exact,
  };
}

function recencyScore(created: string): number {
  const timestamp = new Date(created).getTime();
  if (Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  const halfLifeDays = 21;
  return clamp01(Math.exp((-Math.log(2) * ageDays) / halfLifeDays));
}

function noveltySimilarity(a: RetrievalResult, b: RetrievalResult): number {
  if (a.memory.embedding?.length && b.memory.embedding?.length) {
    return clamp01(cosineSimilarity(a.memory.embedding, b.memory.embedding));
  }

  const aTokens = new Set(uniqueTokens(a.memory.content));
  const bTokens = new Set(uniqueTokens(b.memory.content));
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 ? overlap / union : 0;
}

function selectDiverse(results: RetrievalResult[], limit: number): RetrievalResult[] {
  if (results.length <= limit) return results.slice(0, limit);

  const chosen: RetrievalResult[] = [];
  const remaining = [...results];
  const lambda = 0.82;

  while (chosen.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      const redundancy = chosen.length === 0
        ? 0
        : Math.max(...chosen.map((selected) => noveltySimilarity(candidate, selected)));
      const mmr = lambda * candidate.score - (1 - lambda) * redundancy;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = index;
      }
    }

    chosen.push(remaining.splice(bestIndex, 1)[0]);
  }

  return chosen.sort((left, right) => right.score - left.score);
}

export async function retrieveMemories({
  query,
  memories,
  project,
  type,
  includeArchived = false,
  limit = 10,
  minScore,
  strategy = "hybrid",
  diverse = true,
}: RetrievalOptions): Promise<RetrievalResult[]> {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  let candidates = memories;
  if (!includeArchived) candidates = candidates.filter((memory) => !memory.archived);
  if (project) candidates = candidates.filter((memory) => memory.project === project);
  if (type) candidates = candidates.filter((memory) => memory.type === type);
  if (candidates.length === 0) return [];

  const maxResults = Math.min(limit, 50);
  const shouldUseSemantic = strategy !== "lexical" && isSemanticReady();
  const queryEmbedding = shouldUseSemantic ? await embed(normalizedQuery) : null;

  const scored = candidates
    .map((memory) => {
      const semantic = queryEmbedding && memory.embedding?.length
        ? clamp01(cosineSimilarity(queryEmbedding, memory.embedding))
        : 0;
      const { lexical, exact } = lexicalSignals(normalizedQuery, memory);
      const recency = recencyScore(memory.created);
      const pinned = memory.pinned ? 1 : 0;

      let score = 0;
      if (strategy === "semantic") {
        score = semantic * 0.9 + recency * 0.08 + pinned * 0.02;
      } else if (strategy === "lexical") {
        score = lexical * 0.85 + recency * 0.1 + pinned * 0.05;
      } else {
        score = semantic * 0.62 + lexical * 0.23 + recency * 0.1 + exact * 0.03 + pinned * 0.02;
      }

      return {
        memory,
        score: clamp01(score),
        components: {
          semantic: round3(semantic),
          lexical: round3(lexical),
          recency: round3(recency),
          exact,
          pinned,
        },
      };
    })
    .sort((left, right) => right.score - left.score);

  const threshold = minScore ?? 0;
  const filtered = scored.filter((result) => result.score >= threshold);
  const selected = diverse ? selectDiverse(filtered, maxResults) : filtered.slice(0, maxResults);

  return selected.map((result) => ({
    ...result,
    score: round3(result.score),
  }));
}
