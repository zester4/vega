/**
 * cli.ts — Terminal chat client for the autonomous agent
 *
 * Usage:
 *   npm run chat
 *   npm run chat -- --session my-session
 *   npm run chat -- --url http://127.0.0.1:8787
 */
import * as readline from "readline";
import * as crypto   from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const WORKER_URL = getArg("--url",     "http://127.0.0.1:8787");
const SESSION_ID = getArg("--session", `cli-${crypto.randomBytes(4).toString("hex")}`);

// ─── Terminal colors ──────────────────────────────────────────────────────────
const C = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  italic:    "\x1b[3m",
  underline: "\x1b[4m",
  cyan:      "\x1b[36m",
  green:     "\x1b[32m",
  yellow:    "\x1b[33m",
  red:       "\x1b[31m",
  blue:      "\x1b[34m",
  magenta:   "\x1b[35m",
  white:     "\x1b[97m",
  gray:      "\x1b[90m",
  bgBlue:    "\x1b[44m",
  bgGray:    "\x1b[100m",
};

const termWidth = process.stdout.columns || 100;
const INDENT    = "    ";

// ─── Markdown → terminal renderer ────────────────────────────────────────────
function renderMarkdown(md: string): string {
  const lines   = md.split("\n");
  const out: string[] = [];
  let inCode    = false;
  let codeLines: string[] = [];
  let codeLang  = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Code block ──────────────────────────────────────────────────────────
    if (line.startsWith("```")) {
      if (!inCode) {
        inCode   = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
      } else {
        // Render collected code block
        const langLabel = codeLang
          ? `${C.bgGray}${C.white} ${codeLang} ${C.reset}\n`
          : "";
        const border = `${C.gray}${"─".repeat(Math.min(termWidth - 8, 60))}${C.reset}`;
        out.push(`\n${INDENT}${langLabel}${INDENT}${border}`);
        for (const cl of codeLines) {
          out.push(`${INDENT}${C.green}${cl}${C.reset}`);
        }
        out.push(`${INDENT}${border}\n`);
        inCode   = false;
        codeLines = [];
        codeLang  = "";
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    // ── Headings ────────────────────────────────────────────────────────────
    if (line.startsWith("### ")) {
      out.push(`\n${INDENT}${C.cyan}${C.bold}${line.slice(4)}${C.reset}`);
      out.push(`${INDENT}${C.cyan}${"─".repeat(line.slice(4).length)}${C.reset}`);
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(`\n${INDENT}${C.cyan}${C.bold}${line.slice(3).toUpperCase()}${C.reset}`);
      out.push(`${INDENT}${C.cyan}${"═".repeat(line.slice(3).length)}${C.reset}`);
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(`\n${INDENT}${C.white}${C.bold}${line.slice(2).toUpperCase()}${C.reset}`);
      out.push(`${INDENT}${C.white}${"═".repeat(line.slice(2).length)}${C.reset}`);
      continue;
    }

    // ── Horizontal rule ──────────────────────────────────────────────────────
    if (/^[-*_]{3,}$/.test(line.trim())) {
      out.push(`\n${INDENT}${C.gray}${"─".repeat(Math.min(termWidth - 8, 60))}${C.reset}\n`);
      continue;
    }

    // ── Bullet list ──────────────────────────────────────────────────────────
    if (/^(\s*)[*\-+] /.test(line)) {
      const depth  = line.match(/^(\s*)/)?.[1].length ?? 0;
      const bullet = depth > 0 ? "◦" : "•";
      const text   = line.replace(/^(\s*)[*\-+] /, "");
      const pad    = "  ".repeat(Math.floor(depth / 2));
      out.push(`${INDENT}${pad}${C.cyan}${bullet}${C.reset} ${inlineFormat(text)}`);
      continue;
    }

    // ── Numbered list ────────────────────────────────────────────────────────
    if (/^\d+\. /.test(line)) {
      const num  = line.match(/^(\d+)\./)?.[1] ?? "";
      const text = line.replace(/^\d+\. /, "");
      out.push(`${INDENT}${C.cyan}${num}.${C.reset} ${inlineFormat(text)}`);
      continue;
    }

    // ── Blockquote ───────────────────────────────────────────────────────────
    if (line.startsWith("> ")) {
      out.push(`${INDENT}${C.gray}│${C.reset} ${C.italic}${inlineFormat(line.slice(2))}${C.reset}`);
      continue;
    }

    // ── Empty line ───────────────────────────────────────────────────────────
    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // ── Table (basic) ────────────────────────────────────────────────────────
    if (line.includes("|") && line.trim().startsWith("|")) {
      if (/^\|[-|:\s]+\|$/.test(line.trim())) continue; // skip separator row
      const cells = line.split("|").filter(Boolean).map((c) => inlineFormat(c.trim()));
      out.push(`${INDENT}${cells.join(`  ${C.gray}│${C.reset}  `)}`);
      continue;
    }

    // ── Normal paragraph ─────────────────────────────────────────────────────
    const formatted = inlineFormat(line);
    const wrapped   = wordWrap(formatted, termWidth - INDENT.length - 4);
    for (const wl of wrapped.split("\n")) {
      out.push(`${INDENT}${wl}`);
    }
  }

  return out.join("\n");
}

// Inline formatting: **bold**, *italic*, `code`, ~~strike~~
function inlineFormat(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g,  `${C.bold}${C.italic}$1${C.reset}`)
    .replace(/\*\*(.+?)\*\*/g,      `${C.bold}$1${C.reset}`)
    .replace(/\*(.+?)\*/g,          `${C.italic}$1${C.reset}`)
    .replace(/_(.+?)_/g,            `${C.italic}$1${C.reset}`)
    .replace(/~~(.+?)~~/g,          `${C.dim}$1${C.reset}`)
    .replace(/`([^`]+)`/g,          `${C.green}$1${C.reset}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.underline}${C.blue}$1${C.reset} ${C.gray}($2)${C.reset}`);
}

// Word wrap preserving ANSI codes
function wordWrap(text: string, width: number): string {
  // Strip ANSI for length measurement
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  if (strip(text).length <= width) return text;

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const testLen = strip(current ? current + " " + word : word).length;
    if (current && testLen > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines.join(`\n${INDENT}`);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function banner() {
  const w = Math.min(termWidth - 4, 52);
  console.log();
  console.log(`  ${C.cyan}${C.bold}╔${"═".repeat(w)}╗${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}║${" ".repeat(Math.floor((w-22)/2))}Autonomous AI Agent CLI${" ".repeat(Math.ceil((w-22)/2))}║${C.reset}`);
  console.log(`  ${C.cyan}${C.bold}╚${"═".repeat(w)}╝${C.reset}`);
  console.log(`  ${C.gray}Worker  : ${C.white}${WORKER_URL}${C.reset}`);
  console.log(`  ${C.gray}Session : ${C.white}${SESSION_ID}${C.reset}`);
  console.log(`  ${C.gray}Commands: ${C.white}/exit  /session [id]  /clear  /help${C.reset}`);
  console.log(`  ${C.gray}Tips    : ${C.dim}ask anything, use tools, search the web${C.reset}`);
  console.log();
}

function helpText() {
  console.log(`
