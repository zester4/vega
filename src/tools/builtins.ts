/**
 * ============================================================================
 * src/tools/builtins.ts — VEGA Complete Tool Suite
 * ============================================================================
 *
 * RULE: Every executor MUST return Promise<Record<string, unknown>>
 * Gemini's functionResponse.response is a protobuf Struct — it ONLY
 * accepts plain JSON objects, never bare strings, arrays, or null.
 *
 * Tool Index:
 *   SEARCH & FETCH
 *     web_search        → Google search via Serper.dev (DuckDuckGo fallback)
 *     fetch_url         → Fetch any URL, strips HTML, returns text/JSON
 *     browse_web        → Full headless browser (JS-rendered pages, SPAs)
 *
 *   MEMORY
 *     store_memory      → Redis KV write (permanent or TTL)
 *     recall_memory     → Redis KV read by key
 *     list_memories     → List all stored memory keys
 *     delete_memory     → Delete a memory key
 *     semantic_store    → Vector embedding memory (Upstash Vector)
 *     semantic_recall   → Semantic similarity search
 *     share_memory      → Write to shared cross-agent memory namespace
 *     read_agent_memory → Read another agent's memory namespace
 *
 *   FILES (Cloudflare R2)
 *     write_file        → Store text/JSON/code in R2 bucket
 *     read_file         → Read file from R2 bucket
 *     list_files        → List files in R2 bucket by prefix
 *     delete_file       → Delete file from R2 bucket
 *
 *   CODE & COMPUTE
 *     run_code          → Execute Python in E2B secure sandbox
 *     calculate         → Safe math expression evaluator
 *
 *   AGENT INFRASTRUCTURE
 *     trigger_workflow  → Start long-running durable workflow (hours)
 *     get_task_status   → Poll workflow/task status
 *     spawn_agent       → Create a sub-agent for parallel work
 *     get_agent_result  → Retrieve sub-agent output
 *     list_agents       → Show all active/completed sub-agents
 *     cancel_agent      → Kill a running sub-agent
 *     create_tool       → Build a new tool (generates & stores real JS)
 *     benchmark_tool    → Test a registered tool and record performance
 *
 *   SCHEDULING
 *     schedule_cron     → Create QStash recurring cron job
 *     get_datetime      → Current date/time in any timezone
 *
 *   INTEGRATIONS
 *     github            → GitHub API (repos, files, issues, code search)
 *     send_email        → Send email via Resend
 *     send_sms          → Send SMS via Twilio
 *     local_fs          → Full local filesystem access (OS-agnostic)
 *
 *   IMAGE & VOICE
 *     generate_image    → Gemini 3.1 Flash Image Preview (Nano Banana 2)
 *     text_to_speech    → ElevenLabs TTS (32 languages, MP3 to R2)
 *     speech_to_text    → ElevenLabs Scribe v2 STT (90+ languages)
 *
 *   MARKET INTELLIGENCE
 *     market_data       → Yahoo Finance live prices, portfolio, alerts
 *
 *   LANGUAGE
 *     translate         → Gemini-powered translation (32+ languages)
 *
 *   GOALS & PROACTIVE
 *     manage_goals      → Long-term goal tracking with milestones
 *     proactive_notify  → Push Telegram messages without user prompt
 *
 *   WEB SCRAPING
 *     firecrawl         → Deep scraping: JS pages, PDFs, anti-bot
 *
 * ============================================================================
 */

import { Client as QStashClient } from "@upstash/qstash";
import type { RegisteredTool } from "../memory";
import { execLocalFsTool } from "./local-fs";

// ─── Tool Declarations (Gemini sees these) ────────────────────────────────────

