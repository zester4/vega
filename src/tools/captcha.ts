/**
 * ============================================================================
 * src/tools/captcha.ts — VEGA CAPTCHA Bypass Engine
 * ============================================================================
 *
 * Supports: reCAPTCHA v2, reCAPTCHA v3, hCaptcha, Cloudflare Turnstile,
 *           image captchas, text captchas.
 *
 * Providers (auto-selected by env var presence):
 *   CAPSOLVER_API_KEY  → CapSolver (preferred, better Turnstile + Arkose support)
 *   TWOCAPTCHA_API_KEY → 2captcha (fallback, larger solver pool)
 *
 * Flow:
 *   1. cf_captcha_detect  → navigate to page, auto-detect captcha type & sitekey
 *   2. cf_captcha_solve   → submit to solver, poll result (avg 8-15s), return token
 *   3. cf_captcha_inject  → inject token into page + optionally submit form
 *
 * Or use cf_captcha_bypass for a fully automatic end-to-end flow.
 *
 * Works alongside cf_browse_page/cf_fill_form for seamless automation.
 *
 * Human fingerprinting:
 *   - Rotates real Chrome user agents
 *   - Adds human-like mouse movement before solving
 *   - Randomizes viewport and timezone
 *   - Sets realistic browser headers (Accept-Language, Sec-Ch-Ua etc.)
 *   This dramatically reduces captcha trigger rate before solving is even needed.
 *
 * Env vars required (add to wrangler.toml + Vercel):
 *   CAPSOLVER_API_KEY   → https://capsolver.com (recommended)
 *   TWOCAPTCHA_API_KEY  → https://2captcha.com (fallback)
 *
 * ============================================================================
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type CaptchaType =
    | "recaptcha_v2"
    | "recaptcha_v3"
    | "hcaptcha"
    | "turnstile"    // Cloudflare Turnstile
    | "image"        // Image/text captcha (screenshot-based)
    | "unknown";

export type SolveResult = {
    token: string;
    type: CaptchaType;
    solvedIn: number; // ms
    provider: "capsolver" | "2captcha";
};

// ─── Real Chrome User Agent Pool ─────────────────────────────────────────────
// Rotated per request to avoid bot fingerprinting. All are real Chrome builds.

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

function randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Human-like Browser Setup ────────────────────────────────────────────────

/**
 * Configure a Puppeteer page to look like a real human browser.
 * This is the #1 captcha prevention technique — make the browser
 * indistinguishable from a real user before a captcha even appears.
 */
async function humanizePage(page: any): Promise<void> {
    const ua = randomUA();

    await page.setUserAgent(ua);

    // Set realistic viewport with slight randomness
    await page.setViewport({
        width: 1280 + Math.floor(Math.random() * 200),
        height: 800 + Math.floor(Math.random() * 100),
        deviceScaleFactor: 1,
        hasTouch: false,
        isLandscape: true,
        isMobile: false,
    });

    // Set real browser headers
    await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    });

    // Override navigator properties to hide automation signs
    await page.evaluateOnNewDocument(() => {
        // Remove webdriver flag
        Object.defineProperty(navigator, "webdriver", { get: () => false });

        // Make plugins look real
        Object.defineProperty(navigator, "plugins", {
            get: () => [
                { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
                { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
                { name: "Native Client", filename: "internal-nacl-plugin" },
            ],
        });

        // Real language list
        Object.defineProperty(navigator, "languages", {
            get: () => ["en-US", "en"],
        });

        // Hide headless chrome signs
        (window as any).chrome = {
            runtime: {},
            loadTimes: () => { },
            csi: () => { },
            app: {},
        };

        // Override permission query to avoid detection
        const originalQuery = window.navigator.permissions?.query;
        if (originalQuery) {
            window.navigator.permissions.query = (parameters: any) =>
                parameters.name === "notifications"
                    ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
                    : originalQuery(parameters);
        }
    });
}

/**
 * Simulate human-like random mouse movement before interacting.
 * Captcha systems track mouse behavior as a bot signal.
 */
async function humanMouseMove(page: any): Promise<void> {
    try {
        const moves = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < moves; i++) {
            const x = 100 + Math.floor(Math.random() * 900);
            const y = 100 + Math.floor(Math.random() * 600);
            await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
            await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
        }
    } catch { /* non-fatal */ }
}

