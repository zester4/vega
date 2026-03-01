/**
 * ============================================================================
 * src/tools/voice.ts — ElevenLabs Voice Tools (TTS + STT)
 * ============================================================================
 *
 * text_to_speech:
 *   - Converts text to lifelike speech using ElevenLabs
 *   - Models: eleven_flash_v2_5 (75ms latency), eleven_multilingual_v2 (quality)
 *   - 32 languages supported
 *   - Stores MP3 in R2, returns URL (no token bloat)
 *   - Used by Telegram bot to send voice replies
 *
 * speech_to_text:
 *   - Transcribes audio files using ElevenLabs Scribe v2
 *   - 90+ languages, speaker diarization, audio event tagging
 *   - Used by Telegram bot to handle incoming voice messages
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY   → https://elevenlabs.io/app/settings/api-keys
 *   ELEVENLABS_VOICE_ID  → Default voice ID (optional, falls back to "Rachel")
 *   FILES_BUCKET         → Cloudflare R2 binding (optional, stores audio)
 * ============================================================================
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Default voice: "Rachel" (alloy, neutral, works well globally)
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

// Model options
const TTS_MODELS = {
  flash: "eleven_flash_v2_5",        // ~75ms, great for real-time
  multilingual: "eleven_multilingual_v2", // Best quality, 32 languages
  v3: "eleven_v3",                   // Maximum expressiveness
  turbo: "eleven_turbo_v2_5",        // Balanced ~250-300ms
} as const;

const STT_MODEL = "scribe_v2"; // Best accuracy, 90+ languages

// ─── TEXT TO SPEECH ───────────────────────────────────────────────────────────

export async function execTextToSpeech(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const text = String(args.text ?? "").slice(0, 5000); // ElevenLabs limit
  const voiceId = String(args.voiceId ?? (env as never as Record<string, string>).ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID);
  const modelKey = String(args.model ?? "multilingual") as keyof typeof TTS_MODELS;
  const modelId = TTS_MODELS[modelKey] ?? TTS_MODELS.multilingual;
  const stability = Number(args.stability ?? 0.5);
  const similarityBoost = Number(args.similarityBoost ?? 0.75);
  const languageCode = args.languageCode as string | undefined; // ISO 639-1

  if (!text) return { error: "text is required" };

  const apiKey = (env as never as Record<string, string>).ELEVENLABS_API_KEY;
  if (!apiKey) return { error: "ELEVENLABS_API_KEY not configured. Add it as a Cloudflare secret." };

  try {
    const response = await fetch(
      `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          ...(languageCode && { language_code: languageCode }),
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
          },
          output_format: "mp3_44100_128", // high quality mp3
        }),
      }
    );

    if (!response.ok) {
      const errBody = await response.text();
      return { error: `ElevenLabs TTS failed: ${response.status} — ${errBody.slice(0, 300)}` };
    }

    // Get audio bytes
    const audioBuffer = await response.arrayBuffer();
    const audioBytes = new Uint8Array(audioBuffer);
    const audioSizeKB = Math.round(audioBytes.length / 1024);

    // Store in R2 to prevent token bloat
    const filename = `voice/tts-${Date.now()}.mp3`;
    let audioUrl = `[audio:${filename}:${audioSizeKB}KB]`;

    if (env.FILES_BUCKET) {
      await env.FILES_BUCKET.put(filename, audioBytes, {
        httpMetadata: { contentType: "audio/mpeg" },
      });
      audioUrl = `${(env as never as Record<string, string>).UPSTASH_WORKFLOW_URL ?? ""}/files/${filename}`;
    }

    return {
      success: true,
      audioUrl,
      filename,
      audioSizeKB,
      model: modelId,
      voiceId,
      charCount: text.length,
      note: "Audio stored in R2. Stream or download via audioUrl.",
    };
  } catch (err) {
    return { error: `TTS execution failed: ${String(err)}` };
  }
}

// ── Helper: get raw audio bytes for Telegram voice (internal use) ─────────────
export async function generateSpeechBytes(
  text: string,
  env: Env,
  voiceId?: string
): Promise<Uint8Array | null> {
  const apiKey = (env as never as Record<string, string>).ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId ?? DEFAULT_VOICE_ID)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text: text.slice(0, 2000), // Keep voice messages concise
          model_id: TTS_MODELS.flash, // Use fast model for Telegram (low latency)
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          output_format: "mp3_44100_128",
        }),
      }
    );

    if (!response.ok) return null;
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// ─── SPEECH TO TEXT ───────────────────────────────────────────────────────────

export async function execSpeechToText(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  // Can accept:
  //   audioUrl: string (public URL to audio file)
  //   audioBase64: string + mimeType: string (base64 encoded audio)
  //   filename: string (R2 file key)

  const apiKey = (env as never as Record<string, string>).ELEVENLABS_API_KEY;
  if (!apiKey) return { error: "ELEVENLABS_API_KEY not configured." };

  const languageCode = args.languageCode as string | undefined;
  const diarize = Boolean(args.diarize ?? false);
  const tagAudioEvents = Boolean(args.tagAudioEvents ?? true);

  try {
    let audioBytes: Uint8Array;
    let mimeType = "audio/mpeg";
    let sourceFilename = "audio.mp3";

    if (args.audioBase64) {
      // Decode base64 audio
      const b64 = String(args.audioBase64);
      mimeType = String(args.mimeType ?? "audio/ogg");
      audioBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      sourceFilename = `audio.${mimeType.split("/")[1] ?? "ogg"}`;
    } else if (args.filename && env.FILES_BUCKET) {
      // Read from R2
      const obj = await env.FILES_BUCKET.get(String(args.filename));
      if (!obj) return { error: `File not found in R2: ${args.filename}` };
      audioBytes = new Uint8Array(await obj.arrayBuffer());
      sourceFilename = String(args.filename).split("/").pop() ?? "audio.mp3";
    } else if (args.audioUrl) {
      // Fetch from URL
      const audioRes = await fetch(String(args.audioUrl));
      if (!audioRes.ok) return { error: `Failed to fetch audio from URL: ${audioRes.status}` };
      audioBytes = new Uint8Array(await audioRes.arrayBuffer());
      mimeType = audioRes.headers.get("content-type") ?? "audio/mpeg";
    } else {
      return { error: "Provide audioBase64, filename (R2 key), or audioUrl" };
    }

    // Build multipart form for ElevenLabs STT
    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array(audioBytes)], { type: mimeType });
    formData.append("file", audioBlob, sourceFilename);
    formData.append("model_id", STT_MODEL);
    if (languageCode) formData.append("language_code", languageCode);
    if (tagAudioEvents) formData.append("tag_audio_events", "true");
    if (diarize) formData.append("diarize", "true");
    formData.append("timestamps_granularity", "word");

    const response = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      return { error: `ElevenLabs STT failed: ${response.status} — ${err.slice(0, 300)}` };
    }

    const result = await response.json() as {
      text: string;
      language_code?: string;
      language_probability?: number;
      words?: Array<{ text: string; start: number; end: number; type: string }>;
      speakers?: Array<{ speaker_id: string; text: string }>;
    };

    return {
      success: true,
      transcript: result.text,
      detectedLanguage: result.language_code,
      languageConfidence: result.language_probability,
      wordCount: result.words?.length ?? 0,
      speakers: result.speakers ?? [],
      model: STT_MODEL,
    };
  } catch (err) {
    return { error: `STT execution failed: ${String(err)}` };
  }
}

// ── Helper: transcribe Telegram voice message (internal use) ──────────────────
export async function transcribeTelegramVoice(
  fileId: string,
  botToken: string,
  env: Env
): Promise<string | null> {
  const apiKey = (env as never as Record<string, string>).ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  try {
    // 1. Get file path from Telegram
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
    );
    const fileData = await fileRes.json() as { ok: boolean; result?: { file_path: string } };
    if (!fileData.ok || !fileData.result?.file_path) return null;

    // 2. Download the audio file
    const audioRes = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`
    );
    if (!audioRes.ok) return null;

    const audioBytes = new Uint8Array(await audioRes.arrayBuffer());

    // Telegram voice messages are OGG/OPUS format
    const formData = new FormData();
    const blob = new Blob([audioBytes], { type: "audio/ogg" });
    formData.append("file", blob, "voice.ogg");
    formData.append("model_id", STT_MODEL);
    formData.append("tag_audio_events", "false");

    const sttRes = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
    });

    if (!sttRes.ok) return null;
    const data = await sttRes.json() as { text: string };
    return data.text ?? null;
  } catch {
    return null;
  }
}