import { Index } from "@upstash/vector";

export function getVectorIndex(env: Env) {
  return new Index({
    url: env.UPSTASH_VECTOR_REST_URL,
    token: env.UPSTASH_VECTOR_REST_TOKEN,
    cache: false, // Required for Cloudflare Workers
  });
}

export async function upsertMemory(env: Env, id: string, text: string, metadata: Record<string, unknown>) {
  const index = getVectorIndex(env);
  await index.upsert({ id, data: text, metadata: { ...metadata, text } });
}

export async function queryMemory(env: Env, query: string, topK = 5) {
  const index = getVectorIndex(env);
  const results = await index.query({ data: query, topK, includeMetadata: true });
  return results
    .filter(r => r.score > 0.7) // Only high-confidence matches
    .map(r => ({ text: r.metadata?.text as string, score: r.score }));
}
