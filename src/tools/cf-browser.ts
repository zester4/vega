/**
 * ============================================================================
 * src/tools/cf-browser.ts — Cloudflare Browser Rendering Agent Tools
 * ============================================================================
 *
 * Uses @cloudflare/puppeteer (CF's fork) with the MYBROWSER binding.
 *
 * Session reuse strategy (from CF docs, 2025):
 *   Instead of launching a new browser per call (expensive), we:
 *   1. List existing sessions via puppeteer.sessions(env.MYBROWSER).
 *   2. Connect to a free session if available (browser.disconnect() keeps it alive).
 *   3. Launch a new session only if all are busy or none exist.
 *   This cuts latency by ~2s per call and stays under CF's 2 new-browsers/min limit.
 *
 * Rate limit awareness:
 *   CF Browser Rendering limits to 2 NEW browser sessions per minute per account.
 *   Session reuse means most calls don't count toward this limit.
 *   If rate-limited, we return a clear error rather than hanging.
 *
 * wrangler.toml additions required:
 *   [browser]
 *   binding = "MYBROWSER"
 *   compatibility_flags = ["nodejs_compat"]   # already present in your config
 *
 * npm install:
 *   npm install --save-dev @cloudflare/puppeteer
 *
 * Tools provided:
 *   cf_browse_page    → fetch full rendered HTML + text (replaces browse_web for JS-heavy pages)
 *   cf_screenshot     → take a screenshot → save to R2 → return URL
 *   cf_extract_data   → run a CSS/text extraction on a page → return structured data
 *   cf_fill_form      → fill and submit a form (REQUIRES APPROVAL)
 *   cf_click          → click an element (REQUIRES APPROVAL)
 *
 * ============================================================================
 */

import type { Browser, Page } from "@cloudflare/puppeteer";

// ─── Session Manager ──────────────────────────────────────────────────────────

/**
 * Acquire a browser session using CF's session-reuse pattern.
 * Caller MUST call browser.disconnect() (not close()) when done,
 * so the session stays alive for the next caller.
 */
async function acquireBrowser(env: Env): Promise<Browser> {
    // Dynamically import to avoid compile errors when binding is absent
    const puppeteer = await import("@cloudflare/puppeteer");

    // Check rate-limit headroom
    const sessionMeta = await (puppeteer as any).default
        .sessions(env.MYBROWSER)
        .catch(() => []) as Array<{ sessionId: string; connectionId?: string }>;

    // Try to connect to a free (no active connection) session
    const freeSessions = sessionMeta.filter((s) => !s.connectionId);

    for (const session of freeSessions) {
        try {
            const browser = await (puppeteer as any).default.connect(
                env.MYBROWSER,
                session.sessionId
            );
            return browser as Browser;
        } catch {
            // Session closed or acquired by another Worker — try next
        }
    }

    // No free session — launch a new one
    // CF will throw if rate-limited; we let that propagate as a clear error
    const browser = await (puppeteer as any).default.launch(env.MYBROWSER);
    return browser as Browser;
}

/** Navigation timeout in ms. */
const NAV_TIMEOUT_MS = 25_000; // stay well inside CF's 30s CPU budget

/** Truncate large HTML payloads before sending to Gemini. */
const MAX_HTML_CHARS = 50_000;
const MAX_TEXT_CHARS = 15_000;

// ─── cf_browse_page ───────────────────────────────────────────────────────────

