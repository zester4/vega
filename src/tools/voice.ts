/**
 * ============================================================================
 * src/tools/voice.ts — Gemini Voice Tools (TTS + STT)
 * ============================================================================
 *
 * text_to_speech:
 *   - Converts text to lifelike speech using Gemini 2.5 Flash TTS
 *   - Supports 30 prebuilt voices (Zephyr, Puck, Kore, etc.)
 *   - Outputs 24kHz 16-bit Mono WAV, stored in R2
 *
 * speech_to_text:
 *   - Transcribes audio using Gemini native multimodal understanding
 *   - Supports 90+ languages auto-detected
 *
 * ============================================================================
 */

import { generateGeminiAudio, transcribeGeminiAudio } from "../gemini";

// ─── WAV Header Utility ──────────────────────────────────────────────────────

/**
 * Creates a 44-byte RIFF/WAV header for 16-bit Mono PCM data.
 * Gemini TTS output is 24000Hz, 16-bit, 1 channel.
 */
function createWavHeader(pcmDataLen: number, sampleRate = 24000): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  // RIFF identifier
  header.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + pcmDataLen, true);
  header.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // "fmt " subchunk
  header.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true); // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true); // BitsPerSample (16)

  // "data" subchunk
  header.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, pcmDataLen, true);

  return header;
}

// ─── TEXT TO SPEECH ───────────────────────────────────────────────────────────

export async function execTextToSpeech(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const text = String(args.text ?? "").slice(0, 10000); // Gemini limit is higher
  const voiceName = String(args.voiceName ?? args.voiceId ?? "Puck"); // fallback to Puck

  if (!text) return { error: "text is required" };

  // ── Async dispatch: avoid SSE stream / Worker timeout ────────────────────────
  //
  // Gemini TTS takes 15-60 s per request — it WILL timeout inside a
  // synchronous /chat request on most plans.  When _sessionId is injected
  // by agent.ts AND QStash is configured, publish to /run-media instead.
  //
  const sessionId = args._sessionId as string | undefined;
  const workerUrl = (env as unknown as Record<string, string>).WORKER_URL ?? "";
  const qstashUrl = (env as unknown as Record<string, string>).QSTASH_URL ?? "";

  if (sessionId && env.QSTASH_TOKEN && workerUrl && qstashUrl) {
    const taskId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const userId = (args._userId as string | undefined) ??
      (sessionId.startsWith("user-") ? sessionId.replace("user-", "") : null);

    try {
      const { Client: QStashClient } = await import("@upstash/qstash");
      const qstash = new QStashClient({ token: env.QSTASH_TOKEN, baseUrl: qstashUrl });

      const { getRedis, createTask } = await import("../memory");
      const redis = getRedis(env);
      await createTask(redis, {
        id: taskId,
        type: "tts_generation",
        payload: { chars: text.length, voiceName, sessionId },
        status: "pending",
      });

      const { _sessionId: _drop, _userId: _dropUser, ...cleanArgs } = args as Record<string, unknown> & { _sessionId?: unknown; _userId?: unknown };

      await qstash.publishJSON({
        url: `${workerUrl.replace(/\/$/, "")}/run-media`,
        body: {
          type: "audio",
          taskId,
          parentSessionId: sessionId,
          userId,
          args: cleanArgs,
        },
        headers: {
          "x-internal-secret": (env as unknown as Record<string, string>).TELEGRAM_INTERNAL_SECRET ?? "",
        },
      });

      return {
        status: "pending",
        taskId,
        message: `🔊 Audio generation queued (${text.length} chars, voice: ${voiceName}). Task: **${taskId}**\n\nYou'll be notified when the WAV is ready. Poll: \`get_task_status("${taskId}")\``,
        voiceName,
        charCount: text.length,
      };
    } catch (qErr) {
      console.warn("[text_to_speech] Async queue failed, falling back to sync:", String(qErr));
    }
  }

  // ── Synchronous execution (local dev or QStash unavailable) ──────────────────
  try {
    const audioData = await generateGeminiAudio(env.GEMINI_API_KEY, text, voiceName);
    if (!audioData) return { error: "Gemini TTS generation failed" };

    let wavBytes = audioData.bytes;
    if (audioData.mimeType !== "audio/wav") {
      // Wrap raw PCM in WAV header
      const header = createWavHeader(audioData.bytes.length, 24000);
      wavBytes = new Uint8Array(header.length + audioData.bytes.length);
      wavBytes.set(header, 0);
      wavBytes.set(audioData.bytes, header.length);
    }

    const audioSizeKB = Math.round(wavBytes.length / 1024);
    const filename = `voice/tts-${Date.now()}.wav`;
    let audioUrl = `[audio:${filename}:${audioSizeKB}KB]`;

    if (env.FILES_BUCKET) {
      await env.FILES_BUCKET.put(filename, wavBytes, {
        httpMetadata: { contentType: "audio/wav" },
      });
      audioUrl = `${(env as never as Record<string, string>).WORKER_URL ?? ""}/files/${filename}`;
    }

    return {
      success: true,
      audioUrl,
      filename,
      audioSizeKB,
      model: "gemini-2.5-flash-preview-tts",
      voiceName,
      charCount: text.length,
      note: "Audio stored as WAV in R2.",
    };
  } catch (err) {
    return { error: `TTS execution failed: ${String(err)}` };
  }
}