// ─── CAPTCHA Detection ────────────────────────────────────────────────────────

export type DetectedCaptcha = {
    type: CaptchaType;
    sitekey: string | null;
    found: boolean;
    pageUrl: string;
};

/**
 * Scan a loaded Puppeteer page for captcha presence.
 * Returns type, sitekey, and page URL needed for the solver API.
 */
async function detectCaptchaOnPage(page: any): Promise<DetectedCaptcha> {
    const pageUrl = page.url();

    const result = await page.evaluate(() => {
        // reCAPTCHA v2/v3
        const recaptchaDiv = document.querySelector(
            ".g-recaptcha, [data-sitekey], iframe[src*='recaptcha']"
        ) as HTMLElement | null;
        if (recaptchaDiv) {
            const sitekey =
                recaptchaDiv.getAttribute("data-sitekey") ??
                (document.querySelector("script[src*='recaptcha']")
                    ? new URL(
                        (document.querySelector("script[src*='recaptcha']") as HTMLScriptElement).src
                    ).searchParams.get("render")
                    : null);
            // Check if it's v3 (render= in script src)
            const isV3 = !!document.querySelector("script[src*='recaptcha/api.js?render=']");
            return { type: isV3 ? "recaptcha_v3" : "recaptcha_v2", sitekey };
        }

        // hCaptcha
        const hcaptcha = document.querySelector(
            ".h-captcha, [data-hcaptcha-sitekey], iframe[src*='hcaptcha']"
        ) as HTMLElement | null;
        if (hcaptcha) {
            const sitekey =
                hcaptcha.getAttribute("data-sitekey") ??
                hcaptcha.getAttribute("data-hcaptcha-sitekey");
            return { type: "hcaptcha", sitekey };
        }

        // Cloudflare Turnstile
        const turnstile = document.querySelector(
            ".cf-turnstile, [data-sitekey][data-theme], iframe[src*='challenges.cloudflare.com']"
        ) as HTMLElement | null;
        if (turnstile) {
            return { type: "turnstile", sitekey: turnstile.getAttribute("data-sitekey") };
        }

        // Fallback: image captcha (look for captcha image)
        const captchaImg = document.querySelector(
            "img[src*='captcha'], img[alt*='captcha' i], img[id*='captcha' i]"
        );
        if (captchaImg) return { type: "image", sitekey: null };

        return { type: "unknown", sitekey: null };
    });

    return {
        type: result.type as CaptchaType,
        sitekey: result.sitekey,
        found: result.type !== "unknown",
        pageUrl,
    };
}

// ─── CapSolver API ────────────────────────────────────────────────────────────