export async function cfBrowsePage(
    env: Env,
    args: { url: string; wait_for?: string; extract_selector?: string }
): Promise<{
    url: string;
    title: string;
    text: string;
    html?: string;
    extracted?: string;
    loadTimeMs: number;
}> {
    const browser = await acquireBrowser(env);
    const page: Page = await browser.newPage();
    const t0 = Date.now();

    try {
        await page.setUserAgent(
            "Mozilla/5.0 (compatible; VEGA-Agent/1.0; +https://vega.ai)"
        );
        await page.goto(args.url, {
            waitUntil: "networkidle0",
            timeout: NAV_TIMEOUT_MS,
        });

        // Optional: wait for a selector before extracting
        if (args.wait_for) {
            await page
                .waitForSelector(args.wait_for, { timeout: 5000 })
                .catch(() => { }); // non-fatal
        }

        const [title, text, html, extracted] = await Promise.all([
            page.title(),
            page.evaluate(() => document.body?.innerText ?? ""),
            page.content(),
            args.extract_selector
                ? page.evaluate(
                    (sel) =>
                        Array.from(document.querySelectorAll(sel))
                            .map((el) => (el as HTMLElement).innerText)
                            .join("\n"),
                    args.extract_selector
                ).catch(() => null)
                : Promise.resolve(null),
        ]);

        return {
            url: page.url(),
            title,
            text: text.slice(0, MAX_TEXT_CHARS),
            html: html.slice(0, MAX_HTML_CHARS),
            extracted: extracted ?? undefined,
            loadTimeMs: Date.now() - t0,
        };
    } finally {
        await page.close().catch(() => { });
        await browser.disconnect().catch(() => { }); // keep session alive
    }
}

// ─── cf_screenshot ────────────────────────────────────────────────────────────

export async function cfScreenshot(
    env: Env,
    args: {
        url: string;
        full_page?: boolean;
        width?: number;
        height?: number;
    }
): Promise<{ url: string; r2_path: string; width: number; height: number }> {
    if (!env.FILES_BUCKET) {
        throw new Error("FILES_BUCKET not bound — cannot store screenshot.");
    }

    const browser = await acquireBrowser(env);
    const page: Page = await browser.newPage();

    try {
        const width = args.width ?? 1280;
        const height = args.height ?? 800;

        await page.setViewport({ width, height });
        await page.setUserAgent(
            "Mozilla/5.0 (compatible; VEGA-Agent/1.0; +https://vega.ai)"
        );
        await page.goto(args.url, {
            waitUntil: "networkidle0",
            timeout: NAV_TIMEOUT_MS,
        });

        const screenshotBuffer = await page.screenshot({
            type: "jpeg",
            quality: 85,
            fullPage: args.full_page ?? false,
        });

        const r2Path = `screenshots/${Date.now()}-${encodeURIComponent(
            new URL(args.url).hostname
        )}.jpg`;

        await env.FILES_BUCKET.put(r2Path, screenshotBuffer, {
            httpMetadata: { contentType: "image/jpeg" },
            customMetadata: { source: args.url, capturedAt: new Date().toISOString() },
        });

        const publicUrl = `${(env as any).WORKER_URL ?? ""}/files/${r2Path}`;

        return { url: publicUrl, r2_path: r2Path, width, height };
    } finally {
        await page.close().catch(() => { });
        await browser.disconnect().catch(() => { });
    }
}

// ─── cf_extract_data ─────────────────────────────────────────────────────────

export async function cfExtractData(
    env: Env,
    args: {
        url: string;
        selectors: Record<string, string>; // { fieldName: "css selector" }
        wait_for?: string;
    }
): Promise<{
    url: string;
    data: Record<string, string | string[]>;
    extractedAt: string;
}> {
    const browser = await acquireBrowser(env);
    const page: Page = await browser.newPage();

    try {
        await page.setUserAgent(
            "Mozilla/5.0 (compatible; VEGA-Agent/1.0; +https://vega.ai)"
        );
        await page.goto(args.url, {
            waitUntil: "networkidle0",
            timeout: NAV_TIMEOUT_MS,
        });

        if (args.wait_for) {
            await page.waitForSelector(args.wait_for, { timeout: 5000 }).catch(() => { });
        }

        const data: Record<string, string | string[]> = {};

        for (const [field, selector] of Object.entries(args.selectors)) {
            data[field] = await page
                .evaluate((sel) => {
                    const els = document.querySelectorAll(sel);
                    if (els.length === 0) return null;
                    if (els.length === 1) return (els[0] as HTMLElement).innerText?.trim() ?? null;
                    return Array.from(els).map((el) => (el as HTMLElement).innerText?.trim() ?? "");
                }, selector)
                .catch(() => null) as string | string[];
        }

        return {
            url: page.url(),
            data,
            extractedAt: new Date().toISOString(),
        };
    } finally {
        await page.close().catch(() => { });
        await browser.disconnect().catch(() => { });
    }
}

// ─── cf_fill_form (requires approval) ────────────────────────────────────────

