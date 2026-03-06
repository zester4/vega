/**
 * ============================================================================
 * src/routes/profile.ts — VEGA User Personality Profile
 * ============================================================================
 *
 * Each user has a private profile stored in R2 at profiles/{userId}/profile.md
 * It is injected into the system prompt on every request, making VEGA feel like
 * it genuinely knows the user — their role, preferences, how they like to work.
 *
 * Profile is:
 *   - Built automatically from conversation turns (agent.ts calls updateProfile)
 *   - Manually editable by the user via the update_profile tool
 *   - Injected at the START of every system prompt (highest priority context)
 *   - Never truncated — kept concise by design (Gemini writes/rewrites it)
 *
 * R2 path: profiles/{userId}/profile.md
 *
 * Agent Tools:
 *   update_profile(updates)  → rewrite profile with new information
 *   get_profile()            → read current profile
 *
 * ============================================================================
 */

// ─── R2 Profile Store ─────────────────────────────────────────────────────────

const PROFILE_MAX_CHARS = 2000; // Keep it tight — injected into every prompt

function profileKey(userId: string): string {
    return `profiles/${userId}/profile.md`;
}

/**
 * Read the user's profile from R2.
 * Returns null if no profile exists yet.
 */
export async function getProfile(
    bucket: R2Bucket,
    userId: string
): Promise<string | null> {
    try {
        const obj = await bucket.get(profileKey(userId));
        if (!obj) return null;
        return await obj.text();
    } catch {
        return null;
    }
}

/**
 * Write (overwrite) the user's profile in R2.
 */
export async function setProfile(
    bucket: R2Bucket,
    userId: string,
    content: string
): Promise<void> {
    const trimmed = content.slice(0, PROFILE_MAX_CHARS);
    await bucket.put(profileKey(userId), trimmed, {
        httpMetadata: { contentType: "text/markdown" },
        customMetadata: { userId, updatedAt: new Date().toISOString() },
    });
}

/**
 * Build the profile injection string for the system prompt.
 * Returns empty string if no profile exists — zero overhead for new users.
 */
export async function getProfileInjection(
    bucket: R2Bucket | undefined,
    userId: string | undefined
): Promise<string> {
    if (!bucket || !userId) return "";
    const profile = await getProfile(bucket, userId).catch(() => null);
    if (!profile || !profile.trim()) return "";
    return `\n════════════════════════════════════════════════════════\nUSER PROFILE (always apply this context)\n════════════════════════════════════════════════════════\n${profile.trim()}\n`;
}

/**
 * Auto-update the profile from a conversation turn.
 * Called from agent.ts after each turn. Uses Gemini to intelligently
 * merge new facts into the existing profile without bloating it.
 *
 * Non-blocking — failures never interrupt the agent.
 */
export async function autoUpdateProfile(
    env: Env,
    userId: string,
    userMessage: string,
    agentReply: string
): Promise<void> {
    if (!env.FILES_BUCKET) return;

    try {
        const existing = await getProfile(env.FILES_BUCKET, userId);

        const { think } = await import("../gemini");

        const updated = await think(
            env.GEMINI_API_KEY,
            `You are maintaining a concise user profile for an AI assistant called VEGA.

EXISTING PROFILE:
${existing ?? "(empty — no profile yet)"}

NEW CONVERSATION TURN:
User: ${userMessage.slice(0, 500)}
VEGA: ${agentReply.slice(0, 500)}

Your task: Update the profile to include any NEW long-term facts revealed in this turn.
Long-term facts include: job/role, expertise level, tools/languages they use, communication preferences,
timezone, goals, recurring tasks, personality, how they like responses formatted.

Rules:
- Keep the total profile under 400 words
- Write in second person ("You are a software engineer...")
- Merge new facts — don't duplicate what's already there
- Remove outdated facts if contradicted
- If nothing new was revealed, return the existing profile unchanged
- Format as clean markdown with sections: ## Role & Background, ## Preferences, ## Context

Return ONLY the updated profile markdown. No commentary.`,
            "You are a precise profile editor. Return only the updated profile markdown."
        );

        if (updated && updated.trim().length > 20) {
            await setProfile(env.FILES_BUCKET, userId, updated.trim());
        }
    } catch {
        // Completely non-fatal — profile update failure never affects the user
    }
}

// ─── Agent Tool Declarations ──────────────────────────────────────────────────

export const PROFILE_TOOL_DECLARATIONS = [
    {
        name: "get_profile",
        description:
            "Read the current user profile — a concise summary of who the user is, " +
            "their role, preferences, and how they like to work. " +
            "Use this to understand the user better before making recommendations.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "update_profile",
        description:
            "Update the user's persistent profile with new information. " +
            "Use this when the user explicitly tells you something about themselves, " +
            "their preferences, or how they want VEGA to behave. " +
            "The profile is injected into every conversation so VEGA always has this context. " +
            "Examples: 'I prefer concise replies', 'I am a senior backend engineer', " +
            "'Always respond in Spanish', 'My timezone is GMT+1'.",
        parameters: {
            type: "object",
            properties: {
                updates: {
                    type: "string",
                    description:
                        "Natural language description of what to add or change. " +
                        "Example: 'User prefers bullet points. User is a Python developer. " +
                        "User is based in London.'",
                },
            },
            required: ["updates"],
        },
    },
];

// ─── Agent Tool Executor ──────────────────────────────────────────────────────

export async function executeProfileTool(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
    userId: string | undefined
): Promise<unknown> {
    if (!userId) return { error: "Profile tools require authentication." };
    if (!env.FILES_BUCKET) return { error: "FILES_BUCKET not configured." };

    switch (toolName) {
        case "get_profile": {
            const profile = await getProfile(env.FILES_BUCKET, userId);
            return profile
                ? { profile, length: profile.length }
                : { profile: null, message: "No profile yet. It builds automatically as we talk." };
        }

        case "update_profile": {
            const { updates } = args as { updates: string };
            const existing = await getProfile(env.FILES_BUCKET, userId);

            const { think } = await import("../gemini");
            const newProfile = await think(
                env.GEMINI_API_KEY,
                `You are updating a user profile for an AI assistant.

EXISTING PROFILE:
${existing ?? "(empty)"}

USER REQUESTED UPDATES:
${updates}

Rewrite the profile to incorporate these updates. Keep it under 400 words.
Format with sections: ## Role & Background, ## Preferences, ## Context
Write in second person. Return ONLY the updated profile markdown.`,
                "Return only the updated profile markdown."
            );

            await setProfile(env.FILES_BUCKET, userId, newProfile.trim());
            return {
                ok: true,
                message: "✅ Profile updated. This context will be applied to all future conversations.",
                preview: newProfile.slice(0, 300) + (newProfile.length > 300 ? "..." : ""),
            };
        }

        default:
            return { error: `Unknown profile tool: ${toolName}` };
    }
}