export const BUILTIN_DECLARATIONS = [

  // ── SEARCH & FETCH ──────────────────────────────────────────────────────────

  {
    name: "web_search",
    description:
      "Search Google via Serper.dev for real-time web results. Returns titles, snippets, and URLs. ALWAYS use this for current events, news, facts, people, prices, weather, anything time-sensitive or that may have changed.",
    parameters: {
      properties: {
        query: { type: "string", description: "Search query" },
        type: { type: "string", description: "Search type: 'search' (default) or 'news' for recent articles", enum: ["search", "news"] },
        maxResults: { type: "number", description: "Max results (default 6, max 10)" },
      },
      required: ["query"],
    },
  },

  {
    name: "fetch_url",
    description:
      "Fetch and read a URL. Returns cleaned text (HTML stripped) or raw JSON. Use web_search first to find URLs, then this to read full content. NOTE: Cannot handle JS-rendered pages — use browse_web for those.",
    parameters: {
      properties: {
        url: { type: "string", description: "Full URL to fetch including https://" },
        method: { type: "string", description: "GET or POST", enum: ["GET", "POST"] },
        body: { type: "string", description: "JSON body string for POST requests" },
      },
      required: ["url"],
    },
  },

  {
    name: "browse_web",
    description:
      "Full headless browser for JavaScript-rendered pages, SPAs, and dynamic content. Use this when fetch_url returns empty or incomplete content. Can extract full page text, take screenshots, and wait for dynamic elements to load. Supports React, Next.js, Angular, and any modern web app.",
    parameters: {
      properties: {
        url: { type: "string", description: "Full URL to open in the browser" },
        action: { type: "string", description: "What to do: 'content' (extract text, default), 'screenshot' (take a screenshot)", enum: ["content", "screenshot"] },
        waitFor: { type: "string", description: "Optional CSS selector to wait for before extracting content e.g. '.main-content', '#app'" },
        extract: { type: "string", description: "Optional CSS selector to extract specific element text instead of full page" },
      },
      required: ["url"],
    },
  },

  // ── MEMORY ──────────────────────────────────────────────────────────────────

  {
    name: "store_memory",
    description:
      "Persist a key-value pair to long-term Redis memory that survives across all sessions and conversations. Use to remember user preferences, goals, facts, and important task results. Keys should be descriptive e.g. 'user_name', 'project_goal', 'api_endpoint'.",
    parameters: {
      properties: {
        key: { type: "string", description: "Memory key in snake_case e.g. 'user_timezone', 'project_goal'" },
        value: { type: "string", description: "Value to store (can be JSON string for complex data)" },
        ttlSeconds: { type: "number", description: "Optional TTL in seconds. Omit for permanent storage." },
      },
      required: ["key", "value"],
    },
  },

  {
    name: "recall_memory",
    description: "Retrieve a value from long-term Redis memory by its exact key. Returns the stored value or indicates the key was not found.",
    parameters: {
      properties: {
        key: { type: "string", description: "Exact memory key to look up" },
      },
      required: ["key"],
    },
  },

  {
    name: "list_memories",
    description: "List all memory keys the agent has stored, optionally filtered by prefix. Use to discover what you remember before starting new tasks.",
    parameters: {
      properties: {
        prefix: { type: "string", description: "Optional key prefix filter e.g. 'user_' lists all user memories, '' lists all" },
      },
      required: [],
    },
  },

  {
    name: "delete_memory",
    description: "Delete a key from long-term memory. Use to clean up outdated or incorrect facts.",
    parameters: {
      properties: {
        key: { type: "string", description: "Exact key to delete" },
      },
      required: ["key"],
    },
  },

  {
    name: "semantic_store",
    description:
      "Store a memory by its MEANING using vector embedding. Best for recording complex interactions, discovered facts, summaries, or concepts that are not easily categorized by a single key. Enables later retrieval by natural language similarity.",
    parameters: {
      properties: {
        text: { type: "string", description: "The content to remember semantically" },
        metadata: { type: "object", description: "Optional JSON metadata tags e.g. {topic: 'finance', source: 'web_search'}" },
      },
      required: ["text"],
    },
  },

  {
    name: "semantic_recall",
    description: "Find past memories related to a query by MEANING (vector similarity search). Returns the most semantically similar stored memories. Use before starting research to check what you already know.",
    parameters: {
      properties: {
        query: { type: "string", description: "Natural language query to search memories" },
        topK: { type: "number", description: "Number of results to return (default 5)" },
      },
      required: ["query"],
    },
  },

  {
    name: "share_memory",
    description:
      "Write a value to a SHARED memory namespace accessible by all sub-agents and the parent agent. Use this for inter-agent communication — e.g. a researcher sub-agent shares findings so the analyst sub-agent can read them.",
    parameters: {
      properties: {
        namespace: { type: "string", description: "Shared namespace name e.g. 'project-x', 'research-2025'" },
        key: { type: "string", description: "Key within the namespace" },
        value: { type: "string", description: "Value to share (can be JSON string)" },
      },
      required: ["namespace", "key", "value"],
    },
  },

  {
    name: "read_agent_memory",
    description:
      "Read values from another agent's memory namespace. Use to retrieve results that a sub-agent has stored. The agentId is the ID returned by spawn_agent.",
    parameters: {
      properties: {
        agentId: { type: "string", description: "The sub-agent's ID or shared namespace name to read from" },
        key: { type: "string", description: "Specific key to read, or omit to list all keys in this agent's namespace" },
      },
      required: ["agentId"],
    },
  },

  // ── FILES ───────────────────────────────────────────────────────────────────

  {
    name: "write_file",
    description:
      "Store text, JSON, code, reports, or any content as a file in persistent R2 storage. Files survive indefinitely across sessions. Use path like 'reports/analysis.md', 'data/results.json', 'code/tool.js'. Great for: saving research reports, generated code, processed data.",
    parameters: {
      properties: {
        path: { type: "string", description: "File path e.g. 'reports/weekly-digest.md', 'data/prices.json'" },
        content: { type: "string", description: "File content as a string" },
        contentType: { type: "string", description: "MIME type e.g. 'text/markdown', 'application/json', 'text/plain' (default: text/plain)" },
      },
      required: ["path", "content"],
    },
  },

  {
    name: "read_file",
    description: "Read a file from persistent R2 storage by path. Returns the file content as a string.",
    parameters: {
      properties: {
        path: { type: "string", description: "Exact file path to read e.g. 'reports/weekly-digest.md'" },
      },
      required: ["path"],
    },
  },

  {
    name: "list_files",
    description: "List files stored in persistent R2 storage, optionally filtered by path prefix. Use to discover stored files.",
    parameters: {
      properties: {
        prefix: { type: "string", description: "Optional path prefix filter e.g. 'reports/' to list only reports" },
      },
      required: [],
    },
  },

  {
    name: "delete_file",
    description: "Delete a file from persistent R2 storage.",
    parameters: {
      properties: {
        path: { type: "string", description: "Exact file path to delete" },
      },
      required: ["path"],
    },
  },

  // ── CODE & COMPUTE ──────────────────────────────────────────────────────────

  {
    name: "run_code",
    description:
      "Execute Python code in a secure E2B cloud sandbox. Returns real stdout, stderr, errors, and outputs. Perfect for: data analysis, charting with matplotlib, web scraping with requests/BeautifulSoup, math, file processing, API calls. Can install pip packages.",
    parameters: {
      properties: {
        code: { type: "string", description: "Python code to execute" },
        packages: { type: "string", description: "Comma-separated pip packages to install first e.g. 'pandas,matplotlib,requests'" },
      },
      required: ["code"],
    },
  },

  {
    name: "calculate",
    description: "Safely evaluate a mathematical expression and return the exact numeric result. Supports arithmetic, exponents, modulo, and Math functions (sqrt, abs, floor, ceil, pow, log, sin, cos).",
    parameters: {
      properties: {
        expression: { type: "string", description: "Math expression e.g. '(12 * 8) / 3.14', 'Math.sqrt(144)', '2 ** 32'" },
      },
      required: ["expression"],
    },
  },

  // ── AGENT INFRASTRUCTURE ────────────────────────────────────────────────────

  {
    name: "trigger_workflow",
    description:
      "Start a long-running DURABLE workflow that can run for hours or days without breaking. Each step is retried automatically on failure. Use for: multi-step research, batch processing, monitoring tasks, anything taking more than 60 seconds. Returns a taskId to poll with get_task_status.",
    parameters: {
      properties: {
        taskType: { type: "string", description: "Short descriptive label e.g. 'research', 'monitor', 'analysis', 'batch-process'" },
        instructions: { type: "string", description: "Complete detailed instructions for the workflow" },
        steps: { type: "string", description: "Optional JSON array of step strings to execute in order e.g. '[\"Step 1: search\", \"Step 2: analyze\"]'" },
        sessionId: { type: "string", description: "Optional session ID to associate results with" },
      },
      required: ["taskType", "instructions"],
    },
  },

  {
    name: "get_task_status",
    description: "Check the status and results of a workflow task or sub-agent. Status can be: 'running', 'done', 'error'. Returns progress info and final results when complete.",
    parameters: {
      properties: {
        taskId: { type: "string", description: "Task ID returned by trigger_workflow or spawn_agent" },
      },
      required: ["taskId"],
    },
  },

  {
    name: "spawn_agent",
    description:
      "Create an AUTONOMOUS SUB-AGENT that runs a specialized task in parallel in the background. The sub-agent has access to all tools and full memory. Use for: parallel research, specialized analysis, monitoring, any task that can run independently. Returns an agentId immediately — use get_agent_result() to retrieve output when done.",
    parameters: {
      properties: {
        agentName: { type: "string", description: "Role name for this agent e.g. 'researcher', 'analyst', 'coder', 'monitor'" },
        instructions: { type: "string", description: "Complete detailed instructions for what this agent should do and what it should produce" },
        allowedTools: { type: "string", description: "Comma-separated list of tools to allow (empty = ALL tools)" },
        memoryPrefix: { type: "string", description: "Namespace for this agent's memories e.g. 'research-q1-2025'. Defaults to agentId." },
        notifyEmail: { type: "string", description: "Optional email address to notify when this agent completes" },
        priority: { type: "string", description: "Execution priority: 'normal' (default) or 'high'", enum: ["normal", "high"] },
      },
      required: ["agentName", "instructions"],
    },
  },

  {
    name: "get_agent_result",
    description:
      "Get the status, progress, and results of a sub-agent you spawned with spawn_agent. Returns progress percentage while running, and the full output when done.",
    parameters: {
      properties: {
        agentId: { type: "string", description: "Agent ID returned by spawn_agent" },
      },
      required: ["agentId"],
    },
  },

  {
    name: "list_agents",
    description: "List all sub-agents that have been spawned in this session or globally, with their current status and progress.",
    parameters: {
      properties: {
        sessionId: { type: "string", description: "Filter by session ID (optional, leave empty for all agents)" },
        status: { type: "string", description: "Filter by status: 'running', 'done', 'error', or 'all' (default)", enum: ["running", "done", "error", "all"] },
      },
      required: [],
    },
  },

  {
    name: "cancel_agent",
    description: "Cancel a running sub-agent and stop its workflow. The agent will be marked as 'cancelled' and its results so far will be preserved.",
    parameters: {
      properties: {
        agentId: { type: "string", description: "Agent ID to cancel" },
        reason: { type: "string", description: "Optional reason for cancellation" },
      },
      required: ["agentId"],
    },
  },

  {
    name: "create_tool",
    description:
      "BUILD a new tool by writing real JavaScript code and registering it in your tool registry. The tool will be immediately available for use. Use when you identify a repeating capability gap. Generates, tests, and stores working JS code — not just a description.",
    parameters: {
      properties: {
        name: { type: "string", description: "Tool name in snake_case e.g. 'get_stock_price', 'parse_rss_feed'" },
        description: { type: "string", description: "What the tool does and when to use it (shown to the AI)" },
        requirements: { type: "string", description: "Detailed requirements: what inputs it takes, what APIs to call, what it should return" },
        parameters: { type: "string", description: "JSON string of the parameters schema e.g. '{\"properties\":{\"symbol\":{\"type\":\"string\"}},\"required\":[\"symbol\"]}'" },
      },
      required: ["name", "description", "requirements"],
    },
  },

  {
    name: "benchmark_tool",
    description: "Test a registered tool with sample inputs and record its performance, accuracy, and reliability. Use to validate tools after creation or after failures.",
    parameters: {
      properties: {
        toolName: { type: "string", description: "Name of the tool to benchmark" },
        testInputs: { type: "string", description: "JSON string of test arguments to pass to the tool e.g. '{\"query\": \"test\"}'" },
      },
      required: ["toolName"],
    },
  },

  // ── SCHEDULING ──────────────────────────────────────────────────────────────

  {
    name: "schedule_cron",
    description:
      "Create a recurring automated job via QStash that runs on a cron schedule. Use for: hourly monitoring, daily reports, weekly digests, periodic data collection. The agent uses this to schedule its own future tasks autonomously.",
    parameters: {
      properties: {
        url: { type: "string", description: "Your worker endpoint URL to call on each tick" },
        cron: { type: "string", description: "Cron expression e.g. '0 9 * * 1' (every Monday 9am UTC), '*/30 * * * *' (every 30 min)" },
        body: { type: "string", description: "JSON payload to send on each invocation" },
        description: { type: "string", description: "Human-readable description of what this job does" },
      },
      required: ["url", "cron", "description"],
    },
  },

  {
    name: "get_datetime",
    description: "Get the current date and time in UTC and optionally in a specific timezone. Use before any time-sensitive operations.",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "Optional IANA timezone e.g. 'America/New_York', 'Europe/London', 'Asia/Tokyo'" },
      },
      required: [],
    },
  },

  {
    name: "local_fs",
    description: "Full read/write/exec access to your local machine (MacOS, Windows, Linux). Built-in Smart Filtering: Excludes node_modules, .next, .git by default. Features 12+ operations. Bulk read and search supported. CRITICAL: Destructive/System-level actions triggered an Approval Gate.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Operation to perform",
          enum: ["list", "read", "write", "delete", "move", "copy", "mkdir", "exists", "stats", "search", "exec"]
        },
        path: { type: "string", description: "Primary target path (relative to project root)" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of paths for bulk 'read' operation"
        },
        content: { type: "string", description: "Content for 'write' operation" },
        newPath: { type: "string", description: "Destination for 'move' or 'copy'" },
        pattern: { type: "string", description: "Filename pattern/substring for 'search'" },
        command: { type: "string", description: "Terminal command for 'exec' (Approved only)" },
        showHidden: { type: "boolean", description: "If true, overrides filters and shows node_modules, etc." }
      },
      required: ["action"],
    },
  },
  // ── CRON REGISTRY & APPROVALS ──────────────────────────────────────────────

  {
    name: "list_crons",
    description: "List all known cron schedules created by this agent, including cron expressions, descriptions, and destinations.",
    parameters: {
      properties: {},
      required: [],
    },
  },

  {
    name: "update_cron",
    description: "Update an existing cron schedule's cadence, body, and/or description. Under the hood this recreates the schedule safely.",
    parameters: {
      properties: {
        scheduleId: { type: "string", description: "The scheduleId returned when the cron was created (or from list_crons)" },
        cron: { type: "string", description: "New cron expression (leave empty to keep current)" },
        body: { type: "string", description: "New JSON body string to send with each run (leave empty to keep current)" },
        description: { type: "string", description: "Updated human-readable description" },
      },
      required: ["scheduleId"],
    },
  },

  {
    name: "delete_cron",
    description: "Delete a cron schedule. The job will no longer run. This also removes local metadata.",
    parameters: {
      properties: {
        scheduleId: { type: "string", description: "The scheduleId of the cron to delete" },
      },
      required: ["scheduleId"],
    },
  },

  {
    name: "human_approval_gate",
    description: "Request explicit human approval before performing a sensitive operation (e.g. sending email, modifying repos). Creates an approval record and notifies the configured channel(s). Returns a pending status that can be checked later.",
    parameters: {
      properties: {
        operation: { type: "string", description: "Plain-English description of what you want to do, including risks and impact" },
        channel: { type: "string", description: "Where to request approval: 'ui', 'telegram', 'email', or 'all' (default: 'ui')", enum: ["ui", "telegram", "email", "all"] },
        metadata: { type: "object", description: "Optional JSON metadata (e.g. { repo, branch, files }) that helps the user decide" },
      },
      required: ["operation"],
    },
  },

  {
    name: "ingest_knowledge_base",
    description: "Fetch and embed external knowledge into long-term semantic memory. Provide URLs and/or raw texts; content will be chunked and stored in Upstash Vector for later semantic_recall/RAG.",
    parameters: {
      properties: {
        urls: {
          type: "array",
          description: "Array of URLs (articles, docs, blogs, API docs) to ingest",
          items: { type: "string" },
        },
        texts: {
          type: "array",
          description: "Raw text snippets or documents to embed directly",
          items: { type: "string" },
        },
        topic: {
          type: "string",
          description: "Optional high-level topic label for these sources (used as metadata tag)",
        },
      },
      required: [],
    },
  },

  // ── INTEGRATIONS ────────────────────────────────────────────────────────────

  {
    name: "github",
    description:
      "Interact with GitHub. List repos, read files, search code across repositories, create and list issues. Perfect for code analysis, project management, and development workflows.",
    parameters: {
      properties: {
        action: { type: "string", enum: ["list_repos", "get_file", "search_code", "create_issue", "list_issues", "get_repo_info", "list_commits"], description: "Action to perform" },
        owner: { type: "string", description: "Repository owner (username or org)" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "File path for get_file action" },
        query: { type: "string", description: "Search query for search_code action" },
        title: { type: "string", description: "Issue title for create_issue" },
        body: { type: "string", description: "Issue body/description for create_issue" },
        branch: { type: "string", description: "Branch name for list_commits (default: main)" },
      },
      required: ["action"],
    },
  },

  {
    name: "send_email",
    description: "Send an email notification via Resend. Use to notify users of completed long-running tasks, send reports, or deliver agent findings. Supports markdown in the body.",
    parameters: {
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email content (markdown or plain text)" },
      },
      required: ["to", "subject", "body"],
    },
  },

  {
    name: "send_sms",
    description: "Send an SMS text message via Twilio. Use for urgent notifications or short summaries when email is too slow.",
    parameters: {
      properties: {
        to: { type: "string", description: "Recipient phone number in E.164 format e.g. +1234567890" },
        message: { type: "string", description: "SMS message content (max 160 chars recommended for single message)" },
      },
      required: ["to", "message"],
    },
  },

  // ── IMAGE GENERATION (Gemini Nano Banana 2) ────────────────────────────────

  {
    name: "generate_image",
    description:
      "Generate or edit images using Gemini 3.1 Flash Image Preview (Nano Banana 2 — gemini-3.1-flash-image-preview). Creates high-quality images from text prompts, or edits existing images with reference+instruction. Images are stored in R2 and returned as URLs (no token bloat). Supports 1K (default), 2K, 4K resolutions and multiple aspect ratios.",
    parameters: {
      properties: {
        prompt: { type: "string", description: "Detailed text description of the image to generate. Be very descriptive for best results." },
        resolution: { type: "string", description: "Image resolution: '1K' (default, fast), '2K' (high quality), '4K' (ultra)", enum: ["1K", "2K", "4K"] },
        aspectRatio: { type: "string", description: "Aspect ratio: '1:1' (default, square), '16:9' (landscape), '9:16' (portrait), '4:3', '3:4', '5:4', '4:5'", enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "5:4", "4:5"] },
        referenceImageBase64: { type: "string", description: "Base64 encoded reference image for image editing (strip the data URI prefix)." },
        referenceImageMime: { type: "string", description: "MIME type of reference image", enum: ["image/jpeg", "image/png", "image/webp"] },
        editInstruction: { type: "string", description: "When editing an existing image, describe the desired changes" },
      },
      required: [],
    },
  },

  // ── TEXT TO SPEECH (ElevenLabs) ─────────────────────────────────────────────

  {
    name: "text_to_speech",
    description:
      "Convert text to lifelike speech using ElevenLabs. Generates MP3 stored in R2. Perfect for voice content, narrations, Telegram voice replies. Models: 'flash' (75ms, real-time), 'multilingual' (best quality, 32 languages), 'turbo' (balanced), 'v3' (most expressive). Requires ELEVENLABS_API_KEY.",
    parameters: {
      properties: {
        text: { type: "string", description: "Text to convert to speech (max 5000 chars)" },
        voiceId: { type: "string", description: "ElevenLabs voice ID. Defaults to Rachel. Find voices at elevenlabs.io/voice-library" },
        model: { type: "string", description: "TTS model: 'flash' (fastest 75ms), 'multilingual' (best quality), 'turbo' (balanced), 'v3' (most expressive)", enum: ["flash", "multilingual", "turbo", "v3"] },
        languageCode: { type: "string", description: "ISO 639-1 language code for normalization (e.g. 'en', 'es', 'fr', 'zh')" },
        stability: { type: "number", description: "Voice stability 0-1 (default 0.5). Higher = more consistent." },
        similarityBoost: { type: "number", description: "Similarity boost 0-1 (default 0.75)." },
      },
      required: ["text"],
    },
  },

  // ── SPEECH TO TEXT (ElevenLabs Scribe v2) ───────────────────────────────────

  {
    name: "speech_to_text",
    description:
      "Transcribe audio to text using ElevenLabs Scribe v2 — state-of-the-art accuracy across 90+ languages. Supports speaker diarization, audio event tagging, and word-level timestamps. Accepts a public audio URL, R2 filename, or base64 audio. Requires ELEVENLABS_API_KEY.",
    parameters: {
      properties: {
        audioUrl: { type: "string", description: "Public URL to audio/video file (MP3, WAV, OGG, MP4, etc.)" },
        audioBase64: { type: "string", description: "Base64 encoded audio data (for smaller files)" },
        mimeType: { type: "string", description: "MIME type: 'audio/mpeg', 'audio/ogg', 'audio/wav', 'video/mp4'" },
        filename: { type: "string", description: "R2 bucket key if audio is already stored (e.g. 'voice/recording.mp3')" },
        languageCode: { type: "string", description: "ISO 639-1 code if known (improves accuracy). Leave empty for auto-detect." },
        diarize: { type: "boolean", description: "Identify different speakers (default false)" },
        tagAudioEvents: { type: "boolean", description: "Tag non-speech events like [laughter], [music] (default true)" },
      },
      required: [],
    },
  },

  // ── MARKET DATA (Yahoo Finance — free, no API key) ──────────────────────────

  {
    name: "market_data",
    description:
      "Real-time and historical market data via Yahoo Finance (free, no API key needed). Actions: 'quote' (single live price), 'multi_quote' (batch up to 20 symbols), 'history' (OHLCV historical data), 'search' (find ticker symbols), 'portfolio' (tracked positions with live prices), 'set_alert' (price alert → proactive Telegram push), 'list_alerts', 'delete_alert', 'news' (latest market news). Works for stocks, crypto (BTC-USD), ETFs, forex (EURUSD=X).",
    parameters: {
      properties: {
        action: { type: "string", enum: ["quote", "multi_quote", "history", "search", "portfolio", "set_alert", "list_alerts", "delete_alert", "news"], description: "Action to perform" },
        symbol: { type: "string", description: "Ticker symbol e.g. AAPL, BTC-USD, EURUSD=X, ETH-USD, MSFT, TSLA" },
        symbols: { type: "array", description: "Multiple symbols for multi_quote (max 20)", items: { type: "string" } },
        range: { type: "string", description: "Historical range: '1d','5d','1mo','3mo','6mo','1y','2y','5y','ytd','max'" },
        interval: { type: "string", description: "Data interval: '1m','5m','15m','30m','1h','1d','1wk','1mo'" },
        query: { type: "string", description: "Company name to search for ticker symbols" },
        targetPrice: { type: "number", description: "Price target for set_alert" },
        direction: { type: "string", enum: ["above", "below"], description: "Alert trigger direction" },
        telegramChatId: { type: "string", description: "Telegram chat ID to notify when price alert triggers" },
        alertId: { type: "string", description: "Alert ID for delete_alert" },
      },
      required: ["action"],
    },
  },

  // ── GOAL MANAGEMENT ──────────────────────────────────────────────────────────

  {
    name: "manage_goals",
    description:
      "Create and track long-term goals with milestones and autonomous progress pursuit. VEGA checks active goals every session and proactively advances them. Goals can trigger Telegram notifications at progress milestones (25%, 50%, 75%, 100%). Stalled high-priority goals are auto-notified via cron.",
    parameters: {
      properties: {
        action: { type: "string", enum: ["create_goal", "update_progress", "list_goals", "get_goal", "complete_goal", "delete_goal", "complete_milestone", "check_all"], description: "Action to perform" },
        title: { type: "string", description: "Goal title (required for create_goal)" },
        description: { type: "string", description: "Detailed goal description" },
        category: { type: "string", description: "Goal category: business, research, personal, monitoring, custom" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Priority level" },
        milestones: { type: "array", description: "List of milestone titles (strings)", items: { type: "string" } },
        nextAction: { type: "string", description: "What VEGA should do next to advance this goal" },
        notifyOnProgress: { type: "boolean", description: "Send Telegram notification at milestone progress percentages" },
        telegramChatId: { type: "string", description: "Telegram chat ID for progress notifications" },
        goalId: { type: "string", description: "Goal ID (required for update/complete/delete)" },
        milestoneId: { type: "string", description: "Milestone ID for complete_milestone" },
        progress: { type: "number", description: "Progress percentage 0-100 for update_progress" },
        notes: { type: "string", description: "Progress notes or next action" },
        status: { type: "string", description: "Filter goals by status: active, completed, paused, cancelled" },
      },
      required: ["action"],
    },
  },

  // ── PROACTIVE TELEGRAM NOTIFY ─────────────────────────────────────────────────

  {
    name: "proactive_notify",
    description:
      "Send a proactive Telegram message WITHOUT waiting for user input. VEGA initiates the conversation. Use for: task completion, price alerts, goal milestones, error spikes, breaking news, scheduled briefings. The message appears as a new Telegram message. Requires Telegram bot to be connected.",
    parameters: {
      properties: {
        chatId: { type: "string", description: "Telegram chat ID. Users can find their chat ID via the /status command." },
        message: { type: "string", description: "HTML-formatted message. Supports <b>bold</b>, <i>italic</i>, <code>code</code>, <a href='url'>links</a>" },
      },
      required: ["chatId", "message"],
    },
  },

  // ── TRANSLATION & MULTI-LANGUAGE ─────────────────────────────────────────────

  {
    name: "translate",
    description:
      "Translate, detect language, and localize content across 32+ languages. Powered by Gemini (no extra API key). Actions: 'detect' (auto-detect language), 'translate' (text translation), 'translate_document' (preserve markdown/HTML structure), 'multilingual_search' (generate queries in multiple languages for international research), 'localize' (cultural adaptation), 'list_languages'. Languages: English, Spanish, French, German, Portuguese, Italian, Dutch, Polish, Russian, Ukrainian, Arabic, Hebrew, Farsi, Chinese (Simplified/Traditional), Japanese, Korean, Hindi, Bengali, Tamil, Turkish, Vietnamese, Thai, Indonesian, Swahili, Hausa, Amharic, Yoruba, Igbo, and more.",
    parameters: {
      properties: {
        action: { type: "string", enum: ["detect", "translate", "translate_document", "multilingual_search", "localize", "list_languages"], description: "Translation action" },
        text: { type: "string", description: "Text to detect or translate" },
        content: { type: "string", description: "Document content for translate_document or localize" },
        query: { type: "string", description: "Search query for multilingual_search" },
        targetLanguage: { type: "string", description: "Target language ISO code: 'es', 'fr', 'de', 'zh-CN', 'ar', 'ja', 'ko', 'hi', 'ru', 'pt', etc." },
        sourceLanguage: { type: "string", description: "Source language ISO code (optional, auto-detected if not set)" },
        languages: { type: "array", description: "Target languages for multilingual_search (max 5)", items: { type: "string" } },
        format: { type: "string", enum: ["markdown", "html", "plain"], description: "Document format for translate_document" },
        formality: { type: "string", enum: ["formal", "informal", "neutral"], description: "Tone of translation" },
        targetLocale: { type: "string", description: "Locale for cultural adaptation e.g. 'es-MX', 'zh-CN', 'fr-FR', 'ar-AE'" },
        context: { type: "string", enum: ["marketing", "technical", "legal", "casual", "general"], description: "Content context for localize" },
      },
      required: ["action"],
    },
  },

  // ── FIRECRAWL (Deep Web Scraping) ─────────────────────────────────────────────

  {
    name: "firecrawl",
    description:
      "Advanced web scraping using Firecrawl — handles JavaScript-rendered pages, React/Next.js SPAs, anti-bot protection, and PDFs. Far superior to fetch_url for complex modern sites. Modes: 'scrape' (single URL → clean Markdown), 'search' (web search + full content extraction in one call), 'crawl' (entire website → Markdown, async job), 'extract' (get crawl job status/results). Requires FIRECRAWL_API_KEY (free at firecrawl.dev).",
    parameters: {
      properties: {
        mode: { type: "string", enum: ["scrape", "search", "crawl", "extract"], description: "Operation mode" },
        url: { type: "string", description: "URL to scrape or crawl (required for scrape/crawl modes)" },
        query: { type: "string", description: "Search query (required for search mode)" },
        formats: { type: "array", description: "Output formats: ['markdown', 'html', 'links', 'json']", items: { type: "string" } },
        extractPrompt: { type: "string", description: "AI extraction prompt e.g. 'Extract all product prices and names'" },
        limit: { type: "number", description: "Max pages to crawl (max 100) or search results (max 10)" },
        prompt: { type: "string", description: "Natural language crawl directive e.g. 'Only crawl API documentation pages'" },
        crawlJobId: { type: "string", description: "Crawl job ID to poll status (extract mode)" },
        waitFor: { type: "number", description: "Milliseconds to wait for dynamic content to load" },
        lang: { type: "string", description: "Language code for search results (e.g. 'en', 'es')" },
        scrapeContent: { type: "boolean", description: "Fetch full content from search results (default true)" },
      },
      required: ["mode"],
    },
  },

] as const;

