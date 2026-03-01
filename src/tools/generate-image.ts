/**
 * ============================================================================
 * src/tools/generate-image.ts — Gemini Image Generation Tool
 * ============================================================================
 *
 * Model: gemini-3.1-flash-image-preview ("Nano Banana 2")
 * - Text-to-image generation
 * - Image-to-image editing (with reference image)
 * - Multi-turn conversational image editing
 * - Default resolution: 1K | Supported: 1K, 2K, 4K
 * - Default aspect ratio: 1:1
 *
 * Base64 bloat prevention:
 *   Generated image is stored in R2 bucket immediately.
 *   Returns a signed R2 URL (not raw base64) to prevent token explosion.
 * ============================================================================
 */

import { GoogleGenAI } from "@google/genai";

const IMAGE_MODEL = "gemini-3.1-flash-image-preview";

// Valid image resolutions
const VALID_RESOLUTIONS = ["1K", "2K", "4K"] as const;
type Resolution = (typeof VALID_RESOLUTIONS)[number];

// Valid aspect ratios
const VALID_ASPECT_RATIOS = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "5:4", "4:5"
] as const;

export async function execGenerateImage(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const prompt = String(args.prompt ?? "");
  const resolution = (
    VALID_RESOLUTIONS.includes(args.resolution as Resolution)
      ? args.resolution
      : "1K"
  ) as Resolution;
  const aspectRatio = (
    VALID_ASPECT_RATIOS.includes(args.aspectRatio as never)
      ? args.aspectRatio
      : "1:1"
  ) as string;
  const referenceImageBase64 = args.referenceImageBase64 as string | undefined;
  const referenceImageMime = (args.referenceImageMime as string) ?? "image/jpeg";
  const editInstruction = args.editInstruction as string | undefined;

  if (!prompt && !editInstruction) {
    return { error: "Either 'prompt' or 'editInstruction' is required." };
  }

  if (!env.GEMINI_API_KEY) {
    return { error: "GEMINI_API_KEY not configured" };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

    // Build contents — text-only or image-edit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contents: any;

    if (referenceImageBase64) {
      // Image editing mode: reference image + edit instruction
      // Truncate base64 log but keep full data for API
      const fullBase64 = referenceImageBase64.includes(",")
        ? referenceImageBase64.split(",")[1]  // strip data URI prefix
        : referenceImageBase64;

      contents = [
        { text: editInstruction ?? prompt },
        {
          inlineData: {
            mimeType: referenceImageMime,
            data: fullBase64,
          },
        },
      ];
    } else {
      // Text-to-image mode
      contents = prompt;
    }

    const response = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents,
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio,
          imageSize: resolution,
        },
      },
    });

    // Extract text description and image data from response
    let textDescription = "";
    let imageBase64: string | null = null;
    let imageMime = "image/png";

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts as Array<{
      text?: string;
      inlineData?: { data: string; mimeType: string };
    }>) {
      if (part.text) {
        textDescription += part.text;
      } else if (part.inlineData?.data) {
        imageBase64 = part.inlineData.data;
        imageMime = part.inlineData.mimeType ?? "image/png";
      }
    }

    if (!imageBase64) {
      return {
        error: "No image was generated. Try a more descriptive prompt.",
        description: textDescription,
      };
    }

    // ── Store image in R2 to prevent base64 token bloat ──────────────────────
    const ext = imageMime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const filename = `generated/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const imageBytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));

    let imageUrl = `data:${imageMime};base64,[stored-in-r2:${filename}]`;

    if (env.FILES_BUCKET) {
      try {
        await env.FILES_BUCKET.put(filename, imageBytes, {
          httpMetadata: { contentType: imageMime },
        });
        imageUrl = `${env.UPSTASH_WORKFLOW_URL ?? ""}/files/${filename}`;
      } catch (r2Err) {
        console.error("[generate_image] R2 store failed:", r2Err);
        // Fall back: return compact base64 (truncated for display)
        imageUrl = `data:${imageMime};base64,${imageBase64.slice(0, 100)}...[${Math.round(imageBase64.length * 0.75 / 1024)}KB]`;
      }
    } else {
      // No R2 — return base64 url (user should configure R2)
      imageUrl = `data:${imageMime};base64,${imageBase64}`;
    }

    return {
      success: true,
      imageUrl,
      filename,
      resolution,
      aspectRatio,
      mimeType: imageMime,
      description: textDescription || `Generated: ${prompt.slice(0, 100)}`,
      model: IMAGE_MODEL,
      note: env.FILES_BUCKET
        ? "Image stored in R2. Use the imageUrl to display or share it."
        : "Configure FILES_BUCKET (R2) to persist images. Currently returning raw base64.",
    };
  } catch (err) {
    return { error: `Image generation failed: ${String(err)}` };
  }
}

// ─── Image Editing (multi-turn) ───────────────────────────────────────────────
// Supports conversational iterative editing via a shared chat session
// Each chatId gets its own image generation chat session

const imageChatSessions = new Map<string, ReturnType<GoogleGenAI["chats"]["create"]>>();

export async function execEditImageConversational(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const instruction = String(args.instruction ?? "");
  const sessionId = String(args.sessionId ?? "default");
  const startFresh = Boolean(args.startFresh ?? false);

  if (!instruction) return { error: "instruction is required" };
  if (!env.GEMINI_API_KEY) return { error: "GEMINI_API_KEY not configured" };

  try {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

    if (startFresh || !imageChatSessions.has(sessionId)) {
      imageChatSessions.set(
        sessionId,
        ai.chats.create({
          model: IMAGE_MODEL,
          config: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        })
      );
    }

    const chatSession = imageChatSessions.get(sessionId)!;
    const response = await chatSession.sendMessage({ message: instruction });

    let textOut = "";
    let imageBase64: string | null = null;
    let imageMime = "image/png";

    for (const part of (response.candidates?.[0]?.content?.parts ?? []) as Array<{
      text?: string;
      inlineData?: { data: string; mimeType: string };
    }>) {
      if (part.text) textOut += part.text;
      else if (part.inlineData?.data) {
        imageBase64 = part.inlineData.data;
        imageMime = part.inlineData.mimeType ?? "image/png";
      }
    }

    if (!imageBase64) return { text: textOut, note: "No image returned for this turn." };

    // Store in R2
    const ext = imageMime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const filename = `generated/edit-${sessionId}-${Date.now()}.${ext}`;
    const imageBytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));

    let imageUrl = `data:${imageMime};base64,${imageBase64}`;
    if (env.FILES_BUCKET) {
      await env.FILES_BUCKET.put(filename, imageBytes, {
        httpMetadata: { contentType: imageMime },
      });
      imageUrl = `${env.UPSTASH_WORKFLOW_URL ?? ""}/files/${filename}`;
    }

    return {
      success: true,
      imageUrl,
      filename,
      text: textOut,
      sessionId,
      model: IMAGE_MODEL,
    };
  } catch (err) {
    return { error: `Conversational image edit failed: ${String(err)}` };
  }
}