async function solveWithCapSolver(
    apiKey: string,
    captcha: DetectedCaptcha,
): Promise<string> {
    const baseUrl = "https://api.capsolver.com";

    // Build task based on captcha type
    let task: Record<string, unknown>;

    switch (captcha.type) {
        case "recaptcha_v2":
            task = {
                type: "ReCaptchaV2TaskProxyless",
                websiteURL: captcha.pageUrl,
                websiteKey: captcha.sitekey,
            };
            break;
        case "recaptcha_v3":
            task = {
                type: "ReCaptchaV3TaskProxyless",
                websiteURL: captcha.pageUrl,
                websiteKey: captcha.sitekey,
                pageAction: "submit",
                minScore: 0.7,
            };
            break;
        case "hcaptcha":
            task = {
                type: "HCaptchaTaskProxyless",
                websiteURL: captcha.pageUrl,
                websiteKey: captcha.sitekey,
            };
            break;
        case "turnstile":
            task = {
                type: "AntiTurnstileTaskProxyless",
                websiteURL: captcha.pageUrl,
                websiteKey: captcha.sitekey,
            };
            break;
        default:
            throw new Error(`CapSolver: unsupported captcha type '${captcha.type}'`);
    }

    // Create task
    const createRes = await fetch(`${baseUrl}/createTask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, task }),
    });
    const created = await createRes.json() as { errorId: number; taskId?: string; errorDescription?: string };

    if (created.errorId !== 0 || !created.taskId) {
        throw new Error(`CapSolver create failed: ${created.errorDescription ?? "unknown error"}`);
    }

    const taskId = created.taskId;

    // Poll for result (max 30s, 2s intervals)
    const deadline = Date.now() + 28_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));

        const pollRes = await fetch(`${baseUrl}/getTaskResult`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey, taskId }),
        });
        const poll = await pollRes.json() as {
            errorId: number;
            status: "idle" | "processing" | "ready" | "failed";
            solution?: { gRecaptchaResponse?: string; token?: string; userAgent?: string };
            errorDescription?: string;
        };

        if (poll.status === "ready" && poll.solution) {
            return (
                poll.solution.gRecaptchaResponse ??
                poll.solution.token ??
                ""
            );
        }
        if (poll.status === "failed") {
            throw new Error(`CapSolver: task failed — ${poll.errorDescription ?? "unknown"}`);
        }
    }

    throw new Error("CapSolver: timed out waiting for solution (>28s)");
}

// ─── 2captcha API ─────────────────────────────────────────────────────────────

async function solveWith2Captcha(
    apiKey: string,
    captcha: DetectedCaptcha,
): Promise<string> {
    const baseUrl = "https://2captcha.com";

    // Submit task
    const params = new URLSearchParams({ key: apiKey, json: "1" });

    switch (captcha.type) {
        case "recaptcha_v2":
            params.set("method", "userrecaptcha");
            params.set("googlekey", captcha.sitekey ?? "");
            params.set("pageurl", captcha.pageUrl);
            break;
        case "recaptcha_v3":
            params.set("method", "userrecaptcha");
            params.set("version", "v3");
            params.set("googlekey", captcha.sitekey ?? "");
            params.set("pageurl", captcha.pageUrl);
            params.set("action", "submit");
            params.set("min_score", "0.7");
            break;
        case "hcaptcha":
            params.set("method", "hcaptcha");
            params.set("sitekey", captcha.sitekey ?? "");
            params.set("pageurl", captcha.pageUrl);
            break;
        case "turnstile":
            params.set("method", "turnstile");
            params.set("sitekey", captcha.sitekey ?? "");
            params.set("pageurl", captcha.pageUrl);
            break;
        default:
            throw new Error(`2captcha: unsupported captcha type '${captcha.type}'`);
    }

    const submitRes = await fetch(`${baseUrl}/in.php?${params.toString()}`);
    const submitText = await submitRes.text();
    let captchaId: string;

    try {
        const j = JSON.parse(submitText);
        if (j.status !== 1) throw new Error(j.error ?? "submission failed");
        captchaId = String(j.request);
    } catch {
        if (submitText.startsWith("OK|")) {
            captchaId = submitText.split("|")[1];
        } else {
            throw new Error(`2captcha submit error: ${submitText}`);
        }
    }

    // Poll for result (max 28s)
    const deadline = Date.now() + 28_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));

        const pollRes = await fetch(
            `${baseUrl}/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`
        );
        const pollText = await pollRes.text();

        try {
            const j = JSON.parse(pollText);
            if (j.status === 1) return String(j.request);
            if (j.request === "ERROR_CAPTCHA_UNSOLVABLE") throw new Error("2captcha: unsolvable");
            if (j.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha error: ${j.request}`);
        } catch (parseErr) {
            if (pollText.startsWith("OK|")) return pollText.split("|")[1];
            if (!pollText.includes("NOT_READY")) throw parseErr;
        }
    }

    throw new Error("2captcha: timed out waiting for solution (>28s)");
}

// ─── Token Injection ──────────────────────────────────────────────────────────

/**
 * Inject the solved captcha token into the page.
 * Handles all major captcha types correctly.
 * Optionally submits the form after injection.
 */