export async function cfFillForm(
    env: Env,
    args: {
        url: string;
        fields: Record<string, string>; // { selector: value }
        submit_selector?: string;
        wait_for_result?: string;
    }
): Promise<{
    url: string;
    success: boolean;
    resultText?: string;
    screenshotPath?: string;
}> {
    const browser = await acquireBrowser(env);
    const page: Page = await browser.newPage();

    try {
        await page.setUserAgent(
            "Mozilla/5.0 (compatible; VEGA-Agent/1.0; +https://vega.ai)"
        );
        await page.goto(args.url, {
            waitUntil: "networkidle0",
            timeout: NAV_TIMEOUT_MS,
        });

        // Fill each field
        for (const [selector, value] of Object.entries(args.fields)) {
            await page.waitForSelector(selector, { timeout: 5000 });
            await page.click(selector, { clickCount: 3 }); // select all first
            await page.type(selector, value, { delay: 30 });
        }

        let resultText: string | undefined;
        let screenshotPath: string | undefined;

        if (args.submit_selector) {
            await page.click(args.submit_selector);

            if (args.wait_for_result) {
                await page
                    .waitForSelector(args.wait_for_result, { timeout: 10_000 })
                    .catch(() => { });
                resultText = await page
                    .evaluate(
                        (sel) => document.querySelector(sel)?.textContent?.trim() ?? "",
                        args.wait_for_result
                    )
                    .catch(() => undefined);
            } else {
                // Wait for navigation
                await page
                    .waitForNavigation({ timeout: 10_000, waitUntil: "networkidle0" })
                    .catch(() => { });
                resultText = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) ?? "");
            }
        }

        // Always take a post-action screenshot for verification
        if (env.FILES_BUCKET) {
            const buf = await page.screenshot({ type: "jpeg", quality: 80 });
            screenshotPath = `screenshots/form-result-${Date.now()}.jpg`;
            await env.FILES_BUCKET.put(screenshotPath, buf, {
                httpMetadata: { contentType: "image/jpeg" },
            }).catch(() => { });
        }

        return {
            url: page.url(),
            success: true,
            resultText,
            screenshotPath,
        };
    } finally {
        await page.close().catch(() => { });
        await browser.disconnect().catch(() => { });
    }
}

// ─── cf_click (requires approval) ────────────────────────────────────────────

export async function cfClick(
    env: Env,
    args: {
        url: string;
        selector: string;
        wait_for?: string;
    }
): Promise<{ url: string; success: boolean; resultText?: string }> {
    const browser = await acquireBrowser(env);
    const page: Page = await browser.newPage();

    try {
        await page.setUserAgent(
            "Mozilla/5.0 (compatible; VEGA-Agent/1.0; +https://vega.ai)"
        );
        await page.goto(args.url, {
            waitUntil: "networkidle0",
            timeout: NAV_TIMEOUT_MS,
        });

        await page.waitForSelector(args.selector, { timeout: 5000 });
        await page.click(args.selector);

        if (args.wait_for) {
            await page.waitForSelector(args.wait_for, { timeout: 8000 }).catch(() => { });
        } else {
            await page
                .waitForNavigation({ timeout: 5000, waitUntil: "domcontentloaded" })
                .catch(() => { });
        }

        const resultText = await page
            .evaluate(() => document.body?.innerText?.slice(0, 1000) ?? "")
            .catch(() => undefined);

        return { url: page.url(), success: true, resultText };
    } finally {
        await page.close().catch(() => { });
        await browser.disconnect().catch(() => { });
    }
}

// ─── Tool Declarations ────────────────────────────────────────────────────────
// Register in src/tools/builtins.ts

