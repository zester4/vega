/**
 * ============================================================================
 * src/tools/translate.ts — Multi-Language Intelligence (Gemini-powered)
 * ============================================================================
 *
 * translate tool actions:
 *   detect               → Auto-detect language of any text
 *   translate            → Translate text between 32+ languages
 *   translate_document   → Translate longer documents preserving structure
 *   multilingual_search  → Generate search queries in multiple languages
 *   localize             → Culturally adapt content (not just word-for-word)
 *   list_languages       → List all supported languages
 *
 * 32+ Supported Languages:
 *   English, Spanish, French, German, Portuguese, Italian, Dutch,
 *   Polish, Russian, Ukrainian, Arabic, Hebrew, Farsi,
 *   Chinese (Simplified), Chinese (Traditional), Japanese, Korean,
 *   Hindi, Bengali, Tamil, Telugu, Urdu,
 *   Turkish, Vietnamese, Thai, Indonesian, Malay,
 *   Swahili, Hausa, Amharic, Yoruba, Igbo
 *
 * Powered by Gemini — no third-party translation API key needed.
 * ============================================================================
 */

export const SUPPORTED_LANGUAGES: Record<string, { name: string; code: string; script: string }> = {
  en:    { name: "English",              code: "en",    script: "Latin"     },
  es:    { name: "Spanish",              code: "es",    script: "Latin"     },
  fr:    { name: "French",               code: "fr",    script: "Latin"     },
  de:    { name: "German",               code: "de",    script: "Latin"     },
  pt:    { name: "Portuguese",           code: "pt",    script: "Latin"     },
  it:    { name: "Italian",              code: "it",    script: "Latin"     },
  nl:    { name: "Dutch",                code: "nl",    script: "Latin"     },
  pl:    { name: "Polish",               code: "pl",    script: "Latin"     },
  ru:    { name: "Russian",              code: "ru",    script: "Cyrillic"  },
  uk:    { name: "Ukrainian",            code: "uk",    script: "Cyrillic"  },
  ar:    { name: "Arabic",               code: "ar",    script: "Arabic"    },
  he:    { name: "Hebrew",               code: "he",    script: "Hebrew"    },
  fa:    { name: "Farsi/Persian",        code: "fa",    script: "Arabic"    },
  "zh-CN": { name: "Chinese (Simplified)",  code: "zh-CN", script: "Han"   },
  "zh-TW": { name: "Chinese (Traditional)", code: "zh-TW", script: "Han"   },
  ja:    { name: "Japanese",             code: "ja",    script: "CJK"       },
  ko:    { name: "Korean",               code: "ko",    script: "Hangul"    },
  hi:    { name: "Hindi",                code: "hi",    script: "Devanagari"},
  bn:    { name: "Bengali",              code: "bn",    script: "Bengali"   },
  ta:    { name: "Tamil",                code: "ta",    script: "Tamil"     },
  te:    { name: "Telugu",               code: "te",    script: "Telugu"    },
  ur:    { name: "Urdu",                 code: "ur",    script: "Arabic"    },
  tr:    { name: "Turkish",              code: "tr",    script: "Latin"     },
  vi:    { name: "Vietnamese",           code: "vi",    script: "Latin"     },
  th:    { name: "Thai",                 code: "th",    script: "Thai"      },
  id:    { name: "Indonesian",           code: "id",    script: "Latin"     },
  ms:    { name: "Malay",                code: "ms",    script: "Latin"     },
  sw:    { name: "Swahili",              code: "sw",    script: "Latin"     },
  ha:    { name: "Hausa",                code: "ha",    script: "Latin"     },
  am:    { name: "Amharic",              code: "am",    script: "Ethiopic"  },
  yo:    { name: "Yoruba",               code: "yo",    script: "Latin"     },
  ig:    { name: "Igbo",                 code: "ig",    script: "Latin"     },
};