${INDENT}${C.cyan}${C.bold}Commands${C.reset}
${INDENT}${C.green}/exit${C.reset}              Quit the CLI
${INDENT}${C.green}/session${C.reset}           Show current session ID  
${INDENT}${C.green}/session <id>${C.reset}      Switch to a different session (loads its memory)
${INDENT}${C.green}/clear${C.reset}             Clear the screen
${INDENT}${C.green}/help${C.reset}              Show this help

${INDENT}${C.cyan}${C.bold}Example prompts${C.reset}
${INDENT}${C.dim}Search the web    ${C.reset}→  "what's the latest news on AI agents?"
${INDENT}${C.dim}Read a URL        ${C.reset}→  "fetch https://example.com and summarize it"
${INDENT}${C.dim}Memory            ${C.reset}→  "remember that my name is Alice"
${INDENT}${C.dim}Math              ${C.reset}→  "calculate (1234 * 5678) / 3.14"
${INDENT}${C.dim}Date/time         ${C.reset}→  "what time is it in Tokyo?"
${INDENT}${C.dim}Schedule          ${C.reset}→  "schedule a daily task to check hacker news"
`);
}

// Spinner
function startSpinner(): () => void {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${C.yellow}${frames[i++ % frames.length]} Thinking...${C.reset}`);
  }, 80);
  return () => { clearInterval(id); process.stdout.write("\r\x1b[K"); };
}

// ─── API call ─────────────────────────────────────────────────────────────────
async function sendMessage(message: string, sessionId: string): Promise<string> {
  const res = await fetch(`${WORKER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });

  const data = await res.json() as Record<string, unknown>;

  // Handle error responses from the worker
  if (!res.ok || data.error) {
    const errMsg = String(data.error ?? data.details ?? `HTTP ${res.status}`);
    throw new Error(errMsg);
  }

  const reply = String(data.reply ?? "");
  if (!reply.trim()) throw new Error("Agent returned an empty response");
  return reply;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Health check
  try {
    const r = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error();
  } catch {
    console.error(`\n  ${C.red}✗ Cannot reach worker at ${WORKER_URL}${C.reset}`);
    console.error(`  ${C.gray}Run: npm run dev${C.reset}\n`);
    process.exit(1);
  }

  banner();

  let sessionId = SESSION_ID;

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    prompt:   `\n  ${C.blue}${C.bold}You ›${C.reset} `,
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (raw) => {
    const input = raw.trim();
    if (!input) { rl.prompt(); return; }

    // ── CLI commands ──────────────────────────────────────────────────────
    if (input === "/exit" || input === "/quit") {
      console.log(`\n  ${C.gray}Goodbye!${C.reset}\n`);
      process.exit(0);
    }
    if (input === "/help")    { helpText(); rl.prompt(); return; }
    if (input === "/clear")   { console.clear(); banner(); rl.prompt(); return; }
    if (input === "/session") {
      console.log(`\n  ${C.gray}Session: ${C.white}${sessionId}${C.reset}\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith("/session ")) {
      sessionId = input.slice(9).trim();
      console.log(`\n  ${C.green}✓ Switched to session: ${C.white}${sessionId}${C.reset}\n`);
      rl.prompt();
      return;
    }

    // ── Send to agent ─────────────────────────────────────────────────────
    console.log();
    const stopSpinner = startSpinner();

    try {
      const reply = await sendMessage(input, sessionId);
      stopSpinner();

      // Agent label
      console.log(`  ${C.green}${C.bold}Agent ›${C.reset}`);
      console.log();

      // Render markdown
      const rendered = renderMarkdown(reply);
      console.log(rendered);
      console.log();
    } catch (err) {
      stopSpinner();
      const msg = String(err).replace(/^Error: /, "");
      console.log(`  ${C.red}${C.bold}Error ›${C.reset} ${C.red}${msg}${C.reset}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n  ${C.gray}Session ended.${C.reset}\n`);
    process.exit(0);
  });
}

main();