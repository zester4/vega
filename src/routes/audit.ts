/**
 * ============================================================================
 * src/routes/audit.ts — Production Audit Log
 * ============================================================================
 *
 * Every tool call executed by VEGA is recorded here — timestamped,
 * attributed to a user, and stored in D1 with full query support.
 *
 * Design:
 *   • insertAuditLog() is called from executeTool() in builtins.ts.
 *     It is non-blocking — failures are caught and logged but NEVER
 *     interrupt the tool call itself.
 *   • args_summary is sanitized: keys matching /key|token|secret|password/i
 *     have their values replaced with "...XXXX" before storage.
 *   • result_summary is truncated to 500 chars.
 *   • D1 journal_mode = WAL (set in migration) for high-throughput writes.
 *
 * Routes:
 *   GET /audit              → list audit entries for the authed user
 *   GET /audit/stats        → aggregate stats (calls per tool, error rate)
 *   DELETE /audit           → clear all entries for the user (GDPR)
 *
 * ============================================================================
 */

import { Hono } from "hono";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditEntry = {
    id: string;
    user_id: string | null;
    session_id: string;
    tool_name: string;
    args_summary: string;      // sanitized JSON string
    result_summary: string | null;
    status: "ok" | "error" | "denied";
    error_message: string | null;
    duration_ms: number | null;
    created_at: string;        // ISO 8601
};

// ─── Secret-Key Patterns ──────────────────────────────────────────────────────

const SECRET_KEY_PATTERN = /key|token|secret|password|credential|auth/i;

/** Sanitize args before storing — redact values for secret-like keys. */
function sanitizeArgs(args: Record<string, unknown>): string {
    try {
        const sanitized = Object.fromEntries(
            Object.entries(args).map(([k, v]) => {
                if (SECRET_KEY_PATTERN.test(k) && typeof v === "string" && v.length > 4) {
                    return [k, `[redacted ...${v.slice(-4)}]`];
                }
                // Truncate long string values
                if (typeof v === "string" && v.length > 200) {
                    return [k, v.slice(0, 200) + "...[truncated]"];
                }
                return [k, v];
            })
        );
        return JSON.stringify(sanitized);
    } catch {
        return "{}";
    }
}

/** Truncate result to a safe length for storage. */
function summarizeResult(result: unknown): string | null {
    if (result === null || result === undefined) return null;
    try {
        const str =
            typeof result === "string"
                ? result
                : JSON.stringify(result);
        return str.slice(0, 500) + (str.length > 500 ? "...[truncated]" : "");
    } catch {
        return String(result).slice(0, 500);
    }
}

// ─── Core Insert Helper ───────────────────────────────────────────────────────

/**
 * Insert one audit log entry into D1.
 *
 * Usage (in executeTool):
 *
 *   const start = Date.now();
 *   try {
 *     const result = await actualToolFn(args, env);
 *     insertAuditLog(env.DB, { userId, sessionId, toolName, args, result, durationMs: Date.now() - start })
 *       .catch(e => console.warn("[audit]", e));
 *     return result;
 *   } catch (err) {
 *     insertAuditLog(env.DB, { userId, sessionId, toolName, args, error: String(err), durationMs: Date.now() - start })
 *       .catch(e => console.warn("[audit]", e));
 *     throw err;
 *   }
 */
