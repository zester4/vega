/**
 * ============================================================================
 * src/tools/market.ts — Live Market Intelligence (Yahoo Finance)
 * ============================================================================
 *
 * Yahoo Finance now requires a crumb + cookie from an initial browser visit.
 * CF Worker IPs are blocked without them. This module:
 *   1. Fetches a crumb by visiting finance.yahoo.com (once, cached in Redis 1hr)
 *   2. Passes the crumb + cookie to all subsequent API calls
 *   3. Retries once with a fresh crumb on 401/403
 *   4. Falls back to CoinGecko for crypto symbols (BTC, ETH, etc.)
 *
 * Actions:
 *   quote         → Real-time price (stocks, crypto, ETFs, forex, indices)
 *   multi_quote   → Batch quotes for up to 20 symbols
 *   history       → Historical OHLCV data
 *   search        → Find ticker symbols by company name
 *   portfolio     → All portfolio positions with current prices
 *   set_alert     → Store a price alert in Redis (checked by cron)
 *   list_alerts   → Show all active price alerts
 *   delete_alert  → Remove an alert
 *   news          → Latest market news for a symbol
 * ============================================================================
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const YF_QUOTE = "https://query2.finance.yahoo.com/v7/finance/quote";
const YF_CHART = "https://query2.finance.yahoo.com/v8/finance/chart";
const YF_SEARCH = "https://query2.finance.yahoo.com/v1/finance/search";
const YF_CRUMB = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_HOME = "https://finance.yahoo.com/";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

// Symbols that should use CoinGecko directly (no crumb needed)
const CRYPTO_COINGECKO_MAP: Record<string, string> = {
  "BTC-USD": "bitcoin",
  "ETH-USD": "ethereum",
  "SOL-USD": "solana",
  "ADA-USD": "cardano",
  "DOGE-USD": "dogecoin",
  "XRP-USD": "ripple",
  "BNB-USD": "binancecoin",
  "AVAX-USD": "avalanche-2",
  "MATIC-USD": "matic-network",
  "DOT-USD": "polkadot",
  "LINK-USD": "chainlink",
  "LTC-USD": "litecoin",
};

// Redis keys
const CRUMB_KEY = "market:yf:crumb";
const COOKIES_KEY = "market:yf:cookies";
const CRUMB_TTL = 60 * 55; // 55 minutes (crumb lasts ~1hr)

// ─── Yahoo Finance Auth ───────────────────────────────────────────────────────

interface YFAuth {
  crumb: string;
  cookies: string;
}

/**
 * Get a Yahoo Finance crumb, using Redis cache.
 * On cache miss, visits finance.yahoo.com to obtain session cookies + crumb.
 */
async function getYFAuth(env: Env, forceRefresh = false): Promise<YFAuth | null> {
  try {
    const { getRedis } = await import("../memory");
    const redis = getRedis(env);

    if (!forceRefresh) {
      const [cachedCrumb, cachedCookies] = await Promise.all([
        redis.get(CRUMB_KEY) as Promise<string | null>,
        redis.get(COOKIES_KEY) as Promise<string | null>,
      ]);
      if (cachedCrumb && cachedCookies) {
        return { crumb: cachedCrumb, cookies: cachedCookies };
      }
    }

    // Step 1: Visit finance.yahoo.com to get session cookies
    const homeRes = await fetch(YF_HOME, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });

    // Collect all cookies from the home page response
    const rawCookies = homeRes.headers.getSetCookie?.() ?? [];
    const cookies = rawCookies
      .map((c) => c.split(";")[0])
      .join("; ");

    if (!cookies) {
      console.warn("[market] No cookies from finance.yahoo.com — auth will likely fail");
    }

    // Step 2: Get the crumb using those cookies
    const crumbRes = await fetch(YF_CRUMB, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://finance.yahoo.com/",
        "Cookie": cookies,
        "Connection": "keep-alive",
      },
    });

    if (!crumbRes.ok) {
      console.warn(`[market] Crumb fetch failed: ${crumbRes.status}`);
      return null;
    }

    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.includes("<")) {
      // Got HTML instead of a crumb — Yahoo is blocking us
      console.warn("[market] Crumb response looks like HTML — likely blocked");
      return null;
    }

    // Cache in Redis
    await Promise.all([
      redis.set(CRUMB_KEY, crumb, { ex: CRUMB_TTL }),
      redis.set(COOKIES_KEY, cookies, { ex: CRUMB_TTL }),
    ]);

    console.log(`[market] Yahoo Finance crumb obtained: ${crumb.slice(0, 10)}...`);
    return { crumb, cookies };
  } catch (err) {
    console.error("[market] getYFAuth failed:", err);
    return null;
  }
}

