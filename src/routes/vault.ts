/**
 * ============================================================================
 * src/routes/vault.ts — Per-User Encrypted Keys Vault
 * ============================================================================
 *
 * Architecture:
 *   • Encryption: AES-256-GCM via Web Crypto (built into CF Workers — zero deps).
 *   • Key derivation: PBKDF2(VAULT_ENCRYPTION_SECRET + userId, salt=userId, 200k iterations).
 *     Each user gets a unique derived key. Cloudflare never sees plaintext values.
 *   • Storage: D1 user_secrets table. CF also encrypts D1 at rest (double-layered).
 *   • Wire format: base64(iv[12] || ciphertext) stored in encrypted_value column.
 *
 * VEGA's own GEMINI_API_KEY is PROTECTED — cannot be overridden via vault.
 * All other integrations (OpenAI, GitHub, Stripe, Resend, etc.) use vault-first,
 * then fall back to global Worker secrets.
 *
 * Routes (all require X-User-Id header):
 *   POST   /vault/keys          → store or update a secret
 *   GET    /vault/keys          → list key names + hints (never plaintext)
 *   DELETE /vault/keys/:keyName → delete a secret
 *   GET    /vault/keys/:keyName → get decrypted value (Worker-internal use only)
 *
 * Agent Tools (exported for builtins.ts registration):
 *   set_secret(key_name, value, description?)  → encrypt + store in vault
 *   get_secret(key_name)                        → decrypt + return value
 *   list_secrets()                              → list key names + hints
 *   delete_secret(key_name)                     → remove from vault
 *
 * ============================================================================
 */

import { Hono } from "hono";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VaultSecretRow = {
    id: string;
    user_id: string;
    key_name: string;
    encrypted_value: string;
    key_hint: string | null;
    description: string | null;
    created_at: string;
    updated_at: string;
};

/** Keys that VEGA protects — these come from Worker secrets, not the user vault. */
const PROTECTED_KEYS = new Set([
    "gemini_api_key",
    "gemini_key",
    "GEMINI_API_KEY",
]);

// ─── Crypto Helpers ───────────────────────────────────────────────────────────

/**
 * Derive a 256-bit AES-GCM key for a specific user.
 * Uses PBKDF2 with VAULT_ENCRYPTION_SECRET as the password material.
 * The userId is used as salt — ensuring each user gets a unique key even
 * if two users happen to have identical secret values.
 */
async function deriveUserKey(
    vaultEncSecret: string,
    userId: string
): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(vaultEncSecret + userId),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode(userId),
            iterations: 200_000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false, // not extractable
        ["encrypt", "decrypt"]
    );
}

/** Encrypt a plaintext string → base64(iv[12] || ciphertext). */
async function encryptValue(
    plaintext: string,
    key: CryptoKey
): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(plaintext)
    );
    // Concatenate iv + ciphertext into a single buffer
    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.byteLength);
    // Return as base64
    return btoa(String.fromCharCode(...combined));
}

/** Decrypt base64(iv[12] || ciphertext) → plaintext string. */
async function decryptValue(
    encryptedBase64: string,
    key: CryptoKey
): Promise<string> {
    const combined = Uint8Array.from(atob(encryptedBase64), (c) =>
        c.charCodeAt(0)
    );
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
    );
    return new TextDecoder().decode(plainBuffer);
}

/** Build a safe hint: show last 4 chars, mask the rest. */
function buildHint(value: string): string {
    if (value.length <= 4) return "****";
    return `...${value.slice(-4)}`;
}

/** Generate a UUID v4 (CF Workers has crypto.randomUUID). */
function uuid(): string {
    return crypto.randomUUID();
}

// ─── D1 Query Helpers ─────────────────────────────────────────────────────────

async function getSecret(
    db: D1Database,
    userId: string,
    keyName: string
): Promise<VaultSecretRow | null> {
    return db
        .prepare(
            "SELECT * FROM user_secrets WHERE user_id = ? AND key_name = ? LIMIT 1"
        )
        .bind(userId, keyName)
        .first<VaultSecretRow>();
}

async function listSecrets(
    db: D1Database,
    userId: string
): Promise<Pick<VaultSecretRow, "key_name" | "key_hint" | "description" | "created_at" | "updated_at">[]> {
    const result = await db
        .prepare(
            "SELECT key_name, key_hint, description, created_at, updated_at FROM user_secrets WHERE user_id = ? ORDER BY key_name ASC"
        )
        .bind(userId)
        .all<Pick<VaultSecretRow, "key_name" | "key_hint" | "description" | "created_at" | "updated_at">>();
    return result.results ?? [];
}

