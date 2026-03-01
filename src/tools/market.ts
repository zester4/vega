/**
 * ============================================================================
 * src/tools/market.ts — Live Market Intelligence (Yahoo Finance)
 * ============================================================================
 *
 * Actions:
 *   quote         → Real-time price for any ticker (stocks, crypto, ETFs, forex)
 *   multi_quote   → Batch quotes for up to 20 symbols
 *   history       → Historical OHLCV data (1d, 1wk, 1mo intervals)
 *   search        → Search for ticker symbols by company name
 *   portfolio     → Get all stored portfolio positions with current prices
 *   set_alert     → Store a price alert in Redis (checked by cron)
 *   list_alerts   → Show all active price alerts
 *   news          → Latest market news for a symbol
 *
 * Zero API key required — uses Yahoo Finance public endpoints.
 * Free, no rate limits for reasonable use.
 *
 * Price alerts are stored in Redis and checked by the /cron/tick route.
 * When triggered, VEGA sends a proactive Telegram push.
 * ============================================================================
 */

const YF_BASE = "https://query1.finance.yahoo.com/v8/finance";
const YF_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const YF_QUOTE = "https://query1.finance.yahoo.com/v7/finance/quote";
const YF_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const YF_NEWS = "https://query2.finance.yahoo.com/v1/finance/recommendationsbysymbol";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; VEGA-Agent/1.0)",
  "Accept": "application/json",
};