export const CF_BROWSER_DECLARATIONS = [
    {
        name: "cf_browse_page",
        description:
            "Browse a web page using a real headless Chromium browser (Cloudflare Browser Rendering). " +
            "Use this for JavaScript-heavy pages, SPAs, or pages that don't render with a simple fetch. " +
            "Returns the page title, full text content, and optionally extracted data from a CSS selector. " +
            "Prefer this over browse_web when the page requires JS execution.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL to navigate to." },
                wait_for: {
                    type: "string",
                    description: "Optional CSS selector to wait for before extracting content.",
                },
                extract_selector: {
                    type: "string",
                    description:
                        "Optional CSS selector — extract and return matching elements as text.",
                },
            },
            required: ["url"],
        },
    },
    {
        name: "cf_screenshot",
        description:
            "Take a full screenshot of a web page using a real headless browser. " +
            "The image is saved to R2 and a URL is returned. " +
            "Use this to visually verify a page, capture a chart, or document state.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL to screenshot." },
                full_page: {
                    type: "boolean",
                    description: "If true, capture the full scrollable page (not just viewport).",
                },
                width: { type: "number", description: "Viewport width in pixels (default 1280)." },
                height: { type: "number", description: "Viewport height in pixels (default 800)." },
            },
            required: ["url"],
        },
    },
    {
        name: "cf_extract_data",
        description:
            "Extract structured data from a web page using CSS selectors. " +
            "Specify a map of field names to CSS selectors. " +
            "Returns an object with each field populated from the matching DOM element(s).",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL to scrape." },
                selectors: {
                    type: "object",
                    description:
                        "Object mapping field names to CSS selectors. Example: { 'price': '.product-price', 'title': 'h1' }",
                },
                wait_for: {
                    type: "string",
                    description: "Optional CSS selector to wait for before extracting.",
                },
            },
            required: ["url", "selectors"],
        },
    },
    {
        name: "cf_fill_form",
        description:
            "⚠️ REQUIRES HUMAN APPROVAL. " +
            "Fill out and optionally submit a web form using a real headless browser. " +
            "Use for automating form submissions when the user has explicitly requested it. " +
            "Always request approval before executing. Takes a screenshot after submission for verification.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL of the page containing the form." },
                fields: {
                    type: "object",
                    description: "Object mapping CSS selectors to values. Example: { '#email': 'user@example.com' }",
                },
                submit_selector: {
                    type: "string",
                    description: "CSS selector of the submit button. If omitted, form is filled but not submitted.",
                },
                wait_for_result: {
                    type: "string",
                    description: "Optional CSS selector to wait for after submission (e.g. a success message).",
                },
            },
            required: ["url", "fields"],
        },
    },
    {
        name: "cf_click",
        description:
            "⚠️ REQUIRES HUMAN APPROVAL. " +
            "Click a specific element on a web page using a real headless browser. " +
            "Use for interacting with buttons, links, or toggles that require JS. " +
            "Always request approval before executing.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL of the page." },
                selector: { type: "string", description: "CSS selector of the element to click." },
                wait_for: {
                    type: "string",
                    description: "Optional CSS selector to wait for after the click.",
                },
            },
            required: ["url", "selector"],
        },
    },
];

// ─── Executor ─────────────────────────────────────────────────────────────────

export async function executeCfBrowserTool(
    toolName: string,
    args: Record<string, unknown>,
    env: Env
): Promise<unknown> {
    if (!env.MYBROWSER) {
        return {
            error:
                "MYBROWSER binding not configured. Add `[browser] binding = \"MYBROWSER\"` to wrangler.toml and redeploy.",
        };
    }

    try {
        switch (toolName) {
            case "cf_browse_page":
                return await cfBrowsePage(env, args as Parameters<typeof cfBrowsePage>[1]);

            case "cf_screenshot":
                return await cfScreenshot(env, args as Parameters<typeof cfScreenshot>[1]);

            case "cf_extract_data":
                return await cfExtractData(env, args as Parameters<typeof cfExtractData>[1]);

            case "cf_fill_form":
                return await cfFillForm(env, args as Parameters<typeof cfFillForm>[1]);

            case "cf_click":
                return await cfClick(env, args as Parameters<typeof cfClick>[1]);

            default:
                return { error: `Unknown cf-browser tool: ${toolName}` };
        }
    } catch (err: unknown) {
        const msg = String(err);
        // Surface rate-limit errors clearly
        if (msg.includes("allowedBrowserAcquisitions") || msg.includes("rate limit")) {
            return {
                error:
                    "CF Browser rate-limited (max 2 new sessions/min). A free session should be available shortly — retry in 30s.",
                retryable: true,
            };
        }
        return { error: msg };
    }
}