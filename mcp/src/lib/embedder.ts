/**
 * PAR Embedder — Local-only semantic embedding module.
 *
 * Uses @xenova/transformers (ONNX Runtime) to run all-MiniLM-L6-v2 locally.
 * 384-dimensional embeddings, ~200ms per embed on CPU. Zero API costs.
 */

let pipeline: any | null = null;
let modelReady = false;
let initPromise: Promise<void> | null = null;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

/**
 * Initialize the embedding pipeline (lazy, called once on first use).
 */
async function init(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Use persistent writable cache dir (not read-only node_modules)
      process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE || "/data/meta/.cache";
      const { pipeline: createPipeline } = await import("@xenova/transformers");
      pipeline = await createPipeline("feature-extraction", MODEL_NAME, {
        quantized: true, // Use quantized model for speed
      });
      modelReady = true;
      console.log(`[embedder] Model loaded: ${MODEL_NAME} (${EMBEDDING_DIM}d)`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[embedder] Failed to load model: ${message}`);
      console.error(`[embedder] Falling back to keyword mode`);
      modelReady = false;
    }
  })();

  return initPromise;
}

/**
 * Generate an embedding vector for the given text.
 * Returns an array of EMBEDDING_DIM dimensions.
 * Falls back to a simple hash-based vector if model isn't available.
 */
async function embed(text: string): Promise<number[]> {
  await init();

  if (modelReady && pipeline) {
    const output = await pipeline(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data) as number[];
  }

  // Fallback: deterministic hash-based pseudo-embedding
  return hashEmbed(text);
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

/**
 * Fallback: simple hash-based embedding for keyword-level matching.
 * Not truly semantic, but allows the system to function without the model.
 */
function hashEmbed(text: string): number[] {
  const dim = EMBEDDING_DIM;
  const vec = new Array<number>(dim).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);

  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash * 31 + word.charCodeAt(i)) & 0x7fffffff;
    }
    // Scatter word hashes across vector dimensions
    for (let i = 0; i < 8; i++) {
      const idx = (hash + i * 47) % dim;
      vec[idx] += (hash % 2 === 0 ? 1 : -1) * (1 / words.length);
      hash = (hash * 131 + 17) & 0x7fffffff;
    }
  }

  // Normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= mag;
  }

  return vec;
}

/**
 * Check if semantic (model-based) embeddings are available.
 */
function isSemanticReady(): boolean {
  return modelReady;
}

export { embed, cosineSimilarity, isSemanticReady, EMBEDDING_DIM };