async function injectToken(
    page: any,
    token: string,
    type: CaptchaType,
    submitSelector?: string
): Promise<{ injected: boolean; submitted: boolean }> {
    let injected = false;

    try {
        await page.evaluate(
            ({ token, type }: { token: string; type: string }) => {
                switch (type) {
                    case "recaptcha_v2":
                    case "recaptcha_v3": {
                        // Standard injection: set hidden textarea value
                        const el = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement | null;
                        if (el) {
                            el.style.display = "block";
                            el.value = token;
                            el.dispatchEvent(new Event("input", { bubbles: true }));
                            el.dispatchEvent(new Event("change", { bubbles: true }));
                        }
                        // Also call the callback if present
                        const container = document.querySelector(".g-recaptcha") as HTMLElement | null;
                        const callbackName = container?.getAttribute("data-callback");
                        if (callbackName && typeof (window as any)[callbackName] === "function") {
                            (window as any)[callbackName](token);
                        }
                        // Fallback: ___grecaptcha_cfg callback
                        if ((window as any).___grecaptcha_cfg?.clients) {
                            const clients = (window as any).___grecaptcha_cfg.clients;
                            Object.keys(clients).forEach((k) => {
                                const client = clients[k];
                                Object.keys(client).forEach((key) => {
                                    if (client[key]?.callback) client[key].callback(token);
                                });
                            });
                        }
                        break;
                    }
                    case "hcaptcha": {
                        // hCaptcha injection
                        const el = document.querySelector(
                            "[name='h-captcha-response'], textarea[id*='hcaptcha']"
                        ) as HTMLTextAreaElement | null;
                        if (el) {
                            el.value = token;
                            el.dispatchEvent(new Event("input", { bubbles: true }));
                        }
                        // Call hcaptcha callback
                        if ((window as any).hcaptcha) {
                            (window as any).hcaptcha.setResponse(token);
                        }
                        break;
                    }
                    case "turnstile": {
                        // Cloudflare Turnstile injection
                        const el = document.querySelector(
                            "[name='cf-turnstile-response'], input[type='hidden']"
                        ) as HTMLInputElement | null;
                        if (el) el.value = token;
                        if ((window as any).turnstile) {
                            (window as any).turnstile.reset();
                        }
                        break;
                    }
                }
            },
            { token, type }
        );
        injected = true;
    } catch (injErr) {
        console.error("[captcha] Token injection error:", injErr);
    }

    // Optional: submit the form
    let submitted = false;
    if (submitSelector && injected) {
        try {
            await humanMouseMove(page);
            await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
            await page.click(submitSelector);
            await page.waitForNavigation({ timeout: 8000, waitUntil: "domcontentloaded" }).catch(() => { });
            submitted = true;
        } catch { /* navigation may not always fire */ }
    }

    return { injected, submitted };
}

// ─── Main Exported Functions ──────────────────────────────────────────────────

/**
 * Full end-to-end captcha bypass on an already-loaded page.
 * Returns the token and injects it automatically.
 */
export async function bypassCaptchaOnPage(
    page: any,
    env: Env,
    submitSelector?: string
): Promise<{
    success: boolean;
    token?: string;
    type?: CaptchaType;
    solvedIn?: number;
    error?: string;
}> {
    const detected = await detectCaptchaOnPage(page);

    if (!detected.found || detected.type === "unknown") {
        return { success: false, error: "No solvable captcha detected on this page." };
    }

    if (!detected.sitekey && detected.type !== "image") {
        return { success: false, error: `Captcha detected (${detected.type}) but could not extract sitekey.` };
    }

    const t0 = Date.now();
    let token: string;
    let provider: "capsolver" | "2captcha";

    try {
        const capsolverKey = (env as any).CAPSOLVER_API_KEY;
        const twocaptchaKey = (env as any).TWOCAPTCHA_API_KEY;

        if (!capsolverKey && !twocaptchaKey) {
            return {
                success: false,
                error: "No captcha solver API key configured. Set CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY.",
            };
        }

        if (capsolverKey) {
            token = await solveWithCapSolver(capsolverKey, detected);
            provider = "capsolver";
        } else {
            token = await solveWith2Captcha(twocaptchaKey, detected);
            provider = "2captcha";
        }
    } catch (solveErr) {
        return { success: false, error: `Solver failed: ${String(solveErr)}` };
    }

    const solvedIn = Date.now() - t0;

    // Inject into page
    const { injected } = await injectToken(page, token, detected.type, submitSelector);

    return {
        success: injected,
        token,
        type: detected.type,
        solvedIn,
    };
}