export async function insertAuditLog(
    db: D1Database,
    entry: {
        userId?: string | null;
        sessionId: string;
        toolName: string;
        args: Record<string, unknown>;
        result?: unknown;
        error?: string;
        denied?: boolean;
        durationMs?: number;
    }
): Promise<void> {
    const status = entry.denied ? "denied" : entry.error ? "error" : "ok";

    await db.prepare(
        `INSERT INTO audit_log
       (id, user_id, session_id, tool_name, args_summary, result_summary,
        status, error_message, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        crypto.randomUUID(),
        entry.userId ?? null,
        entry.sessionId,
        entry.toolName,
        sanitizeArgs(entry.args),
        entry.result !== undefined ? summarizeResult(entry.result) : null,
        status,
        entry.error ?? null,
        entry.durationMs ?? null,
        new Date().toISOString()
    ).run();
}

// ─── Hono Routes ──────────────────────────────────────────────────────────────

const audit = new Hono<{ Bindings: Env }>();

audit.use("*", async (c, next) => {
    const userId = c.req.header("X-User-Id")?.trim();
    if (!userId) return c.json({ error: "X-User-Id required" }, 401);
    await next();
});

/**
 * GET /audit
 * Query params:
 *   tool      — filter by tool name
 *   status    — filter by status (ok|error|denied)
 *   from      — ISO date lower bound
 *   to        — ISO date upper bound
 *   limit     — max rows (default 100, max 500)
 *   offset    — pagination
 */
audit.get("/", async (c) => {
    try {
        const userId = c.req.header("X-User-Id")!;
        const tool = c.req.query("tool");
        const status = c.req.query("status");
        const from = c.req.query("from");
        const to = c.req.query("to");
        const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
        const offset = Number(c.req.query("offset") ?? 0);

        let sql = "SELECT * FROM audit_log WHERE user_id = ?";
        const params: unknown[] = [userId];

        if (tool) { sql += " AND tool_name = ?"; params.push(tool); }
        if (status) { sql += " AND status = ?"; params.push(status); }
        if (from) { sql += " AND created_at >= ?"; params.push(from); }
        if (to) { sql += " AND created_at <= ?"; params.push(to); }

        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        // Total count (for pagination)
        let countSql = "SELECT COUNT(*) as total FROM audit_log WHERE user_id = ?";
        const countParams: unknown[] = [userId];
        if (tool) { countSql += " AND tool_name = ?"; countParams.push(tool); }
        if (status) { countSql += " AND status = ?"; countParams.push(status); }
        if (from) { countSql += " AND created_at >= ?"; countParams.push(from); }
        if (to) { countSql += " AND created_at <= ?"; countParams.push(to); }

        const [rows, countRow] = await Promise.all([
            c.env.DB.prepare(sql).bind(...params).all<AuditEntry>(),
            c.env.DB.prepare(countSql).bind(...countParams).first<{ total: number }>(),
        ]);

        return c.json({
            entries: rows.results ?? [],
            total: countRow?.total ?? 0,
            limit,
            offset,
        });
    } catch (err) {
        return c.json({ error: String(err) }, 500);
    }
});

/**
 * GET /audit/stats
 * Returns aggregate stats for the authed user:
 *   - calls per tool (descending)
 *   - error counts per tool
 *   - total calls, errors, denials
 *   - last 7 days activity buckets
 */
audit.get("/stats", async (c) => {
    try {
        const userId = c.req.header("X-User-Id")!;

        const [toolStats, totals, recentActivity] = await Promise.all([
            // Per-tool breakdown
            c.env.DB.prepare(
                `SELECT
           tool_name,
           COUNT(*) as total_calls,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_count,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
           SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) as denied_count,
           AVG(duration_ms) as avg_duration_ms,
           MAX(created_at) as last_used
         FROM audit_log WHERE user_id = ?
         GROUP BY tool_name
         ORDER BY total_calls DESC
         LIMIT 50`
            ).bind(userId).all(),

            // Overall totals
            c.env.DB.prepare(
                `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
           SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) as denied
         FROM audit_log WHERE user_id = ?`
            ).bind(userId).first(),

            // Activity per day last 7 days
            c.env.DB.prepare(
                `SELECT
           substr(created_at, 1, 10) as day,
           COUNT(*) as calls
         FROM audit_log
         WHERE user_id = ? AND created_at >= datetime('now', '-7 days')
         GROUP BY day
         ORDER BY day ASC`
            ).bind(userId).all(),
        ]);

        return c.json({
            tools: toolStats.results ?? [],
            totals,
            recentActivity: recentActivity.results ?? [],
        });
    } catch (err) {
        return c.json({ error: String(err) }, 500);
    }
});

/**
 * DELETE /audit
 * Purge all audit entries for the authed user (GDPR / account deletion).
 */
audit.delete("/", async (c) => {
    try {
        const userId = c.req.header("X-User-Id")!;
        const result = await c.env.DB.prepare(
            "DELETE FROM audit_log WHERE user_id = ?"
        ).bind(userId).run();
        return c.json({ ok: true, deleted: result.meta?.changes ?? 0 });
    } catch (err) {
        return c.json({ error: String(err) }, 500);
    }
});

export default audit;