// ─── Type Helpers ─────────────────────────────────────────────────────────────
type ToolArgs = Record<string, unknown>;

// ─── Main Dispatcher ──────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  args: ToolArgs,
  env: Env
): Promise<Record<string, unknown>> {
  try {
    // Track tool usage for self-evolution heuristics
    try {
      const { getRedis } = await import("../memory");
      const redis = getRedis(env);
      const key = `agent:tool-usage:${toolName}`;
      await redis.incr(key);
      await redis.expire(key, 60 * 60 * 24); // 24h window
    } catch (usageErr) {
      console.warn("[ToolUsage] Failed to record usage:", String(usageErr));
    }

    switch (toolName) {

      // Search & Fetch
      case "web_search": return await execWebSearch(args, env);
      case "fetch_url": return await execFetchUrl(args);
      case "browse_web": return await execBrowseWeb(args, env);

      // Memory
      case "store_memory": return await execStoreMemory(args, env);
      case "recall_memory": return await execRecallMemory(args, env);
      case "list_memories": return await execListMemories(args, env);
      case "delete_memory": return await execDeleteMemory(args, env);
      case "semantic_store": return await execSemanticStore(args, env);
      case "semantic_recall": return await execSemanticRecall(args, env);
      case "share_memory": return await execShareMemory(args, env);
      case "read_agent_memory": return await execReadAgentMemory(args, env);

      // Files
      case "write_file": return await execWriteFile(args, env);
      case "read_file": return await execReadFile(args, env);
      case "list_files": return await execListFiles(args, env);
      case "delete_file": return await execDeleteFile(args, env);

      // Code & Compute
      case "run_code": return await execRunCode(args, env);
      case "calculate": return execCalculate(args);

      // Agent Infrastructure
      case "trigger_workflow": return await execTriggerWorkflow(args, env);
      case "get_task_status": return await execGetTaskStatus(args, env);
      case "spawn_agent": return await execSpawnAgent(args, env);
      case "get_agent_result": return await execGetAgentResult(args, env);
      case "list_agents": return await execListAgents(args, env);
      case "cancel_agent": return await execCancelAgent(args, env);
      case "create_tool": return await execCreateTool(args, env);
      case "benchmark_tool": return await execBenchmarkTool(args, env);

      // Scheduling
      case "schedule_cron": return await execScheduleCron(args, env);
      case "list_crons": return await execListCrons(args, env);
      case "update_cron": return await execUpdateCron(args, env);
      case "delete_cron": return await execDeleteCron(args, env);
      case "human_approval_gate": return await execHumanApprovalGate(args, env);
      case "ingest_knowledge_base": return await execIngestKnowledgeBase(args, env);

      // Integrations
      case "github": return await execGithub(args, env);
      case "send_email": return await execSendEmail(args, env);
      case "send_sms": return await execSendSMS(args, env);
      case "get_datetime": return await execGetDateTime(args, env);
      case "local_fs": return await execLocalFsTool(args, env);

      // Image & Voice
      case "generate_image": return await execGenerateImageTool(args, env);
      case "text_to_speech": return await execTextToSpeechTool(args, env);
      case "speech_to_text": return await execSpeechToTextTool(args, env);

      // Market Intelligence
      case "market_data": return await execMarketDataTool(args, env);

      // Goals & Proactive
      case "manage_goals": return await execManageGoalsTool(args, env);
      case "proactive_notify": return await execProactiveNotifyTool(args, env);

      // Language
      case "translate": return await execTranslateTool(args, env);

      // Web Scraping
      case "firecrawl": return await execFirecrawlTool(args, env);

      default: return await execDynamicTool(toolName, args, env);
    }
  } catch (e) {
    // NEVER propagate — always return a plain object
    return { error: `Tool '${toolName}' threw: ${String(e)}`, toolName };
  }
}