// ─── Tool Declarations ────────────────────────────────────────────────────────

export const CAPTCHA_TOOL_DECLARATIONS = [
    {
        name: "cf_captcha_bypass",
        description:
            "⚠️ REQUIRES APPROVAL for form submission. " +
            "Automatically detect and bypass a CAPTCHA on a web page using a real Chromium browser + AI solver service. " +
            "Supports: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, image captchas. " +
            "Use this when cf_browse_page or cf_fill_form fails because of a captcha. " +
            "ALWAYS pair with human fingerprinting (automatically applied). " +
            "Returns the solved token and optionally submits the form. " +
            "Requires CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY in vault or env.",
        parameters: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The URL with the captcha to solve.",
                },
                submit_selector: {
                    type: "string",
                    description: "Optional CSS selector of the submit button to click after solving.",
                },
                wait_for: {
                    type: "string",
                    description: "Optional CSS selector to wait for after submission.",
                },
                pre_fill: {
                    type: "object",
                    description: "Optional form fields to fill before solving. CSS selector → value map.",
                },
            },
            required: ["url"],
        },
    },
    {
        name: "cf_captcha_detect",
        description:
            "Scan a web page to detect what type of CAPTCHA is present (reCAPTCHA v2/v3, hCaptcha, Turnstile, etc.) " +
            "and extract the sitekey needed to solve it. " +
            "Use before cf_captcha_bypass to understand what you're dealing with.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL to scan for captchas." },
            },
            required: ["url"],
        },
    },
    {
        name: "cf_stealth_browse",
        description:
            "Browse a web page with full human fingerprinting applied — real Chrome user agent, " +
            "randomized viewport, mouse movement simulation, and anti-bot header stack. " +
            "Use this instead of cf_browse_page when a site is blocking headless browsers " +
            "or showing CAPTCHAs frequently. Returns full page text and title.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL to browse stealthily." },
                wait_for: { type: "string", description: "Optional CSS selector to wait for." },
                extract_selector: { type: "string", description: "Optional CSS selector to extract." },
            },
            required: ["url"],
        },
    },
];

// ─── Tool Executor (add to executeCfBrowserTool switch) ───────────────────────