export async function execMarketData(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const action = String(args.action ?? "quote") as
    | "quote"
    | "multi_quote"
    | "history"
    | "search"
    | "portfolio"
    | "set_alert"
    | "list_alerts"
    | "delete_alert"
    | "news";

  try {
    switch (action) {
      // ── SINGLE QUOTE ─────────────────────────────────────────────────────────
      case "quote": {
        const symbol = String(args.symbol ?? "").toUpperCase().trim();
        if (!symbol) return { error: "symbol is required (e.g. AAPL, BTC-USD, EURUSD=X)" };

        const res = await fetch(
          `${YF_QUOTE}?symbols=${encodeURIComponent(symbol)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,currency`,
          { headers: HEADERS }
        );

        if (!res.ok) return { error: `Yahoo Finance request failed: ${res.status}` };

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
            }>;
            error?: unknown;
          };
        };

        const quote = data.quoteResponse?.result?.[0];
        if (!quote) return { error: `No data found for symbol: ${symbol}` };

        const pct = quote.regularMarketChangePercent ?? 0;
        const trend = pct > 0 ? "📈" : pct < 0 ? "📉" : "➡️";

        return {
          symbol: quote.symbol,
          name: quote.shortName ?? quote.longName ?? symbol,
          price: quote.regularMarketPrice,
          change: quote.regularMarketChange,
          changePercent: Number(pct.toFixed(2)),
          trend,
          volume: quote.regularMarketVolume,
          marketCap: quote.marketCap,
          high52w: quote.fiftyTwoWeekHigh,
          low52w: quote.fiftyTwoWeekLow,
          currency: quote.currency ?? "USD",
          timestamp: new Date().toISOString(),
        };
      }

      // ── MULTI QUOTE (batch) ───────────────────────────────────────────────────
      case "multi_quote": {
        const symbolsRaw = args.symbols as string[] | string;
        const symbolsList = Array.isArray(symbolsRaw)
          ? symbolsRaw
          : String(symbolsRaw ?? "").split(",").map((s) => s.trim());

        if (!symbolsList.length) return { error: "symbols array is required" };
        const symbols = symbolsList.slice(0, 20).join(",");

        const res = await fetch(
          `${YF_QUOTE}?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,shortName`,
          { headers: HEADERS }
        );

        if (!res.ok) return { error: `Yahoo Finance multi-quote failed: ${res.status}` };

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

        const quotes = (data.quoteResponse?.result ?? []).map((q) => ({
          symbol: q.symbol,
          name: q.shortName ?? q.symbol,
          price: q.regularMarketPrice,
          change: Number((q.regularMarketChange ?? 0).toFixed(2)),
          changePercent: Number((q.regularMarketChangePercent ?? 0).toFixed(2)),
          trend: (q.regularMarketChangePercent ?? 0) >= 0 ? "📈" : "📉",
        }));

        return {
          count: quotes.length,
          quotes,
          timestamp: new Date().toISOString(),
        };
      }

      // ── HISTORICAL DATA ───────────────────────────────────────────────────────
      case "history": {
        const symbol = String(args.symbol ?? "").toUpperCase();
        const range = String(args.range ?? "1mo"); // 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max
        const interval = String(args.interval ?? "1d"); // 1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk,1mo,3mo

        const res = await fetch(
          `${YF_CHART}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
          { headers: HEADERS }
        );

        if (!res.ok) return { error: `History fetch failed: ${res.status}` };

        const data = await res.json() as {
          chart: {
            result?: Array<{
              meta: { currency: string; regularMarketPrice: number; symbol: string };
              timestamp?: number[];
              indicators: {
                quote?: Array<{
                  open?: number[];
                  high?: number[];
                  low?: number[];
                  close?: number[];
                  volume?: number[];
                }>;
              };
            }>;
            error?: unknown;
          };
        };

        const result = data.chart?.result?.[0];
        if (!result) return { error: `No history found for: ${symbol}` };

        const timestamps = result.timestamp ?? [];
        const q = result.indicators.quote?.[0] ?? {};
        const closes = q.close ?? [];

        // Return summary stats + last 10 data points
        const points = timestamps.slice(-10).map((ts, i) => ({
          date: new Date(ts * 1000).toISOString().split("T")[0],
          open: Number((q.open?.[q.open.length - 10 + i] ?? 0).toFixed(4)),
          high: Number((q.high?.[q.high.length - 10 + i] ?? 0).toFixed(4)),
          low: Number((q.low?.[q.low.length - 10 + i] ?? 0).toFixed(4)),
          close: Number((closes[closes.length - 10 + i] ?? 0).toFixed(4)),
          volume: q.volume?.[q.volume.length - 10 + i] ?? 0,
        }));

        const validCloses = closes.filter((c): c is number => c != null && c > 0);
        const firstClose = validCloses[0] ?? 0;
        const lastClose = validCloses[validCloses.length - 1] ?? 0;
        const totalChange = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;
        const highPrice = Math.max(...validCloses);
        const lowPrice = Math.min(...validCloses);

        return {
          symbol,
          range,
          interval,
          currency: result.meta.currency,
          currentPrice: result.meta.regularMarketPrice,
          periodHigh: Number(highPrice.toFixed(4)),
          periodLow: Number(lowPrice.toFixed(4)),
          periodChange: Number(totalChange.toFixed(2)),
          trend: totalChange >= 0 ? "📈" : "📉",
          dataPoints: timestamps.length,
          recent10: points,
        };
      }

      // ── SEARCH SYMBOLS ────────────────────────────────────────────────────────
      case "search": {
        const query = String(args.query ?? "");
        if (!query) return { error: "query is required" };

        const res = await fetch(
          `${YF_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`,
          { headers: HEADERS }
        );

        if (!res.ok) return { error: `Symbol search failed: ${res.status}` };

        const data = await res.json() as {
          quotes?: Array<{
            symbol: string;
            shortname?: string;
            longname?: string;
            typeDisp?: string;
            exchDisp?: string;
          }>;
        };

        const results = (data.quotes ?? []).slice(0, 8).map((q) => ({
          symbol: q.symbol,
          name: q.shortname ?? q.longname ?? q.symbol,
          type: q.typeDisp ?? "EQUITY",
          exchange: q.exchDisp ?? "",
        }));

        return { query, results, count: results.length };
      }

      // ── PORTFOLIO (stored in Redis) ───────────────────────────────────────────
      case "portfolio": {
        const { getRedis } = await import("../memory");
        const redis = getRedis(env);
        const portfolioRaw = await redis.get("market:portfolio") as Record<string, number> | null;

        if (!portfolioRaw || Object.keys(portfolioRaw).length === 0) {
          return {
            portfolio: [],
            note: "Portfolio is empty. Add positions with action='add_position'.",
          };
        }

        // Fetch live prices for all symbols
        const symbols = Object.keys(portfolioRaw).join(",");
        const res = await fetch(
          `${YF_QUOTE}?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChangePercent,shortName`,
          { headers: HEADERS }
        );

        const data = await res.json() as {
          quoteResponse: {
            result?: Array<{
              symbol: string;
              shortName?: string;
              regularMarketPrice?: number;
              regularMarketChangePercent?: number;
            }>;
          };
        };

        const priceMap = new Map(
          (data.quoteResponse?.result ?? []).map((q) => [q.symbol, q])
        );

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
          positions,
          totalValue: Number(totalValue.toFixed(2)),
          currency: "USD",
          timestamp: new Date().toISOString(),
        };
      }

      // ── SET PRICE ALERT ───────────────────────────────────────────────────────
      case "set_alert": {
        const symbol = String(args.symbol ?? "").toUpperCase();
        const targetPrice = Number(args.targetPrice);
        const direction = String(args.direction ?? "above") as "above" | "below";
        const telegramChatId = args.telegramChatId as string | undefined;

        if (!symbol || isNaN(targetPrice)) {
          return { error: "symbol and targetPrice are required" };
        }

        const { getRedis } = await import("../memory");
        const redis = getRedis(env);

        const alertId = `alert-${symbol}-${Date.now()}`;
        const alert = {
          id: alertId,
          symbol,
          targetPrice,
          direction,
          telegramChatId,
          createdAt: Date.now(),
          triggered: false,
        };

        await redis.set(`market:alert:${alertId}`, JSON.stringify(alert));
        await redis.sadd("market:alerts", alertId);

        return {
          success: true,
          alertId,
          message: `Alert set: ${symbol} ${direction} $${targetPrice}`,
          note: "Alert will be checked every cron tick. You'll be notified via Telegram when triggered.",
        };
      }

      // ── LIST ALERTS ───────────────────────────────────────────────────────────
      case "list_alerts": {
        const { getRedis } = await import("../memory");
        const redis = getRedis(env);
        const alertIds = await redis.smembers("market:alerts") as string[];

        if (!alertIds.length) return { alerts: [], count: 0 };

        const alerts = await Promise.all(
          alertIds.map(async (id) => {
            const raw = await redis.get(`market:alert:${id}`) as string | null;
            if (!raw) return null;
            try { return JSON.parse(raw); } catch { return null; }
          })
        );

        return {
          alerts: alerts.filter(Boolean),
          count: alerts.filter(Boolean).length,
        };
      }

      // ── DELETE ALERT ──────────────────────────────────────────────────────────
      case "delete_alert": {
        const alertId = String(args.alertId ?? "");
        if (!alertId) return { error: "alertId is required" };

        const { getRedis } = await import("../memory");
        const redis = getRedis(env);
        await redis.del(`market:alert:${alertId}`);
        await redis.srem("market:alerts", alertId);

        return { success: true, deleted: alertId };
      }

      // ── MARKET NEWS ───────────────────────────────────────────────────────────
      case "news": {
        const symbol = String(args.symbol ?? "").toUpperCase();
        if (!symbol) return { error: "symbol is required" };

        // Yahoo Finance news (via search endpoint with news)
        const res = await fetch(
          `${YF_SEARCH}?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=5`,
          { headers: HEADERS }
        );

        if (!res.ok) return { error: `News fetch failed: ${res.status}` };

        const data = await res.json() as {
          news?: Array<{
            title: string;
            link?: string;
            publisher?: string;
            providerPublishTime?: number;
          }>;
        };

        const newsItems = (data.news ?? []).slice(0, 5).map((n) => ({
          title: n.title,
          url: n.link ?? "",
          publisher: n.publisher ?? "",
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime * 1000).toISOString()
            : "",
        }));

        return { symbol, newsItems, count: newsItems.length };
      }

      default:
        return { error: `Unknown market action: ${action}` };
    }
  } catch (err) {
    return { error: `Market data failed: ${String(err)}` };
  }
}

// ── Check price alerts (called by cron) ───────────────────────────────────────
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
        triggered: boolean;
      };

      if (alert.triggered) continue;

      // Fetch current price
      const res = await fetch(
        `${YF_QUOTE}?symbols=${encodeURIComponent(alert.symbol)}&fields=regularMarketPrice`,
        { headers: HEADERS }
      );

      if (!res.ok) continue;

      const data = await res.json() as {
        quoteResponse: { result?: Array<{ regularMarketPrice?: number }> };
      };

      const price = data.quoteResponse?.result?.[0]?.regularMarketPrice;
      if (!price) continue;

      const triggered =
        (alert.direction === "above" && price >= alert.targetPrice) ||
        (alert.direction === "below" && price <= alert.targetPrice);

      if (triggered) {
        // Mark as triggered
        alert.triggered = true;
        await redis.set(`market:alert:${alertId}`, JSON.stringify(alert));
        await redis.srem("market:alerts", alertId);

        // Send proactive Telegram notification
        if (alert.telegramChatId) {
          const { sendProactiveTelegramMessage } = await import("./goals");
          await sendProactiveTelegramMessage(
            env,
            String(alert.telegramChatId),
            `🔔 <b>Price Alert Triggered!</b>\n\n` +
            `${alert.symbol} is now <b>$${price.toFixed(2)}</b>\n` +
            `(${alert.direction === "above" ? "📈 Above" : "📉 Below"} your target of $${alert.targetPrice})\n\n` +
            `Alert ID: <code>${alertId}</code>`
          );
        }
      }
    } catch (alertErr) {
      console.error(`[checkPriceAlerts] Error for ${alertId}:`, alertErr);
    }
  }
}