// ── Helper: get raw audio bytes for Telegram voice (internal use) ─────────────
export async function generateSpeechBytes(
  text: string,
  env: Env,
  voiceName?: string
): Promise<Uint8Array | null> {
  try {
    const audioData = await generateGeminiAudio(env.GEMINI_API_KEY, text, voiceName ?? "Puck");
    if (!audioData) return null;

    if (audioData.mimeType === "audio/wav") {
      return audioData.bytes;
    }

    const header = createWavHeader(audioData.bytes.length, 24000);
    const wavBytes = new Uint8Array(header.length + audioData.bytes.length);
    wavBytes.set(header, 0);
    wavBytes.set(audioData.bytes, header.length);

    return wavBytes;
  } catch {
    return null;
  }
}

// ─── SPEECH TO TEXT ───────────────────────────────────────────────────────────

export async function execSpeechToText(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  try {
    let audioBytes: Uint8Array;
    let mimeType = "audio/wav";

    if (args.audioBase64) {
      const b64 = String(args.audioBase64);
      mimeType = String(args.mimeType ?? "audio/ogg");
      const binaryString = atob(b64);
      audioBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) audioBytes[i] = binaryString.charCodeAt(i);
    } else if (args.filename && env.FILES_BUCKET) {
      const obj = await env.FILES_BUCKET.get(String(args.filename));
      if (!obj) return { error: `File not found in R2: ${args.filename}` };
      audioBytes = new Uint8Array(await obj.arrayBuffer());
      mimeType = obj.httpMetadata?.contentType ?? "audio/wav";
    } else if (args.audioUrl) {
      const audioRes = await fetch(String(args.audioUrl));
      if (!audioRes.ok) return { error: `Failed to fetch audio: ${audioRes.status}` };
      audioBytes = new Uint8Array(await audioRes.arrayBuffer());
      mimeType = audioRes.headers.get("content-type") ?? "audio/wav";
    } else {
      return { error: "Provide audioBase64, filename (R2 key), or audioUrl" };
    }

    // Convert bytes back to base64 for Gemini call
    const base64 = btoa(String.fromCharCode(...audioBytes));
    const transcript = await transcribeGeminiAudio(env.GEMINI_API_KEY, base64, mimeType);

    return {
      success: true,
      transcript,
      model: "gemini-3.1-flash-lite-preview",
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
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json() as { ok: boolean; result?: { file_path: string } };
    if (!fileData.ok || !fileData.result?.file_path) return null;

    const audioRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
    if (!audioRes.ok) return null;

    const audioBytes = new Uint8Array(await audioRes.arrayBuffer());
    const base64 = btoa(String.fromCharCode(...audioBytes));

    // Telegram voice is usually ogg/opus
    return await transcribeGeminiAudio(env.GEMINI_API_KEY, base64, "audio/ogg");
  } catch {
    return null;
  }
}