/**
 * Build Yahoo Finance request headers with auth.
 */
function yfHeaders(auth: YFAuth): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://finance.yahoo.com/",
    "Cookie": auth.cookies,
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  };
}

/**
 * Fetch from Yahoo Finance with automatic crumb retry on 401/403.
 */
async function yfFetch(
  env: Env,
  url: string,
  opts: { retried?: boolean } = {}
): Promise<Response | null> {
  const auth = await getYFAuth(env, opts.retried ?? false);
  if (!auth) return null;

  // Add crumb to URL
  const separator = url.includes("?") ? "&" : "?";
  const urlWithCrumb = `${url}${separator}crumb=${encodeURIComponent(auth.crumb)}`;

  const res = await fetch(urlWithCrumb, { headers: yfHeaders(auth) });

  // On 401/403, refresh crumb once and retry
  if ((res.status === 401 || res.status === 403) && !opts.retried) {
    console.warn(`[market] YF returned ${res.status}, refreshing crumb and retrying...`);
    return yfFetch(env, url, { retried: true });
  }

  return res;
}

// ─── CoinGecko fallback for crypto ────────────────────────────────────────────

async function getCoinGeckoQuote(coinId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      `${COINGECKO_BASE}/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`,
      { headers: { "Accept": "application/json" } }
    );
    if (!res.ok) return null;

    const data = await res.json() as Record<string, {
      usd: number;
      usd_24h_change?: number;
      usd_market_cap?: number;
      usd_24h_vol?: number;
    }>;

    const coin = data[coinId];
    if (!coin) return null;

    const pct = coin.usd_24h_change ?? 0;
    return {
      price: coin.usd,
      change: Number((coin.usd * pct / 100).toFixed(4)),
      changePercent: Number(pct.toFixed(2)),
      marketCap: coin.usd_market_cap ?? null,
      volume: coin.usd_24h_vol ?? null,
      trend: pct >= 0 ? "📈" : "📉",
    };
  } catch {
    return null;
  }
}

// ─── Main Tool Executor ───────────────────────────────────────────────────────