export async function execTranslate(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const action = String(args.action ?? "translate") as
    | "detect"
    | "translate"
    | "translate_document"
    | "multilingual_search"
    | "localize"
    | "list_languages";

  if (!env.GEMINI_API_KEY) return { error: "GEMINI_API_KEY not configured" };

  const { think } = await import("../gemini");

  try {
    switch (action) {
      // ── DETECT LANGUAGE ─────────────────────────────────────────────────────
      case "detect": {
        const text = String(args.text ?? "").slice(0, 1000);
        if (!text) return { error: "text is required" };

        const result = await think(
          env.GEMINI_API_KEY,
          `Detect the language of this text. Return ONLY a JSON object:
{"languageCode":"<ISO 639-1 code>","languageName":"<full name>","confidence":"high|medium|low","script":"<script name>"}

Text:
"""
${text}
"""`,
          "You are a language detection expert. Return only valid JSON."
        );

        try {
          const clean = result.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(clean) as Record<string, string>;
          return { ...parsed, detectedText: text.slice(0, 100) };
        } catch {
          return { languageName: result.trim(), raw: result };
        }
      }

      // ── TRANSLATE TEXT ───────────────────────────────────────────────────────
      case "translate": {
        const text = String(args.text ?? "").slice(0, 5000);
        const targetLang = String(args.targetLanguage ?? "en");
        const sourceLang = args.sourceLanguage as string | undefined;
        const formality = String(args.formality ?? "neutral");

        if (!text) return { error: "text is required" };

        const targetName = SUPPORTED_LANGUAGES[targetLang]?.name ?? targetLang;
        const sourceName = sourceLang
          ? (SUPPORTED_LANGUAGES[sourceLang]?.name ?? sourceLang)
          : "auto-detect";

        const translated = await think(
          env.GEMINI_API_KEY,
          `Translate from ${sourceName} to ${targetName}.${formality !== "neutral" ? ` Tone: ${formality}.` : ""}
Rules: translate ONLY the text, preserve formatting (newlines, bullets), return ONLY the translation.

Text:
"""
${text}
"""`,
          `Expert ${targetName} translator. Return only the translated text.`
        );

        return {
          original: text,
          translated: translated.trim(),
          sourceLanguage: sourceName,
          targetLanguage: targetName,
          targetCode: targetLang,
          charCount: text.length,
        };
      }

      // ── TRANSLATE DOCUMENT (preserves structure) ─────────────────────────────
      case "translate_document": {
        const content = String(args.content ?? "");
        const targetLang = String(args.targetLanguage ?? "en");
        const format = String(args.format ?? "markdown");

        if (!content) return { error: "content is required" };

        const targetName = SUPPORTED_LANGUAGES[targetLang]?.name ?? targetLang;

        // Chunk to 2000 chars to avoid token limits
        const chunks: string[] = [];
        for (let i = 0; i < content.length; i += 2000) {
          chunks.push(content.slice(i, i + 2000));
        }

        const translatedChunks = await Promise.all(
          chunks.map(async (chunk) => {
            const r = await think(
              env.GEMINI_API_KEY,
              `Translate this ${format} content to ${targetName}.
Preserve all ${format} formatting, headers, code blocks (translate prose only).
Return ONLY the translated ${format}.

Content:
${chunk}`,
              `Expert ${targetName} translator. Preserve ${format} structure.`
            );
            return r.trim();
          })
        );

        const fullTranslation = translatedChunks.join("\n");
        return {
          success: true,
          translated: fullTranslation,
          targetLanguage: targetName,
          targetCode: targetLang,
          originalLength: content.length,
          translatedLength: fullTranslation.length,
          chunks: chunks.length,
        };
      }

      // ── MULTILINGUAL SEARCH ──────────────────────────────────────────────────
      case "multilingual_search": {
        const query = String(args.query ?? "");
        const languages = (args.languages as string[]) ?? ["es", "fr", "de", "zh-CN", "ar"];
        if (!query) return { error: "query is required" };

        const maxLangs = Math.min(languages.length, 5);
        const jobs = languages.slice(0, maxLangs).map(async (lang) => {
          const langName = SUPPORTED_LANGUAGES[lang]?.name ?? lang;
          const translated = await think(
            env.GEMINI_API_KEY,
            `Translate this search query to ${langName}. Return ONLY the translated query:\n"${query}"`,
            "Translator. Return only the translation."
          );
          return { lang, langName, query: translated.trim() };
        });

        const translatedQueries = await Promise.all(jobs);
        return {
          originalQuery: query,
          originalLanguage: "en",
          translatedQueries,
          tip: "Use web_search with each translatedQuery to find international sources.",
        };
      }

      // ── LOCALIZE (cultural adaptation) ────────────────────────────────────────
      case "localize": {
        const content = String(args.content ?? "").slice(0, 3000);
        const targetLocale = String(args.targetLocale ?? "en-US");
        const context = String(args.context ?? "general");

        if (!content) return { error: "content is required" };

        const localized = await think(
          env.GEMINI_API_KEY,
          `Localize this content for ${targetLocale} audience in a ${context} context.
- Translate naturally into the target language
- Adapt cultural references, idioms, humor, and examples for the local audience
- Adjust formality for local business norms
- Replace foreign brand/product examples with local equivalents when relevant
- Return only the localized content, no explanations

Content:
"""
${content}
"""`,
          `Expert cultural adaptation specialist for ${targetLocale}.`
        );

        return {
          original: content,
          localized: localized.trim(),
          targetLocale,
          context,
        };
      }

      // ── LIST LANGUAGES ────────────────────────────────────────────────────────
      case "list_languages": {
        return {
          count: Object.keys(SUPPORTED_LANGUAGES).length,
          languages: Object.entries(SUPPORTED_LANGUAGES).map(([code, l]) => ({
            code,
            name: l.name,
            script: l.script,
          })),
        };
      }

      default:
        return { error: `Unknown translate action: ${action}. Use: detect, translate, translate_document, multilingual_search, localize, list_languages` };
    }
  } catch (err) {
    return { error: `Translation failed: ${String(err)}` };
  }
}

// ── Detect user language (used by telegram.ts) ────────────────────────────────
export async function detectUserLanguage(message: string, env: Env): Promise<string> {
  if (!env.GEMINI_API_KEY || message.length < 5) return "en";
  try {
    const { think } = await import("../gemini");
    const result = await think(
      env.GEMINI_API_KEY,
      `What is the ISO 639-1 language code of this text? Return ONLY the 2-5 character code (e.g. "en", "es", "zh-CN"):\n"${message.slice(0, 200)}"`,
      "Language detector. Return only the ISO code."
    );
    const code = result.trim().toLowerCase().slice(0, 5).replace(/[^a-z-]/g, "");
    return SUPPORTED_LANGUAGES[code] ? code : "en";
  } catch {
    return "en";
  }
}
