/** Minimal shapes to avoid coupling with your extension types */
export interface SimilarityNode {
  id: number;
  code: string;
  isLeaf: boolean;
}

export interface SimilarityBranch {
  nodes: SimilarityNode[];
}

export interface SimilarityScore {
  id: number;          // node id of the other leaf
  similarity: number;  // cosine similarity with the target's code
}

/** --- Cosine similarity helpers (no external deps) --- **/

/** Very simple tokenizer for code: split on non-word, keep letters/digits/_ , lowercase */
function tokenizeCode(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-zA-Z0-9_]+/g)
    .filter(Boolean);
}

/** Build TF-IDF vectors for documents (code strings). Returns normalized sparse vectors. */
function buildTfIdf(docs: string[]): Map<string, number>[] {
  const tokensPerDoc = docs.map(tokenizeCode);

  // Document frequency (DF)
  const df = new Map<string, number>();
  tokensPerDoc.forEach(tokens => {
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        df.set(t, (df.get(t) || 0) + 1);
        seen.add(t);
      }
    }
  });

  const N = docs.length;

  // Inverse Document Frequency (IDF) with smoothing
  const idf = new Map<string, number>();
  for (const [t, dfi] of df.entries()) {
    idf.set(t, Math.log((N + 1) / (dfi + 1)) + 1);
  }

  // TF-IDF vectors as sparse maps(term -> weight), L2-normalized
  return tokensPerDoc.map(tokens => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    const vec = new Map<string, number>();
    let sumsq = 0;
    for (const [t, freq] of tf.entries()) {
      const w = freq * (idf.get(t) || 0);
      if (w !== 0) {
        vec.set(t, w);
        sumsq += w * w;
      }
    }
    const norm = Math.sqrt(sumsq) || 1;
    for (const [t, w] of vec.entries()) vec.set(t, w / norm);
    return vec;
  });
}

/** Cosine between two normalized sparse vectors (term->weight) */
function cosineSparse(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, wa] of small.entries()) {
    const wb = large.get(t);
    if (wb) dot += wa * wb;
  }
  return dot; // already normalized
}

/**
 * Compute cosine similarity on code ONLY, comparing a target leaf against other leaf nodes.
 * Returns an array sorted by similarity (desc), excluding the target itself.
 *
 * @param branch  A branch-like object with nodes { id, code, isLeaf }
 * @param target  The selected node (must exist in branch)
 */
export function computeLeafSimilaritiesForCode(
  branch: SimilarityBranch,
  target: SimilarityNode
): SimilarityScore[] {
  // Collect leaf nodes that have code (string)
  const leafs = branch.nodes.filter(n => n.isLeaf && typeof n.code === 'string');

  // Target first, then other leafs (excluding target)
  const ordered = [target, ...leafs.filter(n => n.id !== target.id)];
  const docs = ordered.map(n => n.code || '');

  // Build vectors and compute cosine vs target
  const vectors = buildTfIdf(docs);
  const vTarget = vectors[0];

  const results: SimilarityScore[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const sim = cosineSparse(vTarget, vectors[i]);
    results.push({ id: ordered[i].id, similarity: sim });
  }

  // Sort descending by similarity
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}