// ─── Dynamic Tool Executor (for user-created tools) ───────────────────────────

async function execDynamicTool(
  toolName: string,
  args: ToolArgs,
  env: Env
): Promise<Record<string, unknown>> {
  const { getRedis, listTools } = await import("../memory");
  const redis = getRedis(env);
  const tools = await listTools(redis);
  const dynTool = tools.find((t: RegisteredTool) => t.name === toolName && !t.builtIn);

  if (!dynTool) {
    return { error: `Unknown tool: '${toolName}'. Use create_tool to register new tools.` };
  }

  // Execute the stored real JS function body
  try {
    // We stored real async JS code — run it with AsyncFunction constructor
    // The function body receives (args, env, fetch) as its scope
    const AsyncFunction = (async function () { }).constructor as new (
      ...args: string[]
    ) => (...a: unknown[]) => Promise<unknown>;

    const fn = new AsyncFunction(
      "args",
      "env",
      "fetchFn",
      dynTool.handlerCode
    );

    // Provide a safe fetch wrapper
    const safeFetch = (url: string, opts?: RequestInit) =>
      globalThis.fetch(url, opts);

    const result = await fn(args, env, safeFetch);

    // Ensure result is a plain object
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    if (Array.isArray(result)) return { items: result };
    return { result: String(result) };

  } catch (execErr) {
    console.error(`[DynamicTool] ${toolName} execution error:`, String(execErr));

    // Graceful fallback: ask Gemini to interpret the tool description
    try {
      const { think } = await import("../gemini");
      const fallback = await think(
        env.GEMINI_API_KEY,
        `Tool "${toolName}" failed to execute with real code.
Description: ${dynTool.description}
Args passed: ${JSON.stringify(args)}
Error: ${String(execErr)}

Return a JSON object with what this tool would return based on its description.
Return ONLY valid JSON, no other text.`,
        "You are a precise tool executor. Return only valid JSON."
      );
      try {
        const parsed = JSON.parse(fallback.trim());
        return { ...parsed, _executionMode: "ai_interpreted", _warning: "Real code failed, used AI fallback" };
      } catch {
        return { result: fallback, _executionMode: "ai_interpreted" };
      }
    } catch (aiErr) {
      return { error: `Dynamic tool '${toolName}' failed: ${String(execErr)}` };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH & FETCH IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function execWebSearch(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { query, type = "search", maxResults = 6 } = args as {
    query: string; type?: string; maxResults?: number;
  };

  if (!env.SERPER_API_KEY) {
    return await duckDuckGoFallback(query, Number(maxResults));
  }

  const endpoint = type === "news"
    ? "https://google.serper.dev/news"
    : "https://google.serper.dev/search";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-API-KEY": env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: Math.min(Number(maxResults), 10) }),
  });

  if (!res.ok) {
    console.warn(`[web_search] Serper returned ${res.status}, falling back to DuckDuckGo`);
    return await duckDuckGoFallback(query, Number(maxResults));
  }

  const data = await res.json() as Record<string, unknown>;
  const organic = (data.organic as unknown[] ?? []).slice(0, Number(maxResults));
  const results = organic.map((r) => {
    const item = r as Record<string, unknown>;
    return {
      title: String(item.title ?? ""),
      snippet: String(item.snippet ?? ""),
      url: String(item.link ?? ""),
      date: item.date ? String(item.date) : undefined,
    };
  });

  const kg = data.knowledgeGraph as Record<string, unknown> | undefined;
  const answerBox = data.answerBox as Record<string, unknown> | undefined;

  return {
    query,
    type,
    results,
    count: results.length,
    ...(answerBox && {
      directAnswer: {
        title: String(answerBox.title ?? ""),
        answer: String(answerBox.answer ?? answerBox.snippet ?? ""),
      },
    }),
    ...(kg && {
      knowledgeGraph: {
        title: String(kg.title ?? ""),
        description: String(kg.description ?? ""),
      },
    }),
  };
}

async function duckDuckGoFallback(query: string, limit: number): Promise<Record<string, unknown>> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 VEGA-Agent" } });
    const data = await res.json() as Record<string, unknown>;

    const results: { title: string; snippet: string; url: string }[] = [];

    if (data.AbstractText && String(data.AbstractText).length > 10) {
      results.push({
        title: String(data.Heading ?? query),
        snippet: String(data.AbstractText).slice(0, 500),
        url: String(data.AbstractURL ?? ""),
      });
    }

    for (const t of (data.RelatedTopics as unknown[] ?? [])) {
      if (results.length >= limit) break;
      const topic = t as Record<string, unknown>;
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: String(topic.Text).slice(0, 100),
          snippet: String(topic.Text).slice(0, 300),
          url: String(topic.FirstURL),
        });
      }
    }

    return {
      query,
      results,
      count: results.length,
      source: "duckduckgo_fallback",
      note: results.length === 0 ? "Add SERPER_API_KEY for Google search results." : undefined,
    };
  } catch (e) {
    return { error: `Search failed: ${String(e)}`, query, results: [] };
  }
}

