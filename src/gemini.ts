/**
 * src/gemini.ts — Core Gemini AI client
 * Wraps @google/genai with thinking, multi-turn chat, tool calling, and vision.
 *
 * Thinking API facts (gemini-3-flash-preview):
 *  - ThinkingLevel enum does NOT exist in @google/genai — do not import it
 *  - thinkingConfig only supports: { includeThoughts?: boolean, thinkingBudget?: number }
 *  - The model thinks dynamically by default; includeThoughts exposes a thought summary
 *  - thoughtSignature on model parts MUST be preserved when feeding tool results back
 *    (see multi-turn agentic loop diagram: Turn 1 Step 2 requires Signature A, etc.)
 */
import { GoogleGenAI, Type } from "@google/genai";

export const MODEL = "gemini-3.1-flash-lite-preview";
export const TTS_MODEL = "gemini-2.5-flash-preview-tts";

// ─── Singleton ────────────────────────────────────────────────────────────────
let _ai: GoogleGenAI | null = null;
export function getAI(apiKey: string): GoogleGenAI {
  if (!_ai) _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Minimal chat message for persistent history (plain text turns only) */
export interface ChatMessage {
  role: "user" | "model";
  parts: { text: string }[];
}

/**
 * A raw content part that can include functionCall, functionResponse,
 * and the critical thoughtSignature — used in the agentic tool loop.
 *
 * As shown in the multi-turn diagram:
 *   Turn 1 Step 2 → must include Signature A from FC1
 *   Turn 1 Step 3 → must include Signature A (FC1) + Signature B (FC2)
 */
export interface RawPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}

export interface RawContent {
  role: "user" | "model";
  parts: RawPart[];
}

// ─── Single-turn with optional thought summary ────────────────────────────────
export async function think(
  apiKey: string,
  prompt: string,
  systemInstruction?: string,
  includeThoughts = false
): Promise<string> {
  const ai = getAI(apiKey);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      thinkingConfig: { includeThoughts },
      ...(systemInstruction && { systemInstruction }),
    },
  });

  if (!includeThoughts) return response.text ?? "";

  // When includeThoughts is true, separate thought parts from answer parts
  let answer = "";
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.text && !part.thought) answer += part.text;
  }
  return answer || response.text || "";
}

// ─── Multi-turn chat (clean text history, no tool parts) ─────────────────────
export async function chat(
  apiKey: string,
  history: ChatMessage[],
  newMessage: string,
  systemInstruction?: string
): Promise<string> {
  const ai = getAI(apiKey);
  const session = ai.chats.create({
    model: MODEL,
    history,
    config: {
      thinkingConfig: { includeThoughts: false },
      ...(systemInstruction && { systemInstruction }),
    },
  });
  const response = await session.sendMessage({ message: newMessage });
  return response.text ?? "";
}

/**
 * Agentic single generate step — accepts a full RawContent[] history and tools.
 *
 * Returns:
 *  - rawContent: the full model turn (with thoughtSignatures) to append to contents
 *  - functionCalls: tool calls the model wants to make (each with its signature)
 *  - text: any final text output (empty string if model only called tools)
 *
 * Caller is responsible for the accumulation loop:
 *   Step 1: [UserPrompt] → FC1 (+SigA)
 *   Step 2: [UserPrompt, FC1+SigA, FR1] → FC2 (+SigB)
 *   Step 3: [UserPrompt, FC1+SigA, FR1, FC2+SigB, FR2] → ModelText
 */
export async function generateWithTools(
  apiKey: string,
  contents: RawContent[],
  tools: ToolDeclaration[],
  systemInstruction?: string
): Promise<{
  rawContent: RawContent;
  functionCalls: { name: string; args: Record<string, unknown>; thoughtSignature?: string }[];
  text: string;
}> {
  const ai = getAI(apiKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: contents as any, // RawContent is a superset of the SDK's Content type
    config: {
      thinkingConfig: { includeThoughts: false },
      ...(systemInstruction && { systemInstruction }),
      tools: [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: { type: Type.OBJECT, ...t.parameters },
          })),
        },
      ],
    },
  });

  // Cast to any[] — thoughtSignature exists at runtime on thinking models
  // but is not yet in the @google/genai Part type definitions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidateParts = (response.candidates?.[0]?.content?.parts ?? []) as any[];

  // Build raw model turn — critically preserving thoughtSignature on every part
  const rawParts: RawPart[] = candidateParts.map((p) => {
    const part: RawPart = {};
    if (p.thoughtSignature) part.thoughtSignature = p.thoughtSignature as string;
    if (p.text) {
      part.text = p.text;
      if (p.thought) part.thought = true;
    }
    if (p.functionCall) {
      part.functionCall = {
        name: p.functionCall.name ?? "",
        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
      };
    }
    return part;
  });

  const rawContent: RawContent = { role: "model", parts: rawParts };

  // Each functionCall part carries its own thoughtSignature
  const functionCalls = rawParts
    .filter((p) => !!p.functionCall)
    .map((p) => ({
      name: p.functionCall!.name,
      args: p.functionCall!.args,
      thoughtSignature: p.thoughtSignature,
    }));

  const text = candidateParts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");

  return { rawContent, functionCalls, text };
}

// ─── Vision: analyze image via inline base64 data ────────────────────────────
export async function analyzeImage(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const ai = getAI(apiKey);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { data: imageBase64, mimeType } },
        ],
      },
    ],
    config: { thinkingConfig: { includeThoughts: false } },
  });
  return response.text ?? "";
}

// ─── TTS: text to speech generation ─────────────────────────────────────────
export async function generateGeminiAudio(
  apiKey: string,
  text: string,
  voiceName = "Puck",
  speechConfig?: any
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const ai = getAI(apiKey);
  try {
    const response = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: speechConfig ?? {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData || !inlineData.data) return null;

    const base64Data = inlineData.data;
    const mimeType = inlineData.mimeType || "audio/pcm";

    // Decode base64 to Uint8Array
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return { bytes, mimeType };
  } catch (err) {
    console.error("[generateGeminiAudio error]", err);
    return null;
  }
}

// ─── STT: speech to text transcription ──────────────────────────────────────
export async function transcribeGeminiAudio(
  apiKey: string,
  audioBase64: string,
  mimeType: string,
  prompt = "Please transcribe this audio exactly as it is spoken. Do not add any extra text or commentary."
): Promise<string> {
  const ai = getAI(apiKey);
  try {
    const response = await ai.models.generateContent({
      model: MODEL, // Use core model for audio understanding/STT
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { data: audioBase64, mimeType } },
            { text: prompt },
          ],
        },
      ],
      config: { thinkingConfig: { includeThoughts: false } },
    });
    return response.text ?? "";
  } catch (err) {
    console.error("[transcribeGeminiAudio error]", err);
    return "";
  }
}