async function upsertSecret(
    db: D1Database,
    row: Omit<VaultSecretRow, never>
): Promise<void> {
    await db
        .prepare(
            `INSERT INTO user_secrets (id, user_id, key_name, encrypted_value, key_hint, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, key_name) DO UPDATE SET
         encrypted_value = excluded.encrypted_value,
         key_hint = excluded.key_hint,
         description = excluded.description,
         updated_at = excluded.updated_at`
        )
        .bind(
            row.id,
            row.user_id,
            row.key_name,
            row.encrypted_value,
            row.key_hint ?? null,
            row.description ?? null,
            row.created_at,
            row.updated_at
        )
        .run();
}

async function deleteSecret(
    db: D1Database,
    userId: string,
    keyName: string
): Promise<boolean> {
    const result = await db
        .prepare(
            "DELETE FROM user_secrets WHERE user_id = ? AND key_name = ?"
        )
        .bind(userId, keyName)
        .run();
    return (result.meta?.changes ?? 0) > 0;
}

// ─── Public API: Vault Operations ─────────────────────────────────────────────
// Used by agent tools and by the API routes below.

/**
 * Store or update a secret for a user.
 * Returns the key hint.
 */
export async function vaultSet(
    db: D1Database,
    vaultEncSecret: string,
    userId: string,
    keyName: string,
    value: string,
    description?: string
): Promise<{ keyName: string; hint: string }> {
    if (PROTECTED_KEYS.has(keyName)) {
        throw new Error(
            `'${keyName}' is protected — VEGA's own Gemini key cannot be overridden via vault.`
        );
    }
    const derivedKey = await deriveUserKey(vaultEncSecret, userId);
    const encryptedValue = await encryptValue(value, derivedKey);
    const hint = buildHint(value);
    const now = new Date().toISOString();
    await upsertSecret(db, {
        id: uuid(),
        user_id: userId,
        key_name: keyName,
        encrypted_value: encryptedValue,
        key_hint: hint,
        description: description ?? null,
        created_at: now,
        updated_at: now,
    });
    return { keyName, hint };
}

/**
 * Retrieve and decrypt a secret.
 * Returns null if not found (caller should fall back to global Worker secret).
 */
export async function vaultGet(
    db: D1Database,
    vaultEncSecret: string,
    userId: string,
    keyName: string
): Promise<string | null> {
    if (PROTECTED_KEYS.has(keyName)) return null; // always use global for Gemini
    const row = await getSecret(db, userId, keyName);
    if (!row) return null;
    const derivedKey = await deriveUserKey(vaultEncSecret, userId);
    return decryptValue(row.encrypted_value, derivedKey);
}

/**
 * vaultResolve — primary helper called by tool executors.
 * Returns: user's vault value → global env secret → null.
 * Handles normalisation: "openai_key" → env.OPENAI_API_KEY etc.
 */
export async function vaultResolve(
    db: D1Database | undefined,
    vaultEncSecret: string | undefined,
    userId: string | undefined,
    keyName: string,
    envFallback?: string
): Promise<string | null> {
    if (db && vaultEncSecret && userId) {
        try {
            const vaultValue = await vaultGet(db, vaultEncSecret, userId, keyName);
            if (vaultValue) return vaultValue;
        } catch {
            // Vault read failure — fall through to env
        }
    }
    return envFallback ?? null;
}

// ─── Hono Routes ──────────────────────────────────────────────────────────────

const vault = new Hono<{ Bindings: Env }>();

/** Middleware: require X-User-Id header on all vault routes. */
vault.use("*", async (c, next) => {
    const userId = c.req.header("X-User-Id")?.trim();
    if (!userId) return c.json({ error: "X-User-Id header required" }, 401);
    c.set("userId" as never, userId);
    await next();
});

/** POST /vault/keys — store or update a secret */
vault.post("/keys", async (c) => {
    try {
        const userId = c.req.header("X-User-Id")!;
        const body = await c.req.json<{
            key_name: string;
            value: string;
            description?: string;
        }>();

        if (!body.key_name || !body.value) {
            return c.json({ error: "key_name and value are required" }, 400);
        }
        if (!c.env.VAULT_ENCRYPTION_SECRET) {
            return c.json({ error: "VAULT_ENCRYPTION_SECRET not configured on Worker" }, 500);
        }

        const result = await vaultSet(
            c.env.DB,
            c.env.VAULT_ENCRYPTION_SECRET,
            userId,
            body.key_name.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
            body.value,
            body.description
        );

        return c.json({ ok: true, key_name: result.keyName, hint: result.hint });
    } catch (err) {
        return c.json({ error: String(err) }, 400);
    }
});

/** GET /vault/keys — list key names + hints (NO plaintext values ever) */
vault.get("/keys", async (c) => {
    try {
        const userId = c.req.header("X-User-Id")!;
        const secrets = await listSecrets(c.env.DB, userId);
        return c.json({ secrets });
    } catch (err) {
        return c.json({ error: String(err) }, 500);
    }
});

/** DELETE /vault/keys/:keyName — remove a secret */
vault.delete("/keys/:keyName", async (c) => {
    try {
        const userId = c.req.header("X-User-Id")!;
        const keyName = c.req.param("keyName");
        const deleted = await deleteSecret(c.env.DB, userId, keyName);
        return c.json({ ok: deleted, key_name: keyName });
    } catch (err) {
        return c.json({ error: String(err) }, 500);
    }
});