async function execFetchUrl(args: ToolArgs): Promise<Record<string, unknown>> {
  const { url, method = "GET", body } = args as {
    url: string; method?: string; body?: string;
  };

  const res = await fetch(url, {
    method,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/json,*/*;q=0.9",
      "Content-Type": "application/json",
    },
    body: method === "POST" ? body : undefined,
  });

  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const json = await res.json();
    return { url, status: res.status, format: "json", data: json };
  }

  const raw = await res.text();
  const text = stripHtml(raw).slice(0, 6000);
  return {
    url,
    status: res.status,
    format: "text",
    text,
    truncated: raw.length > 6000,
    originalLength: raw.length,
  };
}

async function execBrowseWeb(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { url, action = "content", waitFor, extract } = args as {
    url: string; action?: string; waitFor?: string; extract?: string;
  };

  // Use Browserless.io if token is available
  if (env.BROWSERLESS_TOKEN) {
    try {
      if (action === "screenshot") {
        const res = await fetch(
          `https://chrome.browserless.io/screenshot?token=${env.BROWSERLESS_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url,
              options: { fullPage: true, type: "jpeg", quality: 80 },
            }),
          }
        );
        if (!res.ok) throw new Error(`Browserless screenshot failed: ${res.status}`);
        return { url, action: "screenshot", message: "Screenshot taken. Use fetch_url to get the URL.", status: res.status };
      }

      // Content extraction
      const payload: Record<string, unknown> = {
        url,
        gotoOptions: { waitUntil: "networkidle2", timeout: 25000 },
      };
      if (waitFor) payload.waitFor = { selector: waitFor, timeout: 10000 };

      const res = await fetch(
        `https://chrome.browserless.io/content?token=${env.BROWSERLESS_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) throw new Error(`Browserless returned ${res.status}`);

      const html = await res.text();
      let text = stripHtml(html);

      // Extract specific element if requested
      if (extract) {
        // Simple extraction: find text after the element class/id pattern
        const elementMatch = html.match(
          new RegExp(`class="${extract.replace(".", "").replace("#", "")}"[^>]*>([\\s\\S]{1,5000})`, "i")
        );
        if (elementMatch) {
          text = stripHtml(elementMatch[1]).slice(0, 5000);
        }
      }

      return {
        url,
        action: "content",
        text: text.slice(0, 7000),
        truncated: text.length > 7000,
        length: text.length,
        source: "browserless",
      };
    } catch (e) {
      console.warn(`[browse_web] Browserless failed: ${String(e)}, falling back to fetch`);
    }
  }

  // Fallback: enhanced fetch with JavaScript-friendly headers
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
      },
    });
    const html = await res.text();
    const text = stripHtml(html).slice(0, 7000);
    return {
      url,
      action: "content",
      text,
      truncated: html.length > 7000,
      length: html.length,
      source: "fetch_fallback",
      warning: "BROWSERLESS_TOKEN not set — using basic fetch. JS-rendered content may be incomplete.",
    };
  } catch (e) {
    return { error: `browse_web failed: ${String(e)}`, url };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function getRedisClient(env: Env) {
  const { Redis } = await import("@upstash/redis/cloudflare");
  return Redis.fromEnv(env);
}

async function execStoreMemory(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { key, value, ttlSeconds } = args as { key: string; value: string; ttlSeconds?: number };
  const redis = await getRedisClient(env);
  const opts = ttlSeconds ? { ex: Math.floor(Number(ttlSeconds)) } : {};
  await redis.set(`agent:memory:${key}`, value, opts);
  return { success: true, key, stored: value.slice(0, 100), ttl: ttlSeconds ?? "permanent" };
}

async function execRecallMemory(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { key } = args as { key: string };
  const redis = await getRedisClient(env);
  const value = await redis.get(`agent:memory:${key}`);
  return value != null
    ? { found: true, key, value: String(value) }
    : { found: false, key, message: `No memory found for key '${key}'` };
}

async function execListMemories(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { prefix = "" } = args as { prefix?: string };
  const redis = await getRedisClient(env);
  const keys = await redis.keys(`agent:memory:${prefix}*`) as string[];
  const clean = keys.map((k: string) => k.replace("agent:memory:", ""));
  return { keys: clean, count: clean.length };
}

async function execDeleteMemory(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { key } = args as { key: string };
  const redis = await getRedisClient(env);
  await redis.del(`agent:memory:${key}`);
  return { success: true, deleted: key };
}

async function execSemanticStore(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { text, metadata = {} } = args as { text: string; metadata?: Record<string, unknown> };
  const { upsertMemory } = await import("./vector-memory");
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await upsertMemory(env, id, text, metadata as Record<string, string>);
  return { success: true, id, preview: text.slice(0, 100), message: "Stored semantically." };
}

async function execSemanticRecall(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { query, topK = 5 } = args as { query: string; topK?: number };
  const { queryMemory } = await import("./vector-memory");
  const results = await queryMemory(env, query, Number(topK));
  return { results, count: results.length, query };
}

async function execShareMemory(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { namespace, key, value } = args as { namespace: string; key: string; value: string };
  const redis = await getRedisClient(env);
  await redis.set(`agent:shared:${namespace}:${key}`, value);
  return { success: true, namespace, key, message: `Shared to namespace '${namespace}'` };
}

async function execReadAgentMemory(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { agentId, key } = args as { agentId: string; key?: string };
  const redis = await getRedisClient(env);

  if (key) {
    // Read specific key from agent's namespace or shared namespace
    const direct = await redis.get(`agent:shared:${agentId}:${key}`);
    if (direct) return { found: true, agentId, key, value: String(direct) };

    const agentKey = await redis.get(`agent:memory:${agentId}:${key}`);
    if (agentKey) return { found: true, agentId, key, value: String(agentKey) };

    return { found: false, agentId, key };
  }

  // List all keys in this agent's namespace
  const sharedKeys = await redis.keys(`agent:shared:${agentId}:*`) as string[];
  const agentKeys = await redis.keys(`agent:memory:${agentId}:*`) as string[];

  const allKeys = [
    ...sharedKeys.map((k: string) => k.replace(`agent:shared:${agentId}:`, "shared:")),
    ...agentKeys.map((k: string) => k.replace(`agent:memory:${agentId}:`, "memory:")),
  ];

  return { agentId, keys: allKeys, count: allKeys.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE IMPLEMENTATIONS (Cloudflare R2)
// ═══════════════════════════════════════════════════════════════════════════════

async function execWriteFile(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { path, content, contentType = "text/plain" } = args as {
    path: string; content: string; contentType?: string;
  };

  if (!env.FILES_BUCKET) {
    return { error: "FILES_BUCKET R2 binding not configured. Add it to wrangler.toml." };
  }

  await env.FILES_BUCKET.put(path, content, {
    httpMetadata: { contentType: String(contentType) },
    customMetadata: {
      createdAt: new Date().toISOString(),
      size: String(content.length),
    },
  });

  return {
    success: true,
    path,
    size: content.length,
    contentType,
    message: `File '${path}' saved (${content.length} chars).`,
  };
}

async function execReadFile(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { path } = args as { path: string };

  if (!env.FILES_BUCKET) {
    return { error: "FILES_BUCKET R2 binding not configured." };
  }

  const obj = await env.FILES_BUCKET.get(path);
  if (!obj) {
    return { found: false, path, message: `File '${path}' not found.` };
  }

  const content = await obj.text();
  return {
    found: true,
    path,
    content,
    size: content.length,
    contentType: obj.httpMetadata?.contentType ?? "unknown",
    metadata: obj.customMetadata,
  };
}

async function execListFiles(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { prefix = "" } = args as { prefix?: string };

  if (!env.FILES_BUCKET) {
    return { error: "FILES_BUCKET R2 binding not configured." };
  }

  const list = await env.FILES_BUCKET.list({ prefix: String(prefix) });
  const files = list.objects.map((o: any) => ({
    key: o.key,
    size: o.size,
    modified: o.uploaded.toISOString(),
    etag: o.etag,
  }));

  return { files, count: files.length, prefix };
}

async function execDeleteFile(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { path } = args as { path: string };

  if (!env.FILES_BUCKET) {
    return { error: "FILES_BUCKET R2 binding not configured." };
  }

  await env.FILES_BUCKET.delete(path);
  return { success: true, deleted: path };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE & COMPUTE IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function execRunCode(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { code, packages } = args as { code: string; packages?: string };

  if (!env.E2B_API_KEY) {
    return { error: "E2B_API_KEY not configured. Add it to wrangler secrets." };
  }

  try {
    const { Sandbox } = await import("@e2b/code-interpreter");
    const sandbox = await Sandbox.create({ apiKey: env.E2B_API_KEY });

    try {
      if (packages) {
        const pkgList = packages.split(",").map((p: string) => p.trim()).join(" ");
        await sandbox.runCode(`import subprocess; subprocess.run(["pip", "install", ${pkgList.split(" ").map((p: string) => JSON.stringify(p)).join(", ")}, "-q"], check=True)`);
      }

      const exec = await sandbox.runCode(code);
      return {
        stdout: exec.logs.stdout.join("\n"),
        stderr: exec.logs.stderr.join("\n"),
        error: exec.error?.value ?? null,
        hasOutput: exec.results.length > 0,
        success: !exec.error,
      };
    } finally {
      await sandbox.kill();
    }
  } catch (e) {
    return { error: `Code execution failed: ${String(e)}`, success: false };
  }
}

function execCalculate(args: ToolArgs): Record<string, unknown> {
  const { expression } = args as { expression: string };

  const sanitized = expression
    .replace(/Math\.\w+/g, "")
    .replace(/\*\*/g, "")
    .replace(/[^\d\s\+\-\*\/\.\%\(\)\,]/g, "");

  if (
    /[a-zA-Z_$]/.test(sanitized) ||
    expression.includes("require") ||
    expression.includes("import") ||
    expression.includes("process") ||
    expression.includes("global")
  ) {
    return { error: "Unsafe expression rejected" };
  }

  try {
    const safe = expression.replace(
      /(\d+(?:\.\d+)?)\s*\*\*\s*(\d+(?:\.\d+)?)/g,
      (_, a, b) => `Math.pow(${a},${b})`
    );
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${safe})`)();
    return { expression, result, type: typeof result };
  } catch (e) {
    return { error: `Calculation failed: ${String(e)}`, expression };
  }
}

async function execGetDateTime(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { timezone = "UTC" } = args as { timezone?: string };
  try {
    const now = new Date();
    const options: Intl.DateTimeFormatOptions = {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    };
    const formatter = new Intl.DateTimeFormat("en-US", options);
    return {
      utc: now.toISOString(),
      local: formatter.format(now),
      timezone,
    };
  } catch (e) {
    return { error: `Invalid timezone: ${timezone}`, utc: new Date().toISOString() };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT INFRASTRUCTURE IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function execTriggerWorkflow(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { taskType, instructions, steps, sessionId } = args as {
    taskType: string; instructions: string; steps?: string; sessionId?: string;
  };

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const qstash = new QStashClient({
    token: env.QSTASH_TOKEN,
    baseUrl: env.QSTASH_URL,
  });

  const workflowBase = (env.UPSTASH_WORKFLOW_URL ?? "").trim().replace(/\/$/, "");
  await qstash.publishJSON({
    url: `${workflowBase}/workflow`,
    body: {
      taskId,
      sessionId: sessionId ?? "agent-self",
      taskType,
      instructions,
      steps: steps ? JSON.parse(steps) : [],
      agentConfig: null,
    },
  });

  return {
    success: true,
    taskId,
    taskType,
    message: `Workflow '${taskType}' started. Poll with get_task_status('${taskId}').`,
    statusEndpoint: `/task/${taskId}`,
  };
}

async function execGetTaskStatus(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { taskId } = args as { taskId: string };
  const { getRedis, getTask } = await import("../memory");
  const redis = getRedis(env);
  const task = await getTask(redis, taskId);

  if (!task) return { found: false, taskId, message: "Task not found. It may still be initializing." };

  return {
    found: true,
    taskId,
    status: task.status,
    type: task.type,
    ...(task.result as Record<string, unknown>),
    startedAt: task.createdAt,
  };
}

async function execSpawnAgent(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { agentName, instructions, allowedTools, memoryPrefix, notifyEmail, priority = "normal" } = args as {
    agentName: string;
    instructions: string;
    allowedTools?: string;
    memoryPrefix?: string;
    notifyEmail?: string;
    priority?: string;
  };

  const agentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const qstash = new QStashClient({
    token: env.QSTASH_TOKEN,
    baseUrl: env.QSTASH_URL,
  });

  const payload = {
    taskId: agentId,
    sessionId: `agent-${agentId}`,
    taskType: "sub_agent",
    instructions,
    steps: [],
    agentConfig: {
      name: agentName,
      allowedTools: allowedTools ? allowedTools.split(",").map((t: string) => t.trim()) : null,
      memoryPrefix: memoryPrefix ?? agentId,
      notifyEmail: notifyEmail ?? null,
      spawnedAt: new Date().toISOString(),
      parentAgent: "vega-core",
    },
  };

  const workflowBase = (env.UPSTASH_WORKFLOW_URL ?? "").trim().replace(/\/$/, "");
  const publishOptions: Record<string, unknown> = {
    url: `${workflowBase}/workflow`,
    body: payload,
  };

  // High priority agents get faster scheduling via QStash delay=0
  if (priority === "high") {
    publishOptions.delay = 0;
  }

  await qstash.publishJSON(publishOptions as Parameters<typeof qstash.publishJSON>[0]);

  // Track all spawned agents in Redis for list_agents
  const redis = await getRedisClient(env);
  console.log(`[execSpawnAgent] Redis URL: ${env.UPSTASH_REDIS_REST_URL?.slice(0, 25)}...`);
  console.log(`[execSpawnAgent] Saving agent ${agentId} to agent:spawned`);

  await redis.lpush("agent:spawned", JSON.stringify({
    agentId,
    agentName,
    spawnedAt: new Date().toISOString(),
    status: "initializing",
  }));
  await redis.ltrim("agent:spawned", 0, 199); // keep last 200

  return {
    success: true,
    agentId,
    agentName,
    priority,
    message: `Sub-agent '${agentName}' spawned. It has access to all tools and will run autonomously.`,
    instructions: `Use get_agent_result('${agentId}') to check progress and retrieve results.`,
    memoryPrefix: memoryPrefix ?? agentId,
  };
}

async function execGetAgentResult(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { agentId } = args as { agentId: string };
  const { getRedis, getTask } = await import("../memory");
  const redis = getRedis(env);
  const task = await getTask(redis, agentId);

  if (!task) {
    return {
      found: false,
      agentId,
      status: "initializing",
      message: "Agent is initializing. Check again in a few seconds.",
    };
  }

  const result = task.result as Record<string, unknown> ?? {};

  if (task.status === "running") {
    const completed = Number(result.completedSteps ?? 0);
    const total = Number(result.totalSteps ?? 1);
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      found: true,
      agentId,
      status: "running",
      progress: `${pct}% (${completed}/${total} steps)`,
      latest: result.latestResult ? String(result.latestResult).slice(0, 300) : "Working...",
    };
  }

  return {
    found: true,
    agentId,
    status: task.status,
    summary: result.summary,
    agent: result.agent,
    steps: result.steps,
    completedAt: result.completedAt,
  };
}

async function execListAgents(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { status = "all" } = args as { sessionId?: string; status?: string };
  const redis = await getRedisClient(env);

  const raw = await redis.lrange("agent:spawned", 0, 99) as string[];
  const agents = raw.map((r: string) => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  const filtered = status === "all"
    ? agents
    : agents.filter((a: Record<string, unknown>) => a.status === status);

  return { agents: filtered, count: filtered.length, total: agents.length };
}

async function execCancelAgent(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { agentId, reason = "Cancelled by parent agent" } = args as {
    agentId: string; reason?: string;
  };

  const { getRedis, updateTask } = await import("../memory");
  const redis = getRedis(env);

  await updateTask(redis, agentId, {
    status: "cancelled",
    result: { cancelReason: reason, cancelledAt: new Date().toISOString() },
  });

  return {
    success: true,
    agentId,
    status: "cancelled",
    reason,
    message: `Agent ${agentId} marked as cancelled. Running steps will complete but no new steps will start.`,
  };
}

async function execCreateTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { name, description, requirements = "", parameters: parametersStr } = args as {
    name: string;
    description: string;
    requirements?: string;
    parameters?: string;
  };

  // Validate name
  if (!/^[a-z][a-z0-9_]*$/.test(String(name))) {
    return { success: false, error: "Tool name must be snake_case (lowercase letters, numbers, underscores)" };
  }

  const { think } = await import("../gemini");

  // Step 1: Generate real JavaScript function body
  const implementation = await think(
    env.GEMINI_API_KEY,
    `You are writing a JavaScript async function body for a tool called "${name}".

Tool description: ${description}
Detailed requirements: ${requirements}

The function will be invoked exactly like this:
  const result = await fn(args, env, fetchFn);

Where:
  - args: plain JS object with the tool's parameters
  - env: Cloudflare Worker env (has env.GEMINI_API_KEY, env.SERPER_API_KEY, etc.)
  - fetchFn: async (url, options?) => Response — use this instead of fetch()

Strict rules:
  1. Write ONLY the function BODY — no "async function name() {" wrapper
  2. ALWAYS return a plain object (never throw — catch all errors)
  3. Use fetchFn() for all HTTP requests
  4. No imports allowed (use dynamic import ONLY if absolutely necessary)
  5. Handle missing API keys gracefully
  6. Return descriptive error objects when things fail: { error: "..." }

Example for a "get_weather" tool:
  const res = await fetchFn(\`https://wttr.in/\${args.city}?format=j1\`);
  if (!res.ok) return { error: \`Weather API returned \${res.status}\` };
  const data = await res.json();
  return { city: args.city, temp: data.current_condition[0].temp_C, desc: data.current_condition[0].weatherDesc[0].value };

Now write the function body for "${name}" (${requirements}):`,
    "You are a senior JavaScript developer. Write precise, safe, error-handled code. Return ONLY the function body, nothing else."
  );

  // Step 2: Basic validation
  const code = implementation.trim();
  if (!code.includes("return ")) {
    return {
      success: false,
      error: "Generated code is missing a return statement. Try again with more specific requirements.",
      generated: code.slice(0, 200),
    };
  }

  // Step 3: Parse parameters schema
  let parsedParams: Record<string, unknown> = {};
  if (parametersStr) {
    try {
      parsedParams = JSON.parse(String(parametersStr));
    } catch {
      // Non-fatal: continue with empty params
    }
  }

  // Step 4: Store the tool with real code
  try {
    const { Redis } = await import("@upstash/redis/cloudflare");
    const { registerTool } = await import("../memory");
    const redis = Redis.fromEnv(env);

    const tool: RegisteredTool = {
      name: String(name),
      description: String(description),
      parameters: parsedParams,
      handlerCode: code,
      builtIn: false,
    };

    await registerTool(redis, tool);

    return {
      success: true,
      name,
      message: `✅ Tool '${name}' created with working JavaScript implementation. You can now call it immediately.`,
      preview: code.slice(0, 400) + (code.length > 400 ? "\n..." : ""),
      codeSize: code.length,
    };
  } catch (e) {
    return { success: false, error: `Failed to register tool: ${String(e)}` };
  }
}

async function execBenchmarkTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { toolName, testInputs } = args as { toolName: string; testInputs?: string };

  let parsedInputs: Record<string, unknown> = {};
  if (testInputs) {
    try { parsedInputs = JSON.parse(testInputs); } catch { /* use empty */ }
  }

  const start = Date.now();
  try {
    const result = await executeTool(toolName, parsedInputs, env);
    const duration = Date.now() - start;
    const success = !result.error;

    // Store benchmark result
    const redis = await getRedisClient(env);
    const benchKey = `agent:benchmark:${toolName}`;
    const existing = await redis.get(benchKey) as string | null;
    const history = existing ? JSON.parse(existing) : [];
    history.push({ ts: Date.now(), duration, success, inputKeys: Object.keys(parsedInputs) });
    if (history.length > 20) history.shift();
    await redis.set(benchKey, JSON.stringify(history), { ex: 86400 * 7 });

    const avgDuration = history.reduce((s: number, h: { duration: number }) => s + h.duration, 0) / history.length;

    return {
      toolName,
      success,
      duration,
      avgDuration: Math.round(avgDuration),
      result: success ? result : undefined,
      error: !success ? result.error : undefined,
      benchmarkRuns: history.length,
    };
  } catch (e) {
    return { toolName, success: false, error: String(e), duration: Date.now() - start };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULING IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function execScheduleCron(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { url, cron, body, description } = args as {
    url: string; cron: string; body?: string; description: string;
  };

  const qstash = new QStashClient({
    token: env.QSTASH_TOKEN,
    baseUrl: env.QSTASH_URL,
  });
  const result = await qstash.schedules.create({
    destination: url,
    cron,
    body: body ?? "{}",
    headers: { "Content-Type": "application/json" },
  });

  // Persist schedule metadata so the agent and UI can list/manage crons
  try {
    const { getRedis, saveSchedule } = await import("../memory");
    const redis = getRedis(env);
    await saveSchedule(redis, result.scheduleId, {
      scheduleId: result.scheduleId,
      cron,
      description,
      url,
      body: body ?? "{}",
    });
  } catch (e) {
    console.warn("[schedule_cron] Failed to save schedule metadata:", String(e));
  }

  return {
    success: true,
    scheduleId: result.scheduleId,
    cron,
    description,
    url,
    message: `Cron job created: "${description}" (${cron})`,
  };
}

function execGetDatetime(args: ToolArgs): Record<string, unknown> {
  const { timezone } = args as { timezone?: string };
  const now = new Date();

  try {
    const localStr = timezone
      ? now.toLocaleString("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "long" })
      : null;

    return {
      utc: now.toISOString(),
      timestamp: now.getTime(),
      date: now.toISOString().split("T")[0],
      time: now.toISOString().split("T")[1].split(".")[0],
      dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
      ...(localStr && { local: localStr, timezone }),
    };
  } catch {
    return { utc: now.toISOString(), timestamp: now.getTime() };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRON REGISTRY TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

async function execListCrons(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { getRedis, listSchedules } = await import("../memory");
  const redis = getRedis(env);
  const schedules = await listSchedules(redis);
  return { schedules, count: schedules.length };
}

async function execDeleteCron(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { scheduleId } = args as { scheduleId: string };
  if (!scheduleId) return { success: false, error: "scheduleId is required" };

  try {
    const base = env.QSTASH_URL.replace(/\/$/, "");
    await fetch(`${base}/v2/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${env.QSTASH_TOKEN}`,
      },
    });
  } catch (e) {
    console.warn("[delete_cron] Failed to delete from QStash:", String(e));
  }

  try {
    const { getRedis } = await import("../memory");
    const redis = getRedis(env);
    await redis.del(`agent:schedule:${scheduleId}`);
  } catch (e) {
    console.warn("[delete_cron] Failed to delete schedule metadata:", String(e));
  }

  return { success: true, scheduleId };
}

async function execUpdateCron(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { scheduleId, cron, body, description } = args as {
    scheduleId: string;
    cron?: string;
    body?: string;
    description?: string;
  };

  if (!scheduleId) return { success: false, error: "scheduleId is required" };

  const { getRedis } = await import("../memory");
  const redis = getRedis(env);
  const existing = await redis.get<{
    scheduleId: string;
    cron: string;
    description: string;
    url?: string;
    body?: string;
  }>(`agent:schedule:${scheduleId}`);

  if (!existing) {
    return { success: false, error: `No schedule metadata found for ${scheduleId}` };
  }

  const newCron = cron ?? existing.cron;
  const newBody = body ?? existing.body ?? "{}";
  const newDescription = description ?? existing.description;

  // Delete old schedule in QStash
  const qstashBase = env.QSTASH_URL.replace(/\/$/, "");
  try {
    await fetch(`${qstashBase}/v2/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${env.QSTASH_TOKEN}`,
      },
    });
  } catch (e) {
    console.warn("[update_cron] Failed to delete old schedule from QStash:", String(e));
  }

  // Recreate with updated config
  const qstash = new QStashClient({
    token: env.QSTASH_TOKEN,
    baseUrl: env.QSTASH_URL,
  });
  const created = await qstash.schedules.create({
    destination: existing.url ?? "",
    cron: newCron,
    body: newBody,
    headers: { "Content-Type": "application/json" },
  });

  // Save new metadata and remove old record if scheduleId changed
  try {
    const { saveSchedule } = await import("../memory");
    await saveSchedule(redis, created.scheduleId, {
      scheduleId: created.scheduleId,
      cron: newCron,
      description: newDescription,
      url: existing.url,
      body: newBody,
    });
    if (created.scheduleId !== scheduleId) {
      await redis.del(`agent:schedule:${scheduleId}`);
    }
  } catch (e) {
    console.warn("[update_cron] Failed to save updated schedule metadata:", String(e));
  }

  return {
    success: true,
    oldScheduleId: scheduleId,
    scheduleId: created.scheduleId,
    cron: newCron,
    description: newDescription,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUMAN APPROVAL GATE
// ═══════════════════════════════════════════════════════════════════════════════

async function execHumanApprovalGate(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { operation, channel = "ui", metadata } = args as {
    operation: string;
    channel?: "ui" | "telegram" | "email" | "all";
    metadata?: Record<string, unknown>;
  };

  const { getRedis } = await import("../memory");
  const redis = getRedis(env);

  const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const record = {
    id: requestId,
    operation,
    channel,
    metadata: metadata ?? {},
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };

  // Persist request
  await redis.set(`agent:approval:${requestId}`, JSON.stringify(record), {
    ex: 60 * 60 * 24,
  });
  await redis.lpush("agent:approvals", JSON.stringify(record));
  await redis.ltrim("agent:approvals", 0, 99);

  // Optional: notify via Telegram if configured
  if ((channel === "telegram" || channel === "all") && env.TELEGRAM_BOT_TOKEN) {
    try {
      const { getTelegramConfig, TelegramBot } = await import("../telegram");
      const config = await getTelegramConfig(env);
      if (config) {
        const bot = new TelegramBot(config.token);
        const text = `⚠️ Approval requested\n\nOperation:\n${operation}\n\nRequest ID: ${requestId}\n\nUse the dashboard or inline buttons to approve or reject.`;
        await bot.sendMessage(config.botId, text, {
          parse_mode: "HTML",
        });
      }
    } catch (e) {
      console.warn("[human_approval_gate] Telegram notification failed:", String(e));
    }
  }

  // Email notification could be added here using send_email, but we avoid
  // calling tools recursively from within tools to keep execution simple.

  return {
    ...record,
    message: "Approval requested. Status is pending. Call this tool again later or poll the approvals API to see the final decision.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE INGESTION
// ═══════════════════════════════════════════════════════════════════════════════

async function execIngestKnowledgeBase(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { urls = [], texts = [], topic } = args as {
    urls?: string[];
    texts?: string[];
    topic?: string;
  };

  const normalizedUrls = Array.isArray(urls) ? urls : [];
  const normalizedTexts = Array.isArray(texts) ? texts : [];

  const sources: { type: "url" | "text"; id: string; content: string }[] = [];

  // Fetch URLs
  for (const url of normalizedUrls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "VEGA-Agent/1.0",
          "Accept": "text/html,application/json,*/*;q=0.9",
        },
      });
      const contentType = res.headers.get("content-type") ?? "";
      let text: string;
      if (contentType.includes("application/json")) {
        const json = await res.json();
        text = JSON.stringify(json).slice(0, 8000);
      } else {
        const raw = await res.text();
        text = stripHtml(raw).slice(0, 8000);
      }
      if (text.trim().length > 0) {
        sources.push({ type: "url", id: url, content: text });
      }
    } catch (e) {
      console.warn("[ingest_knowledge_base] Failed to fetch URL:", url, String(e));
    }
  }

  // Raw texts
  normalizedTexts.forEach((t, idx) => {
    if (t && String(t).trim().length > 0) {
      sources.push({ type: "text", id: `text-${idx}`, content: String(t) });
    }
  });

  if (sources.length === 0) {
    return { success: false, error: "No content to ingest. Provide urls and/or texts." };
  }

  const { upsertMemory } = await import("./vector-memory");
  let chunkCount = 0;

  for (const source of sources) {
    const chunks = chunkText(source.content, 800);
    for (let i = 0; i < chunks.length; i++) {
      const id = `kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${chunkCount}`;
      const metadata: Record<string, unknown> = {
        sourceType: source.type,
        sourceId: source.id,
        index: i,
      };
      if (topic) metadata.topic = topic;
      await upsertMemory(env, id, chunks[i], metadata);
      chunkCount += 1;
    }
  }

  return {
    success: true,
    sources: sources.length,
    chunks: chunkCount,
    topic: topic ?? null,
  };
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const sentences = text.split(/(?<=[\.!\?])\s+/);
  for (const s of sentences) {
    if ((current + " " + s).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function execGithub(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  if (!env.GITHUB_TOKEN) {
    return { error: "GITHUB_TOKEN not configured." };
  }

  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
  const { action, owner, repo, path, query, title, body, branch = "main" } = args as {
    action: string; owner?: string; repo?: string; path?: string;
    query?: string; title?: string; body?: string; branch?: string;
  };

  try {
    switch (action) {
      case "list_repos": {
        const { data } = await octokit.repos.listForAuthenticatedUser({ per_page: 30 });
        return {
          repos: data.map((r) => ({
            name: r.name,
            full_name: r.full_name,
            description: r.description,
            language: r.language,
            stars: r.stargazers_count,
            updated: r.updated_at,
            private: r.private,
          })),
          count: data.length,
        };
      }

      case "get_repo_info": {
        if (!owner || !repo) return { error: "owner and repo required" };
        const { data } = await octokit.repos.get({ owner, repo });
        return {
          name: data.name,
          description: data.description,
          language: data.language,
          stars: data.stargazers_count,
          forks: data.forks_count,
          topics: data.topics,
          defaultBranch: data.default_branch,
          updatedAt: data.updated_at,
        };
      }

      case "get_file": {
        if (!owner || !repo || !path) return { error: "owner, repo, and path required" };
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        if ("content" in data) {
          const content = atob((data.content as string).replace(/\n/g, ""));
          return { content, path, size: data.size, sha: data.sha };
        }
        return { error: "Path is a directory, not a file" };
      }

      case "search_code": {
        if (!query) return { error: "query required" };
        const { data } = await octokit.search.code({ q: query, per_page: 10 });
        return {
          results: data.items.map((i) => ({
            name: i.name,
            path: i.path,
            repo: i.repository.full_name,
            url: i.html_url,
            score: i.score,
          })),
          total: data.total_count,
        };
      }

      case "create_issue": {
        if (!owner || !repo || !title) return { error: "owner, repo, and title required" };
        const { data } = await octokit.issues.create({ owner, repo, title, body });
        return { success: true, number: data.number, url: data.html_url, title: data.title };
      }

      case "list_issues": {
        if (!owner || !repo) return { error: "owner and repo required" };
        const { data } = await octokit.issues.listForRepo({ owner, repo, per_page: 20 });
        return {
          issues: data.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
            url: i.html_url,
          })),
          count: data.length,
        };
      }

      case "list_commits": {
        if (!owner || !repo) return { error: "owner and repo required" };
        const { data } = await octokit.repos.listCommits({ owner, repo, sha: branch, per_page: 10 });
        return {
          commits: data.map((c) => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split("\n")[0],
            author: c.commit.author?.name,
            date: c.commit.author?.date,
          })),
          count: data.length,
        };
      }

      default:
        return { error: `Unknown GitHub action: ${action}` };
    }
  } catch (e) {
    return { error: `GitHub action '${action}' failed: ${String(e)}` };
  }
}

