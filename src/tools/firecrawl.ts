/**
 * ============================================================================
 * src/tools/firecrawl.ts — Firecrawl Web Scraping & Search Tool
 * ============================================================================
 *
 * Three modes:
 *   scrape  → Extract clean Markdown + metadata from a single URL
 *   search  → Search the web AND extract full page content in one call
 *   crawl   → Crawl an entire website (async, returns job ID for polling)
 *
 * API: Firecrawl v1 (https://api.firecrawl.dev/v1)
 * Required env var: FIRECRAWL_API_KEY → https://firecrawl.dev/app
 *
 * Why Firecrawl over fetch_url:
 *   - Handles JS-rendered pages, anti-bot, React/Next.js SPAs
 *   - Clean Markdown output optimized for LLMs (no tag noise)
 *   - Built-in PDF/DOCX text extraction
 *   - AI-powered structured JSON extraction from any page
 * ============================================================================
 */

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v1";

export async function execFirecrawl(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const mode = String(args.mode ?? "scrape") as "scrape" | "search" | "crawl" | "extract";
  const apiKey = (env as never as Record<string, string>).FIRECRAWL_API_KEY;

  if (!apiKey) {
    return {
      error: "FIRECRAWL_API_KEY not configured. Get a free key at https://firecrawl.dev/app and add it as a Cloudflare secret.",
    };
  }

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    switch (mode) {
      // ── SCRAPE: extract clean markdown from a single URL ─────────────────────
      case "scrape": {
        const url = String(args.url ?? "");
        if (!url) return { error: "url is required for scrape mode" };

        const formats = (args.formats as string[]) ?? ["markdown"];
        const waitFor = Number(args.waitFor ?? 0); // ms to wait for dynamic content
        const extractPrompt = args.extractPrompt as string | undefined; // AI extraction prompt

        const body: Record<string, unknown> = {
          url,
          formats,
          ...(waitFor > 0 && { waitFor }),
          ...(extractPrompt && {
            formats: [...new Set([...formats, "json"])],
            jsonOptions: { prompt: extractPrompt },
          }),
        };

        const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Firecrawl scrape failed: ${res.status} — ${err.slice(0, 300)}` };
        }

        const data = await res.json() as {
          success: boolean;
          data: {
            markdown?: string;
            html?: string;
            links?: string[];
            metadata?: Record<string, unknown>;
            json?: Record<string, unknown>;
          };
        };

        const markdown = data.data?.markdown ?? "";
        // Truncate to prevent token bloat — 8000 chars is plenty for most tasks
        const truncated = markdown.length > 8000;
        const mdOut = truncated ? markdown.slice(0, 8000) + "\n\n...[truncated, content continues]" : markdown;

        return {
          success: data.success,
          url,
          markdown: mdOut,
          wordCount: markdown.split(/\s+/).length,
          truncated,
          title: data.data?.metadata?.title ?? "",
          description: data.data?.metadata?.description ?? "",
          links: (data.data?.links ?? []).slice(0, 20),
          extractedData: data.data?.json ?? null,
          metadata: data.data?.metadata ?? {},
        };
      }

      // ── SEARCH: search web + extract content in one call ─────────────────────
      case "search": {
        const query = String(args.query ?? "");
        if (!query) return { error: "query is required for search mode" };

        const limit = Math.min(Number(args.limit ?? 5), 10);
        const scrapeContent = Boolean(args.scrapeContent ?? true);
        const lang = String(args.lang ?? "en");
        const country = args.country as string | undefined;

        const body: Record<string, unknown> = {
          query,
          limit,
          lang,
          ...(country && { country }),
          ...(scrapeContent && {
            scrapeOptions: {
              formats: ["markdown"],
            },
          }),
        };

        const res = await fetch(`${FIRECRAWL_BASE}/search`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Firecrawl search failed: ${res.status} — ${err.slice(0, 300)}` };
        }

        const data = await res.json() as {
          success: boolean;
          data: Array<{
            url: string;
            title?: string;
            description?: string;
            markdown?: string;
          }>;
        };

        // Truncate per-result markdown to avoid massive token usage
        const results = (data.data ?? []).map((r) => ({
          url: r.url,
          title: r.title ?? "",
          description: r.description ?? "",
          // 2000 chars per result is enough for synthesis
          content: (r.markdown ?? "").slice(0, 2000),
        }));

        return {
          success: data.success,
          query,
          resultCount: results.length,
          results,
        };
      }

      // ── CRAWL: crawl entire website (async job) ───────────────────────────────
      case "crawl": {
        const url = String(args.url ?? "");
        if (!url) return { error: "url is required for crawl mode" };

        const limit = Math.min(Number(args.limit ?? 20), 100);
        const prompt = args.prompt as string | undefined; // natural language crawl directive

        const body: Record<string, unknown> = {
          url,
          limit,
          scrapeOptions: { formats: ["markdown"] },
          ...(prompt && { prompt }),
        };

        const res = await fetch(`${FIRECRAWL_BASE}/crawl`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Firecrawl crawl failed: ${res.status} — ${err.slice(0, 300)}` };
        }

        const data = await res.json() as { success: boolean; id: string };
        return {
          success: data.success,
          crawlJobId: data.id,
          note: `Crawl started. Poll with: GET ${FIRECRAWL_BASE}/crawl/${data.id} using your FIRECRAWL_API_KEY. Or call firecrawl with mode='crawl_status' and crawlJobId='${data.id}'`,
          url,
          limit,
        };
      }

      // ── CRAWL STATUS: poll a running crawl job ────────────────────────────────
      case "extract": {
        const crawlJobId = String(args.crawlJobId ?? "");
        if (!crawlJobId) return { error: "crawlJobId is required for extract (crawl status) mode" };

        const res = await fetch(`${FIRECRAWL_BASE}/crawl/${crawlJobId}`, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Failed to get crawl status: ${res.status} — ${err.slice(0, 200)}` };
        }

        const data = await res.json() as {
          status: string;
          completed: number;
          total: number;
          data?: Array<{
            markdown?: string;
            metadata?: { title?: string; sourceURL?: string };
          }>;
        };

        const pages = (data.data ?? []).slice(0, 10).map((p) => ({
          url: p.metadata?.sourceURL ?? "",
          title: p.metadata?.title ?? "",
          content: (p.markdown ?? "").slice(0, 1500),
        }));

        return {
          status: data.status,
          progress: `${data.completed ?? 0}/${data.total ?? 0} pages`,
          isComplete: data.status === "completed",
          crawlJobId,
          pages,
        };
      }

      default:
        return { error: `Unknown firecrawl mode: ${mode}. Use: scrape, search, crawl, extract` };
    }
  } catch (err) {
    return { error: `Firecrawl execution failed: ${String(err)}` };
  }
}