/**
 * GET /vault/keys/:keyName — decrypt and return a value.
 * ⚠️  INTERNAL USE ONLY — must add IP/secret guard before exposing to frontend.
 * Used by other Worker routes (e.g. tool execution) via same-Worker fetch.
 */
vault.get("/keys/:keyName", async (c) => {
    try {
        const userId = c.req.header("X-User-Id")!;
        // Internal-only guard
        const internalSecret = c.req.header("x-internal-secret");
        if (!c.env.TELEGRAM_INTERNAL_SECRET || internalSecret !== c.env.TELEGRAM_INTERNAL_SECRET) {
            return c.json({ error: "Forbidden" }, 403);
        }

        if (!c.env.VAULT_ENCRYPTION_SECRET) {
            return c.json({ error: "VAULT_ENCRYPTION_SECRET not configured" }, 500);
        }

        const keyName = c.req.param("keyName");
        const value = await vaultGet(
            c.env.DB,
            c.env.VAULT_ENCRYPTION_SECRET,
            userId,
            keyName
        );

        if (!value) return c.json({ error: "Secret not found" }, 404);
        return c.json({ key_name: keyName, value });
    } catch (err) {
        return c.json({ error: String(err) }, 500);
    }
});

export default vault;

// ─── Agent Tool Definitions ───────────────────────────────────────────────────
// Register these in src/tools/builtins.ts

export const VAULT_TOOL_DECLARATIONS = [
    {
        name: "set_secret",
        description:
            "Store an API key or secret in the user's encrypted vault. " +
            "Use this when the user provides an API key (e.g. OpenAI, GitHub, Stripe, Resend). " +
            "The value is encrypted with AES-256-GCM before storage. " +
            "VEGA's own Gemini key cannot be stored here — it is protected.",
        parameters: {
            type: "object",
            properties: {
                key_name: {
                    type: "string",
                    description:
                        "Lowercase identifier for this secret. Examples: 'openai_key', 'github_token', 'stripe_secret_key', 'resend_api_key'.",
                },
                value: {
                    type: "string",
                    description: "The secret value to encrypt and store.",
                },
                description: {
                    type: "string",
                    description: "Optional human-readable label shown in the vault UI.",
                },
            },
            required: ["key_name", "value"],
        },
    },
    {
        name: "get_secret",
        description:
            "Retrieve a decrypted secret from the user's vault by key name. " +
            "Use this before calling any integration tool to check if the user has provided their own API key. " +
            "Returns null if not found — fall back to asking the user to provide the key.",
        parameters: {
            type: "object",
            properties: {
                key_name: {
                    type: "string",
                    description: "The key name to look up, e.g. 'openai_key'.",
                },
            },
            required: ["key_name"],
        },
    },
    {
        name: "list_secrets",
        description:
            "List all key names stored in the user's vault (key names and hints only — never plaintext values).",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "delete_secret",
        description: "Remove a secret from the user's vault by key name.",
        parameters: {
            type: "object",
            properties: {
                key_name: { type: "string", description: "The key name to remove." },
            },
            required: ["key_name"],
        },
    },
];

/**
 * Execute vault tools.
 * Call this from the tool executor switch/case in builtins.ts.
 */
export async function executeVaultTool(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
    userId: string | undefined
): Promise<unknown> {
    if (!userId) return { error: "No userId in context — vault requires authentication." };
    if (!env.VAULT_ENCRYPTION_SECRET) return { error: "VAULT_ENCRYPTION_SECRET not set on Worker." };

    switch (toolName) {
        case "set_secret": {
            const result = await vaultSet(
                env.DB,
                env.VAULT_ENCRYPTION_SECRET,
                userId,
                String(args.key_name),
                String(args.value),
                args.description ? String(args.description) : undefined
            );
            return { ok: true, key_name: result.keyName, hint: result.hint };
        }

        case "get_secret": {
            const value = await vaultGet(
                env.DB,
                env.VAULT_ENCRYPTION_SECRET,
                userId,
                String(args.key_name)
            );
            return value !== null
                ? { key_name: args.key_name, value }
                : { key_name: args.key_name, value: null, message: "Secret not found in vault." };
        }

        case "list_secrets": {
            const secrets = await listSecrets(env.DB, userId);
            return {
                secrets: secrets.map((s) => ({
                    key_name: s.key_name,
                    hint: s.key_hint,
                    description: s.description,
                    updated_at: s.updated_at,
                })),
                count: secrets.length,
            };
        }

        case "delete_secret": {
            const deleted = await deleteSecret(env.DB, userId, String(args.key_name));
            return { ok: deleted, key_name: args.key_name };
        }

        default:
            return { error: `Unknown vault tool: ${toolName}` };
    }
}