export async function execMarketData(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const action = String(args.action ?? "quote");

  try {
    switch (action) {

      // ── SINGLE QUOTE ────────────────────────────────────────────────────────
      case "quote": {
        const symbol = String(args.symbol ?? "").toUpperCase().trim();
        if (!symbol) return { error: "symbol is required (e.g. AAPL, BTC-USD, EURUSD=X, ^GSPC)" };

        // CoinGecko path for known crypto
        const coinId = CRYPTO_COINGECKO_MAP[symbol];
        if (coinId) {
          const cg = await getCoinGeckoQuote(coinId);
          if (cg) {
            return {
              symbol,
              name: symbol.replace("-USD", ""),
              source: "CoinGecko",
              currency: "USD",
              timestamp: new Date().toISOString(),
              ...cg,
            };
          }
        }

        // Yahoo Finance path
        const res = await yfFetch(
          env,
          `${YF_QUOTE}?symbols=${encodeURIComponent(symbol)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,currency,exchangeName,quoteType`
        );

        if (!res) return { error: "Could not obtain Yahoo Finance auth. Try again." };
        if (!res.ok) return { error: `Yahoo Finance returned ${res.status}. Symbol may be invalid.` };

        const data = await res.json() as {
          quoteResponse: {
            result?: Array<{
              symbol: string;
              shortName?: string;
              longName?: string;
              regularMarketPrice?: number;
              regularMarketChange?: number;
              regularMarketChangePercent?: number;
              regularMarketVolume?: number;
              marketCap?: number;
              fiftyTwoWeekHigh?: number;
              fiftyTwoWeekLow?: number;
              currency?: string;
              exchangeName?: string;
              quoteType?: string;
            }>;
            error?: { code: string; description: string };
          };
        };

        if (data.quoteResponse?.error) {
          return { error: `Yahoo Finance error: ${data.quoteResponse.error.description}` };
        }

        const quote = data.quoteResponse?.result?.[0];
        if (!quote || !quote.regularMarketPrice) {
          return { error: `No data found for symbol: ${symbol}. Verify the ticker is correct.` };
        }

        const pct = quote.regularMarketChangePercent ?? 0;
        return {
          symbol: quote.symbol,
          name: quote.shortName ?? quote.longName ?? symbol,
          price: quote.regularMarketPrice,
          change: Number((quote.regularMarketChange ?? 0).toFixed(4)),
          changePercent: Number(pct.toFixed(2)),
          trend: pct > 0 ? "📈" : pct < 0 ? "📉" : "➡️",
          volume: quote.regularMarketVolume ?? null,
          marketCap: quote.marketCap ?? null,
          high52w: quote.fiftyTwoWeekHigh ?? null,
          low52w: quote.fiftyTwoWeekLow ?? null,
          currency: quote.currency ?? "USD",
          exchange: quote.exchangeName ?? null,
          type: quote.quoteType ?? null,
          source: "Yahoo Finance",
          timestamp: new Date().toISOString(),
        };
      }

      // ── MULTI QUOTE ─────────────────────────────────────────────────────────
      case "multi_quote": {
        const symbolsRaw = args.symbols as string[] | string;
        const symbolsList = Array.isArray(symbolsRaw)
          ? symbolsRaw
          : String(symbolsRaw ?? "").split(",").map((s) => s.trim().toUpperCase());

        if (!symbolsList.length) return { error: "symbols array or comma-separated list is required" };
        const symbols = symbolsList.slice(0, 20);

        // Split: some may use CoinGecko, rest use YF
        const cgSymbols = symbols.filter((s) => CRYPTO_COINGECKO_MAP[s]);
        const yfSymbols = symbols.filter((s) => !CRYPTO_COINGECKO_MAP[s]);

        const results: Record<string, unknown>[] = [];

        // CoinGecko batch
        if (cgSymbols.length > 0) {
          const ids = cgSymbols.map((s) => CRYPTO_COINGECKO_MAP[s]).join(",");
          try {
            const res = await fetch(
              `${COINGECKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
              { headers: { "Accept": "application/json" } }
            );
            if (res.ok) {
              const data = await res.json() as Record<string, { usd: number; usd_24h_change?: number }>;
              for (const symbol of cgSymbols) {
                const coinId = CRYPTO_COINGECKO_MAP[symbol];
                const coin = data[coinId];
                if (coin) {
                  results.push({
                    symbol,
                    name: symbol.replace("-USD", ""),
                    price: coin.usd,
                    changePercent: Number((coin.usd_24h_change ?? 0).toFixed(2)),
                    trend: (coin.usd_24h_change ?? 0) >= 0 ? "📈" : "📉",
                    source: "CoinGecko",
                  });
                }
              }
            }
          } catch { /* skip CG failures */ }
        }

        // Yahoo Finance batch
        if (yfSymbols.length > 0) {
          const res = await yfFetch(
            env,
            `${YF_QUOTE}?symbols=${encodeURIComponent(yfSymbols.join(","))}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,shortName`
          );

          if (res?.ok) {
            const data = await res.json() as {
              quoteResponse: {
                result?: Array<{
                  symbol: string;
                  shortName?: string;
                  regularMarketPrice?: number;
                  regularMarketChange?: number;
                  regularMarketChangePercent?: number;
                }>;
              };
            };

            for (const q of data.quoteResponse?.result ?? []) {
              results.push({
                symbol: q.symbol,
                name: q.shortName ?? q.symbol,
                price: q.regularMarketPrice ?? null,
                change: Number((q.regularMarketChange ?? 0).toFixed(2)),
                changePercent: Number((q.regularMarketChangePercent ?? 0).toFixed(2)),
                trend: (q.regularMarketChangePercent ?? 0) >= 0 ? "📈" : "📉",
                source: "Yahoo Finance",
              });
            }
          }
        }

        return {
          count: results.length,
          quotes: results,
          timestamp: new Date().toISOString(),
        };
      }

      // ── HISTORY ─────────────────────────────────────────────────────────────
      case "history": {
        const symbol = String(args.symbol ?? "").toUpperCase();
        const range = String(args.range ?? "1mo");
        const interval = String(args.interval ?? "1d");
        if (!symbol) return { error: "symbol is required" };

        const res = await yfFetch(
          env,
          `${YF_CHART}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`
        );

        if (!res) return { error: "Could not obtain Yahoo Finance auth." };
        if (!res.ok) return { error: `History fetch failed: ${res.status}` };

        const data = await res.json() as {
          chart: {
            result?: Array<{
              meta: { currency: string; regularMarketPrice: number; symbol: string };
              timestamp?: number[];
              indicators: {
                quote?: Array<{
                  open?: (number | null)[];
                  high?: (number | null)[];
                  low?: (number | null)[];
                  close?: (number | null)[];
                  volume?: (number | null)[];
                }>;
              };
            }>;
            error?: { code: string; description: string };
          };
        };

        if (data.chart?.error) {
          return { error: `Yahoo Finance error: ${data.chart.error.description}` };
        }

        const result = data.chart?.result?.[0];
        if (!result) return { error: `No history found for: ${symbol}` };

        const timestamps = result.timestamp ?? [];
        const q = result.indicators.quote?.[0] ?? {};
        const closes = (q.close ?? []).filter((c): c is number => c != null && c > 0);

        const points = timestamps.slice(-20).map((ts, i) => {
          const idx = timestamps.length - Math.min(20, timestamps.length) + i;
          return {
            date: new Date(ts * 1000).toISOString().split("T")[0],
            open: Number((q.open?.[idx] ?? 0).toFixed(4)),
            high: Number((q.high?.[idx] ?? 0).toFixed(4)),
            low: Number((q.low?.[idx] ?? 0).toFixed(4)),
            close: Number((q.close?.[idx] ?? 0).toFixed(4)),
            volume: q.volume?.[idx] ?? 0,
          };
        });

        const firstClose = closes[0] ?? 0;
        const lastClose = closes[closes.length - 1] ?? 0;
        const totalChange = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

        return {
          symbol,
          range,
          interval,
          currency: result.meta.currency,
          currentPrice: result.meta.regularMarketPrice,
          periodHigh: Number(Math.max(...closes).toFixed(4)),
          periodLow: Number(Math.min(...closes).toFixed(4)),
          periodChange: Number(totalChange.toFixed(2)),
          trend: totalChange >= 0 ? "📈" : "📉",
          dataPoints: points,
          totalDataPoints: timestamps.length,
        };
      }

      // ── SEARCH ──────────────────────────────────────────────────────────────
      case "search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { error: "query is required (e.g. 'Apple', 'Tesla')" };

        const res = await yfFetch(
          env,
          `${YF_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=true`
        );

        if (!res?.ok) return { error: `Search failed: ${res?.status ?? "no response"}` };

        const data = await res.json() as {
          quotes?: Array<{
            symbol: string;
            shortname?: string;
            longname?: string;
            quoteType?: string;
            exchDisp?: string;
          }>;
        };

        const results = (data.quotes ?? []).slice(0, 8).map((q) => ({
          symbol: q.symbol,
          name: q.shortname ?? q.longname ?? q.symbol,
          type: q.quoteType ?? "EQUITY",
          exchange: q.exchDisp ?? "",
        }));

        return { query, results, count: results.length };
      }

      // ── PORTFOLIO ────────────────────────────────────────────────────────────
      case "portfolio": {
        const { getRedis } = await import("../memory");
        const redis = getRedis(env);
        const raw = await redis.get("market:portfolio") as string | null;
        if (!raw) {
          return { error: "No portfolio configured. Use store_memory to save: market:portfolio = { 'AAPL': 10, 'MSFT': 5 }" };
        }

        let portfolioRaw: Record<string, number>;
        try {
          portfolioRaw = JSON.parse(raw);
        } catch {
          return { error: "Portfolio data is malformed. Expected JSON: { SYMBOL: quantity }" };
        }

        const symbols = Object.keys(portfolioRaw);
        if (!symbols.length) return { positions: [], totalValue: 0 };

        const res = await yfFetch(
          env,
          `${YF_QUOTE}?symbols=${encodeURIComponent(symbols.join(","))}&fields=regularMarketPrice,regularMarketChangePercent,shortName`
        );

        const priceMap = new Map<string, { regularMarketPrice?: number; regularMarketChangePercent?: number; shortName?: string }>();
        if (res?.ok) {
          const data = await res.json() as {
            quoteResponse: {
              result?: Array<{ symbol: string; regularMarketPrice?: number; regularMarketChangePercent?: number; shortName?: string }>;
            };
          };
          for (const q of data.quoteResponse?.result ?? []) {
            priceMap.set(q.symbol, q);
          }
        }

        let totalValue = 0;
        const positions = Object.entries(portfolioRaw).map(([symbol, qty]) => {
          const quote = priceMap.get(symbol);
          const price = quote?.regularMarketPrice ?? 0;
          const value = price * qty;
          totalValue += value;
          return {
            symbol,
            name: quote?.shortName ?? symbol,
            qty,
            price,
            value: Number(value.toFixed(2)),
            changePercent: Number((quote?.regularMarketChangePercent ?? 0).toFixed(2)),
            trend: (quote?.regularMarketChangePercent ?? 0) >= 0 ? "📈" : "📉",
          };
        });

        return {
          positions: positions.sort((a, b) => b.value - a.value),
          totalValue: Number(totalValue.toFixed(2)),
          currency: "USD",
          timestamp: new Date().toISOString(),
        };
      }

      // ── SET ALERT ────────────────────────────────────────────────────────────
      case "set_alert": {
        const symbol = String(args.symbol ?? "").toUpperCase();
        const targetPrice = Number(args.targetPrice);
        const direction = String(args.direction ?? "above") as "above" | "below";
        const telegramChatId = args.telegramChatId as string | undefined;
        const userId = args.userId as string | undefined;

        if (!symbol || isNaN(targetPrice) || targetPrice <= 0) {
          return { error: "symbol and targetPrice (positive number) are required" };
        }

        const { getRedis } = await import("../memory");
        const redis = getRedis(env);

        // Verify symbol exists before setting alert
        const checkRes = await yfFetch(env, `${YF_QUOTE}?symbols=${encodeURIComponent(symbol)}&fields=regularMarketPrice`);
        let currentPrice: number | null = null;
        if (checkRes?.ok) {
          const checkData = await checkRes.json() as { quoteResponse: { result?: Array<{ regularMarketPrice?: number }> } };
          currentPrice = checkData.quoteResponse?.result?.[0]?.regularMarketPrice ?? null;
        }

        if (!currentPrice) {
          return { error: `Cannot verify symbol: ${symbol}. Check the ticker is correct.` };
        }

        const alertId = `alert-${symbol}-${Date.now()}`;
        const alert = {
          id: alertId,
          symbol,
          targetPrice,
          direction,
          currentPriceAtCreation: currentPrice,
          telegramChatId,
          userId,
          createdAt: Date.now(),
          triggered: false,
          lastCheckedAt: Date.now(),
        };

        await redis.set(`market:alert:${alertId}`, JSON.stringify(alert));
        await redis.sadd("market:alerts", alertId);

        const gap = direction === "above"
          ? ((targetPrice - currentPrice) / currentPrice * 100).toFixed(1)
          : ((currentPrice - targetPrice) / currentPrice * 100).toFixed(1);

        return {
          success: true,
          alertId,
          symbol,
          currentPrice,
          targetPrice,
          direction,
          gapPercent: `${gap}% away`,
          message: `Alert set: notify when ${symbol} is ${direction} $${targetPrice} (currently $${currentPrice.toFixed(2)}, ${gap}% away)`,
        };
      }

      // ── LIST ALERTS ──────────────────────────────────────────────────────────
      case "list_alerts": {
        const { getRedis } = await import("../memory");
        const redis = getRedis(env);
        const alertIds = await redis.smembers("market:alerts") as string[];

        if (!alertIds.length) return { alerts: [], count: 0 };

        const alerts = (await Promise.all(
          alertIds.map(async (id) => {
            const raw = await redis.get(`market:alert:${id}`) as string | null;
            if (!raw) return null;
            try { return JSON.parse(raw); } catch { return null; }
          })
        )).filter(Boolean);

        return { alerts, count: alerts.length };
      }

      // ── DELETE ALERT ─────────────────────────────────────────────────────────
      case "delete_alert": {
        const alertId = String(args.alertId ?? "");
        if (!alertId) return { error: "alertId is required" };

        const { getRedis } = await import("../memory");
        const redis = getRedis(env);
        await redis.del(`market:alert:${alertId}`);
        await redis.srem("market:alerts", alertId);

        return { success: true, deleted: alertId };
      }

      // ── NEWS ─────────────────────────────────────────────────────────────────
      case "news": {
        const symbol = String(args.symbol ?? "").toUpperCase();
        if (!symbol) return { error: "symbol is required" };

        const res = await yfFetch(
          env,
          `${YF_SEARCH}?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=8`
        );

        if (!res?.ok) return { error: `News fetch failed: ${res?.status ?? "no response"}` };

        const data = await res.json() as {
          news?: Array<{
            title: string;
            link?: string;
            publisher?: string;
            providerPublishTime?: number;
            summary?: string;
          }>;
        };

        const newsItems = (data.news ?? []).slice(0, 8).map((n) => ({
          title: n.title,
          url: n.link ?? "",
          publisher: n.publisher ?? "",
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime * 1000).toISOString()
            : "",
          summary: n.summary?.slice(0, 200) ?? "",
        }));

        return { symbol, newsItems, count: newsItems.length };
      }

      default:
        return { error: `Unknown market action: ${action}. Valid: quote, multi_quote, history, search, portfolio, set_alert, list_alerts, delete_alert, news` };
    }
  } catch (err) {
    return { error: `Market data failed: ${String(err)}` };
  }
}

// ─── Cron: Check price alerts ─────────────────────────────────────────────────

export async function checkPriceAlerts(env: Env): Promise<void> {
  const { getRedis } = await import("../memory");
  const redis = getRedis(env);

  const alertIds = await redis.smembers("market:alerts") as string[];
  if (!alertIds.length) return;

  for (const alertId of alertIds) {
    try {
      const raw = await redis.get(`market:alert:${alertId}`) as string | null;
      if (!raw) continue;

      const alert = JSON.parse(raw) as {
        id: string;
        symbol: string;
        targetPrice: number;
        direction: "above" | "below";
        telegramChatId?: string;
        userId?: string;
        triggered: boolean;
      };

      if (alert.triggered) continue;

      // Try CoinGecko for crypto first
      const coinId = CRYPTO_COINGECKO_MAP[alert.symbol];
      let price: number | null = null;

      if (coinId) {
        const cg = await getCoinGeckoQuote(coinId);
        price = (cg?.price as number) ?? null;
      } else {
        const res = await yfFetch(
          env,
          `${YF_QUOTE}?symbols=${encodeURIComponent(alert.symbol)}&fields=regularMarketPrice`
        );
        if (res?.ok) {
          const data = await res.json() as {
            quoteResponse: { result?: Array<{ regularMarketPrice?: number }> };
          };
          price = data.quoteResponse?.result?.[0]?.regularMarketPrice ?? null;
        }
      }

      if (!price) continue;

      const triggered =
        (alert.direction === "above" && price >= alert.targetPrice) ||
        (alert.direction === "below" && price <= alert.targetPrice);

      if (triggered) {
        alert.triggered = true;
        await redis.set(`market:alert:${alertId}`, JSON.stringify(alert));
        await redis.srem("market:alerts", alertId);

        if (alert.telegramChatId) {
          const { sendProactiveTelegramMessage } = await import("./goals");
          await sendProactiveTelegramMessage(
            env,
            String(alert.telegramChatId),
            `🔔 <b>Price Alert Triggered!</b>\n\n` +
            `<b>${alert.symbol}</b> is now <b>$${price.toFixed(2)}</b>\n` +
            `${alert.direction === "above" ? "📈 Above" : "📉 Below"} your target of $${alert.targetPrice}\n\n` +
            `<code>${alertId}</code>`,
            alert.userId
          );
        }
      }
    } catch (alertErr) {
      console.error(`[checkPriceAlerts] Error for ${alertId}:`, alertErr);
    }
  }
}