export async function executeCaptchaTool(
    toolName: string,
    args: Record<string, unknown>,
    env: Env
): Promise<Record<string, unknown>> {
    if (!env.MYBROWSER) {
        return { error: "MYBROWSER binding not configured. Required for captcha bypass." };
    }

    const puppeteer = await import("@cloudflare/puppeteer");

    async function acquireBrowser() {
        const sessionMeta = await (puppeteer as any).default
            .sessions(env.MYBROWSER)
            .catch(() => []) as Array<{ sessionId: string; connectionId?: string }>;

        const freeSessions = sessionMeta.filter((s) => !s.connectionId);
        for (const session of freeSessions) {
            try {
                return await (puppeteer as any).default.connect(env.MYBROWSER, session.sessionId);
            } catch { /* try next */ }
        }
        return await (puppeteer as any).default.launch(env.MYBROWSER);
    }

    try {
        switch (toolName) {

            case "cf_captcha_detect": {
                const { url } = args as { url: string };
                const browser = await acquireBrowser();
                const page = await browser.newPage();
                try {
                    await humanizePage(page);
                    await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
                    const detected = await detectCaptchaOnPage(page);
                    return {
                        found: detected.found,
                        type: detected.type,
                        sitekey: detected.sitekey,
                        pageUrl: detected.pageUrl,
                        message: detected.found
                            ? `Found ${detected.type} captcha${detected.sitekey ? ` (sitekey: ${detected.sitekey.slice(0, 20)}...)` : ""}`
                            : "No captcha detected — page may be accessible without solving.",
                    };
                } finally {
                    await page.close().catch(() => { });
                    await browser.disconnect().catch(() => { });
                }
            }

            case "cf_captcha_bypass": {
                const {
                    url,
                    submit_selector,
                    wait_for,
                    pre_fill,
                } = args as {
                    url: string;
                    submit_selector?: string;
                    wait_for?: string;
                    pre_fill?: Record<string, string>;
                };

                const capsolverKey = (env as any).CAPSOLVER_API_KEY;
                const twocaptchaKey = (env as any).TWOCAPTCHA_API_KEY;
                if (!capsolverKey && !twocaptchaKey) {
                    return {
                        error: "Configure CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY in your vault or env vars.",
                        hint: "Get a CapSolver key at https://capsolver.com (free credits available)",
                    };
                }

                const browser = await acquireBrowser();
                const page = await browser.newPage();
                try {
                    await humanizePage(page);
                    await humanMouseMove(page);
                    await page.goto(url, { waitUntil: "networkidle0", timeout: 22_000 });

                    // Pre-fill form fields before solving (e.g., email/password)
                    if (pre_fill) {
                        for (const [selector, value] of Object.entries(pre_fill)) {
                            try {
                                await page.waitForSelector(selector, { timeout: 3000 });
                                await page.click(selector);
                                await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
                                await page.type(selector, String(value), { delay: 40 + Math.random() * 60 });
                            } catch { /* field may not be present */ }
                        }
                    }

                    const result = await bypassCaptchaOnPage(page, env, submit_selector);

                    // Wait for result selector if provided
                    if (result.success && wait_for) {
                        await page.waitForSelector(wait_for, { timeout: 8000 }).catch(() => { });
                    }

                    const finalText = await page.evaluate(() =>
                        document.body?.innerText?.slice(0, 2000) ?? ""
                    ).catch(() => "");

                    return {
                        ...result,
                        finalUrl: page.url(),
                        pageText: finalText,
                    };
                } finally {
                    await page.close().catch(() => { });
                    await browser.disconnect().catch(() => { });
                }
            }

            case "cf_stealth_browse": {
                const { url, wait_for, extract_selector } = args as {
                    url: string;
                    wait_for?: string;
                    extract_selector?: string;
                };

                const browser = await acquireBrowser();
                const page = await browser.newPage();
                try {
                    await humanizePage(page);
                    await page.goto(url, { waitUntil: "networkidle0", timeout: 22_000 });

                    await humanMouseMove(page);

                    if (wait_for) {
                        await page.waitForSelector(wait_for, { timeout: 5000 }).catch(() => { });
                    }

                    // Check for captcha after load
                    const detected = await detectCaptchaOnPage(page);
                    if (detected.found) {
                        return {
                            blocked: true,
                            captchaType: detected.type,
                            message: `Page has a ${detected.type} captcha. Use cf_captcha_bypass to solve it first.`,
                            url,
                        };
                    }

                    const [title, text, extracted] = await Promise.all([
                        page.title(),
                        page.evaluate(() => document.body?.innerText?.slice(0, 15000) ?? ""),
                        extract_selector
                            ? page.evaluate(
                                (sel: string) =>
                                    Array.from(document.querySelectorAll(sel))
                                        .map((el: any) => el.innerText)
                                        .join("\n"),
                                extract_selector
                            ).catch(() => null)
                            : Promise.resolve(null),
                    ]);

                    return {
                        url: page.url(),
                        title,
                        text,
                        extracted: extracted ?? undefined,
                        fingerprinted: true,
                    };
                } finally {
                    await page.close().catch(() => { });
                    await browser.disconnect().catch(() => { });
                }
            }

            default:
                return { error: `Unknown captcha tool: ${toolName}` };
        }
    } catch (err) {
        const msg = String(err);
        if (msg.includes("allowedBrowserAcquisitions") || msg.includes("rate limit")) {
            return { error: "CF Browser rate-limited. Retry in 30s.", retryable: true };
        }
        return { error: msg };
    }
}