async function execSendEmail(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  if (!env.RESEND_API_KEY) {
    return { error: "RESEND_API_KEY not configured." };
  }

  const { Resend } = await import("resend");
  const client = new Resend(env.RESEND_API_KEY);
  const { to, subject, body } = args as { to: string; subject: string; body: string };

  try {
    const { data, error } = await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to,
      subject,
      html: `<div style="font-family:monospace;max-width:700px;margin:0 auto;padding:20px">
        ${body.replace(/\n/g, "<br>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}
        <hr style="margin-top:30px;border-color:#333">
        <small style="color:#666">Sent by VEGA Autonomous Agent</small>
      </div>`,
    });

    return error
      ? { success: false, error: String(error) }
      : { success: true, id: data?.id, to, subject };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW TOOL LAZY EXECUTOR WRAPPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function execGenerateImageTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execGenerateImage } = await import("./generate-image");
  return execGenerateImage(args, env);
}

async function execTextToSpeechTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execTextToSpeech } = await import("./voice");
  return execTextToSpeech(args, env);
}

async function execSpeechToTextTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execSpeechToText } = await import("./voice");
  return execSpeechToText(args, env);
}

async function execMarketDataTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execMarketData } = await import("./market");
  return execMarketData(args, env);
}

async function execManageGoalsTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execManageGoals } = await import("./goals");
  return execManageGoals(args, env);
}

async function execProactiveNotifyTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execProactiveNotify } = await import("./goals");
  return execProactiveNotify(args, env);
}

async function execTranslateTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execTranslate } = await import("./translate");
  return execTranslate(args, env);
}

async function execFirecrawlTool(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { execFirecrawl } = await import("./firecrawl");
  return execFirecrawl(args, env);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function execSendSMS(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return { error: "Twilio credentials not configured." };
  }

  const { to, message } = args as { to: string; message: string };
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: to,
          From: env.TWILIO_FROM_NUMBER,
          Body: message,
        }).toString(),
      }
    );

    const data = await res.json() as Record<string, unknown>;
    return res.ok
      ? { success: true, sid: data.sid, to, length: message.length }
      : { success: false, error: String(data.message ?? "Unknown error") };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}