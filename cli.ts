/**
 * cli.ts — VEGA Terminal Interface
 *
 * Usage:
 *   npm run chat
 *   npm run chat -- --session my-session
 *   npm run chat -- --url http://127.0.0.1:8787
 */
import * as readline from "readline";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ─── Config ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const WORKER_URL = getArg("--url", "http://127.0.0.1:8787");
const SESSION_ID = getArg("--session", `cli-${crypto.randomBytes(4).toString("hex")}`);
const FILE_PATH = getArg("--file", "");
const DIR_PATH = getArg("--dir", "");

// ─── ANSI Color Palette ───────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // VEGA star palette — bluish-white star, deep space
  white: "\x1b[97m",
  gray: "\x1b[90m",
  silver: "\x1b[37m",

  // Primary — electric cyan (VEGA star color)
  cyan: "\x1b[96m",
  cyanDim: "\x1b[36m",

  // Secondary — violet nebula
  violet: "\x1b[35m",
  violetBr: "\x1b[95m",

  // Tertiary — deep teal
  teal: "\x1b[34m",
  tealBr: "\x1b[94m",

  // Accents
  green: "\x1b[92m",
  greenDim: "\x1b[32m",
  yellow: "\x1b[93m",
  red: "\x1b[91m",
  redDim: "\x1b[31m",
  orange: "\x1b[33m",

  // Backgrounds
  bgCyan: "\x1b[46m",
  bgViolet: "\x1b[45m",
  bgDark: "\x1b[40m",
  bgGray: "\x1b[100m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
};

// True-color gradient helper (r,g,b)
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bgRgb = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

const termWidth = () => process.stdout.columns || 110;
const INDENT = "   ";

// ─── VEGA ASCII Logo (gradient) ──────────────────────────────────────────────

const LOGO_LINES = [
  "  ██╗   ██╗███████╗ ██████╗  █████╗ ",
  "  ██║   ██║██╔════╝██╔════╝ ██╔══██╗",
  "  ██║   ██║█████╗  ██║  ███╗███████║",
  "  ╚██╗ ██╔╝██╔══╝  ██║   ██║██╔══██║",
  "   ╚████╔╝ ███████╗╚██████╔╝██║  ██║",
  "    ╚═══╝  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝",
];

// Gradient: deep-violet → cyan → white (like a hot blue star)
const LOGO_GRADIENT = [
  rgb(140, 100, 255),   // violet
  rgb(100, 160, 255),   // blue
  rgb(80, 220, 255),   // cyan-blue
  rgb(120, 240, 255),   // cyan
  rgb(180, 245, 255),   // pale cyan
  rgb(220, 250, 255),   // near-white
];

function renderLogo(): string {
  const lines: string[] = [];
  LOGO_LINES.forEach((line, i) => {
    const color = LOGO_GRADIENT[i] ?? LOGO_GRADIENT[LOGO_GRADIENT.length - 1];
    lines.push(`${color}${C.bold}${line}${C.reset}`);
  });
  return lines.join("\n");
}

// ─── Box-drawing utilities ─────────────────────────────────────────────────────

const BOX = {
  // Rounded thin box
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  // Heavy variants
  Htl: "┏", Htr: "┓", Hbl: "┗", Hbr: "┛",
  Hh: "━", Hv: "┃",
  // Separators
  lT: "├", rT: "┤", cT: "┬", cB: "┴", cross: "┼",
};

function hLine(width: number, char = BOX.h): string {
  return char.repeat(Math.max(0, width));
}

function boxTop(width: number, color = C.gray): string {
  return `${color}${BOX.tl}${hLine(width - 2)}${BOX.tr}${C.reset}`;
}

function boxBot(width: number, color = C.gray): string {
  return `${color}${BOX.bl}${hLine(width - 2)}${BOX.br}${C.reset}`;
}

function boxLine(content: string, width: number, color = C.gray): string {
  const stripped = stripAnsi(content);
  const pad = Math.max(0, width - 4 - stripped.length);
  return `${color}${BOX.v}${C.reset} ${content}${" ".repeat(pad)} ${color}${BOX.v}${C.reset}`;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x00/g, "");
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

function renderStatusBar(sessionId: string, model = "claude-sonnet-4"): void {
  const w = termWidth();
  const left = ` ${C.bgGray}${C.white}${C.bold} VEGA ${C.reset}${C.gray}${C.bgDark} ${model} ${C.reset}`;
  const mid = `${C.dim} session:${C.reset}${C.gray}${sessionId}${C.reset}`;
  const right = `${C.gray} esc ${C.dim}interrupt ${C.reset}${C.gray} /help ${C.dim}commands ${C.reset}`;

  const leftLen = stripAnsi(left).length;
  const midLen = stripAnsi(mid).length;
  const rightLen = stripAnsi(right).length;
  const spaces = Math.max(1, w - leftLen - midLen - rightLen);
  const midSpace = Math.floor(spaces / 2);

  process.stdout.write(
    `\n${left}${" ".repeat(midSpace)}${mid}${" ".repeat(spaces - midSpace)}${right}\n`
  );
}

// ─── Markdown → Terminal renderer ────────────────────────────────────────────

function renderMarkdown(md: string, indentStr = INDENT): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let codeLang = "";
  let inTable = false;
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (!tableRows.length) return;
    const cols = Math.max(...tableRows.map(r => r.length));
    const widths: number[] = Array(cols).fill(0);
    for (const row of tableRows) {
      row.forEach((cell, i) => { widths[i] = Math.max(widths[i], stripAnsi(cell).length); });
    }

    const sep = `${indentStr}${C.gray}${BOX.lT}${widths.map(w => BOX.h.repeat(w + 2)).join(BOX.cross)}${BOX.rT}${C.reset}`;
    out.push(`${indentStr}${C.gray}${BOX.tl}${widths.map(w => BOX.h.repeat(w + 2)).join(BOX.cT)}${BOX.tr}${C.reset}`);

    tableRows.forEach((row, ri) => {
      const cells = widths.map((w, i) => {
        const cell = row[i] ?? "";
        const pad = w - stripAnsi(cell).length;
        return ri === 0
          ? ` ${C.bold}${C.white}${cell}${C.reset}${" ".repeat(pad)} `
          : ` ${cell}${" ".repeat(pad)} `;
      });
      out.push(`${indentStr}${C.gray}${BOX.v}${C.reset}${cells.join(`${C.gray}${BOX.v}${C.reset}`)}${C.gray}${BOX.v}${C.reset}`);
      if (ri === 0) out.push(sep);
    });
    out.push(`${indentStr}${C.gray}${BOX.bl}${widths.map(w => BOX.h.repeat(w + 2)).join(BOX.cB)}${BOX.br}${C.reset}`);
    tableRows = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Code blocks ───────────────────────────────────────────────────────────
    if (line.startsWith("```")) {
      if (!inCode) {
        if (inTable) flushTable();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
      } else {
        const w = Math.min(termWidth() - indentStr.length - 4, 72);
        const label = codeLang
          ? `${bgRgb(30, 40, 55)}${rgb(120, 200, 255)} ${codeLang} ${C.reset}`
          : "";
        const topBar = `${C.gray}${BOX.tl}${BOX.h.repeat(2)}${label ? "" : ""}${hLine(w - (codeLang ? codeLang.length + 3 : 2))}${BOX.tr}${C.reset}`;

        out.push(`\n${indentStr}${topBar}`);
        if (codeLang) {
          out.push(`${indentStr}${C.gray}${BOX.v}${C.reset}${label}${hLine(w - codeLang.length - 3)}${C.gray}${BOX.v}${C.reset}`);
          out.push(`${indentStr}${C.gray}${BOX.lT}${hLine(w)}${BOX.rT}${C.reset}`);
        }
        for (const cl of codeLines) {
          const stripped = stripAnsi(cl);
          const pad = Math.max(0, w - stripped.length - 2);
          out.push(`${indentStr}${C.gray}${BOX.v}${C.reset} ${rgb(130, 210, 120)}${cl}${C.reset}${" ".repeat(pad)} ${C.gray}${BOX.v}${C.reset}`);
        }
        out.push(`${indentStr}${C.gray}${BOX.bl}${hLine(w)}${BOX.br}${C.reset}\n`);
        inCode = false;
        codeLines = [];
        codeLang = "";
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    // ── Tables ────────────────────────────────────────────────────────────────
    if (line.includes("|") && line.trim().startsWith("|")) {
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue; // skip separator
      inTable = true;
      tableRows.push(
        line.trim().replace(/^\||\|$/g, "").split("|").map(c => inlineFormat(c.trim()))
      );
      continue;
    }
    if (inTable) flushTable();

    // ── Headings ──────────────────────────────────────────────────────────────
    if (line.startsWith("#### ")) {
      out.push(`\n${indentStr}${C.dim}${C.italic}${inlineFormat(line.slice(5))}${C.reset}`);
      continue;
    }
    if (line.startsWith("### ")) {
      const t = inlineFormat(line.slice(4));
      out.push(`\n${indentStr}${rgb(120, 200, 255)}${C.bold}${t}${C.reset}`);
      out.push(`${indentStr}${C.gray}${hLine(stripAnsi(t).length, "─")}${C.reset}`);
      continue;
    }
    if (line.startsWith("## ")) {
      const t = line.slice(3).toUpperCase();
      out.push(`\n${indentStr}${rgb(160, 220, 255)}${C.bold}${t}${C.reset}`);
      out.push(`${indentStr}${rgb(60, 100, 140)}${hLine(t.length + 2, "━")}${C.reset}`);
      continue;
    }
    if (line.startsWith("# ")) {
      const t = line.slice(2).toUpperCase();
      out.push(`\n${indentStr}${C.bold}${C.white}${t}${C.reset}`);
      out.push(`${indentStr}${rgb(80, 160, 220)}${hLine(t.length + 2, "═")}${C.reset}`);
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────────
    if (/^[-*_]{3,}$/.test(line.trim())) {
      const w = Math.min(termWidth() - indentStr.length - 6, 60);
      out.push(`\n${indentStr}${C.gray}${hLine(w, "─")}${C.reset}\n`);
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────────
    if (line.startsWith("> ")) {
      out.push(
        `${indentStr}${rgb(80, 130, 180)}${BOX.v}${C.reset}` +
        ` ${C.italic}${C.silver}${inlineFormat(line.slice(2))}${C.reset}`
      );
      continue;
    }

    // ── Nested lists (2-space/tab indent) ─────────────────────────────────────
    if (/^( {2,}|\t)[*\-+] /.test(line)) {
      const text = line.replace(/^(\s+)[*\-+] /, "");
      out.push(`${indentStr}  ${C.gray}◦${C.reset} ${C.dim}${inlineFormat(text)}${C.reset}`);
      continue;
    }

    // ── Bullet lists ──────────────────────────────────────────────────────────
    if (/^[*\-+] /.test(line)) {
      const text = line.replace(/^[*\-+] /, "");
      out.push(`${indentStr}${rgb(80, 200, 220)}▸${C.reset} ${inlineFormat(text)}`);
      continue;
    }

    // ── Numbered lists ────────────────────────────────────────────────────────
    if (/^\d+\. /.test(line)) {
      const num = line.match(/^(\d+)\./)?.[1] ?? "";
      const text = line.replace(/^\d+\. /, "");
      out.push(`${indentStr}${rgb(120, 200, 255)}${C.bold}${num}.${C.reset} ${inlineFormat(text)}`);
      continue;
    }

    // ── Empty lines ───────────────────────────────────────────────────────────
    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // ── Normal text ───────────────────────────────────────────────────────────
    const formatted = inlineFormat(line);
    const maxW = termWidth() - indentStr.length - 4;
    const wrapped = wordWrap(formatted, maxW, indentStr);
    out.push(`${indentStr}${wrapped}`);
  }

  if (inTable) flushTable();
  return out.join("\n");
}

function inlineFormat(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, `${C.bold}${C.italic}${C.white}$1${C.reset}`)
    .replace(/\*\*(.+?)\*\*/g, `${C.bold}${C.white}$1${C.reset}`)
    .replace(/\*(.+?)\*/g, `${C.italic}${C.silver}$1${C.reset}`)
    .replace(/_(.+?)_/g, `${C.italic}${C.silver}$1${C.reset}`)
    .replace(/~~(.+?)~~/g, `${C.dim}$1${C.reset}`)
    .replace(/`([^`]+)`/g, `${bgRgb(30, 45, 60)}${rgb(130, 210, 120)} $1 ${C.reset}`)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      `${C.underline}${rgb(100, 180, 255)}$1${C.reset}${C.gray} ↗ ${C.reset}`
    )
    .replace(
      /(https?:\/\/[^\s]+)/g,
      `${C.underline}${rgb(100, 180, 255)}$1${C.reset}`
    );
}

function wordWrap(text: string, width: number, indentStr: string): string {
  const strip = (s: string) => stripAnsi(s);
  if (strip(text).length <= width) return text;

  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";

  for (const word of words) {
    const test = cur ? cur + " " + word : word;
    if (cur && strip(test).length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.join(`\n${indentStr}`);
}

// ─── Tool event renderer ──────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  web_search: "🔍", browse_web: "🌐", cf_browse_page: "🌐",
  cf_screenshot: "📸", cf_extract_data: "⛏️", fetch_url: "📄",
  store_memory: "💾", recall_memory: "🧠", run_code: "💻",
  set_secret: "🔐", get_secret: "🔑", list_secrets: "📜",
  generate_image: "🎨", translate: "🌍", market_data: "📈",
  spawn_agent: "🤖", write_file: "📁", read_file: "📂",
  schedule_cron: "⏰", send_email: "📧", calculate: "🧮",
  manage_goals: "🎯", semantic_recall: "🔮",
};

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "⚙";
}

function renderToolCall(name: string, status: "running" | "done" | "error"): string {
  const icon = getToolIcon(name);
  const dot = status === "running" ? `${C.yellow}◉${C.reset}`
    : status === "done" ? `${rgb(80, 220, 160)}✓${C.reset}`
      : `${C.red}✗${C.reset}`;
  const color = status === "running" ? rgb(200, 180, 80)
    : status === "done" ? rgb(80, 220, 160)
      : rgb(220, 80, 80);
  return `${INDENT}${dot} ${icon}  ${color}${name}${C.reset}`;
}

// ─── Message renderers ────────────────────────────────────────────────────────

function renderUserMessage(text: string): void {
  const w = Math.min(termWidth() - 8, 90);
  const lines = text.split("\n");
  console.log();
  console.log(
    `${INDENT}${rgb(30, 50, 80)}${BOX.tl}${BOX.h.repeat(2)}${C.reset}` +
    `${bgRgb(20, 38, 68)}${rgb(120, 180, 255)} You ${C.reset}` +
    `${rgb(30, 50, 80)}${BOX.h.repeat(w - 8)}${BOX.tr}${C.reset}`
  );
  for (const line of lines) {
    const stripped = stripAnsi(line);
    const pad = Math.max(0, w - stripped.length - 4);
    console.log(
      `${INDENT}${rgb(30, 50, 80)}${BOX.v}${C.reset} ` +
      `${rgb(180, 210, 255)}${line}${C.reset}` +
      `${" ".repeat(pad)} ${rgb(30, 50, 80)}${BOX.v}${C.reset}`
    );
  }
  console.log(`${INDENT}${rgb(30, 50, 80)}${BOX.bl}${BOX.h.repeat(w - 2)}${BOX.br}${C.reset}`);
}

function renderAgentHeader(stepCount: number): void {
  const label = ` VEGA `;
  const steps = stepCount > 0 ? ` ${stepCount} step${stepCount > 1 ? "s" : ""} ` : "";
  console.log();
  console.log(
    `${INDENT}${rgb(20, 60, 80)}${BOX.tl}${BOX.h.repeat(2)}${C.reset}` +
    `${bgRgb(10, 50, 70)}${rgb(80, 220, 255)}${C.bold}${label}${C.reset}` +
    `${rgb(20, 60, 80)}${BOX.h.repeat(2)}${C.reset}` +
    (steps ? `${C.gray}${steps}${C.reset}` : "") +
    `${rgb(20, 60, 80)}${C.reset}`
  );
}

function renderAgentResponse(text: string, stepCount = 0): void {
  renderAgentHeader(stepCount);
  console.log();
  const rendered = renderMarkdown(text);
  console.log(rendered);
  console.log();
}

function renderErrorMessage(message: string): void {
  const w = Math.min(termWidth() - 8, 80);
  console.log();
  console.log(
    `${INDENT}${rgb(100, 20, 20)}${BOX.tl}${BOX.h.repeat(2)}${C.reset}` +
    `${bgRgb(90, 15, 15)}${rgb(255, 100, 100)} Error ${C.reset}` +
    `${rgb(100, 20, 20)}${BOX.h.repeat(w - 10)}${BOX.tr}${C.reset}`
  );
  const lines = message.split("\n");
  for (const line of lines) {
    const stripped = stripAnsi(line);
    const pad = Math.max(0, w - stripped.length - 4);
    console.log(
      `${INDENT}${rgb(100, 20, 20)}${BOX.v}${C.reset} ` +
      `${rgb(255, 130, 130)}${line}${C.reset}` +
      `${" ".repeat(pad)} ${rgb(100, 20, 20)}${BOX.v}${C.reset}`
    );
  }
  console.log(`${INDENT}${rgb(100, 20, 20)}${BOX.bl}${BOX.h.repeat(w - 2)}${BOX.br}${C.reset}`);
  console.log();
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function banner(sessionId: string) {
  console.clear();
  const w = termWidth();

  // Top padding
  console.log("\n\n");

  // VEGA logo — centered
  const logoWidth = 38;
  const pad = Math.max(0, Math.floor((w - logoWidth) / 2));
  for (const line of renderLogo().split("\n")) {
    console.log(" ".repeat(pad) + line);
  }

  // Tagline
  const tagline = `${C.dim}${C.italic}autonomous AI agent  ·  always on  ·  always remembers${C.reset}`;
  const tagLen = 51;
  const tagPad = Math.max(0, Math.floor((w - tagLen) / 2));
  console.log("\n" + " ".repeat(tagPad) + tagline);

  // Divider
  console.log(`\n${INDENT}${C.gray}${hLine(Math.min(w - INDENT.length * 2, 60), "─")}${C.reset}`);

  // Info row
  const workerStr = `${C.gray}worker   ${C.reset}${rgb(100, 180, 255)}${WORKER_URL}${C.reset}`;
  const sessStr = `${C.gray}session  ${C.reset}${rgb(160, 230, 180)}${sessionId}${C.reset}`;
  console.log(`${INDENT}${workerStr}`);
  console.log(`${INDENT}${sessStr}`);

  // Commands hint
  const cmds = ["/help", "/session", "/clear", "/exit"].map(
    c => `${rgb(80, 200, 220)}${c}${C.reset}`
  ).join(`  ${C.gray}·${C.reset}  `);
  console.log(`\n${INDENT}${C.dim}commands  ${C.reset}${cmds}`);
  console.log(`${INDENT}${C.gray}${hLine(Math.min(w - INDENT.length * 2, 60), "─")}${C.reset}\n`);
}

// ─── Help panel ──────────────────────────────────────────────────────────────

function helpText(): void {
  const w = 56;
  console.log();
  console.log(
    `${INDENT}${C.gray}${BOX.tl}${BOX.h.repeat(2)}${C.reset}` +
    `${bgRgb(20, 45, 65)}${rgb(80, 200, 220)} Commands ${C.reset}` +
    `${C.gray}${BOX.h.repeat(w - 13)}${BOX.tr}${C.reset}`
  );

  const cmds: [string, string][] = [
    ["/exit", "Quit VEGA"],
    ["/session", "Show current session ID"],
    ["/session <id>", "Switch to a different session"],
    ["/clear", "Clear the terminal"],
    ["/help", "Show this panel"],
    ["/tools", "List available agent tools"],
    ["/heartbeat", "Trigger system heartbeat/reflection"],
  ];
  for (const [cmd, desc] of cmds) {
    const c = `${rgb(80, 200, 220)}${C.bold}${cmd}${C.reset}`;
    const d = `${C.dim}${desc}${C.reset}`;
    const pad = Math.max(0, w - stripAnsi(cmd).length - stripAnsi(d).length - 4);
    console.log(
      `${INDENT}${C.gray}${BOX.v}${C.reset}  ${c}${" ".repeat(pad)}${d}  ${C.gray}${BOX.v}${C.reset}`
    );
  }

  console.log(
    `${INDENT}${C.gray}${BOX.lT}${BOX.h.repeat(2)}${C.reset}` +
    `${bgRgb(20, 45, 40)}${rgb(80, 220, 160)} Examples ${C.reset}` +
    `${C.gray}${BOX.h.repeat(w - 13)}${BOX.rT}${C.reset}`
  );

  const examples: [string, string][] = [
    ["Search", "\"what\\'s the latest news on AI agents?\""],
    ["Memory", "\"remember that I prefer TypeScript\""],
    ["Vault", "\"remember my github token: ghp_...\""],
    ["Market", "\"what\\'s BTC at right now?\""],
    ["Goal", "\"track goal: ship VEGA v2 by end of month\""],
    ["Image", "\"generate an image of a nebula at dusk\""],
    ["Schedule", "\"run a daily web search on AI papers\""],
    ["Analyze File", "\"analyze file /path/to/doc.pdf: extract key metrics\""],
  ];
  for (const [label, example] of examples) {
    const l = `${rgb(160, 230, 180)}${C.bold}${label.padEnd(10)}${C.reset}`;
    const e = `${C.dim}${example}${C.reset}`;
    const pad = Math.max(0, w - stripAnsi(l).length - stripAnsi(e).length - 4);
    console.log(
      `${INDENT}${C.gray}${BOX.v}${C.reset}  ${l}${e}${" ".repeat(pad)}  ${C.gray}${BOX.v}${C.reset}`
    );
  }
  console.log(`${INDENT}${C.gray}${BOX.bl}${BOX.h.repeat(w)}${BOX.br}${C.reset}`);
  console.log();
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

function startSpinner(sessionId: string): (label?: string) => void {
  // Braille dot spinner with gradient
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const colors = [
    rgb(80, 200, 255), rgb(100, 180, 255), rgb(120, 160, 255),
    rgb(140, 140, 255), rgb(160, 120, 255), rgb(140, 140, 255),
    rgb(120, 160, 255), rgb(100, 180, 255),
  ];
  let frameIdx = 0;
  let colorIdx = 0;
  let currentLabel = "Thinking";

  const id = setInterval(() => {
    const frame = frames[frameIdx % frames.length];
    const color = colors[colorIdx % colors.length];
    process.stdout.write(
      `\r${INDENT}${color}${frame}${C.reset}  ${C.dim}${currentLabel}…${C.reset}   `
    );
    frameIdx++;
    colorIdx++;
  }, 70);

  return (label?: string) => {
    if (label) currentLabel = label;
    else {
      clearInterval(id);
      process.stdout.write("\r\x1b[K");
    }
  };
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function sendMessage(message: string, sessionId: string): Promise<string> {
  const attachments: { mimeType: string; data: string; name: string }[] = [];

  const addFile = (fullPath: string) => {
    try {
      if (!fs.statSync(fullPath).isFile()) return;
      const ext = path.extname(fullPath).toLowerCase();
      let mimeType = "application/octet-stream";
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext))
        mimeType = `image/${ext === ".jpg" ? "jpeg" : ext.slice(1)}`;
      else if (ext === ".pdf")
        mimeType = "application/pdf";
      attachments.push({ mimeType, data: fs.readFileSync(fullPath).toString("base64"), name: path.basename(fullPath) });
    } catch { /* ignore */ }
  };

  if (FILE_PATH) addFile(FILE_PATH);
  if (DIR_PATH) {
    try {
      for (const e of fs.readdirSync(DIR_PATH).slice(0, 5))
        addFile(path.join(DIR_PATH, e));
    } catch { /* ignore */ }
  }

  const res = await fetch(`${WORKER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-stream": "false" },
    body: JSON.stringify({ message, sessionId, attachments }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || data.error) throw new Error(String(data.error ?? data.details ?? `HTTP ${res.status}`));
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
    console.log();
    renderErrorMessage(
      `Cannot reach VEGA worker at ${WORKER_URL}\n` +
      `Make sure the worker is running:  npm run dev`
    );
    process.exit(1);
  }

  let sessionId = SESSION_ID;
  banner(sessionId);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    process.stdout.write(
      `\n${INDENT}${rgb(80, 200, 220)}${C.bold}›${C.reset} `
    );
  };

  prompt();

  let messageCount = 0;

  rl.on("line", async (raw) => {
    const input = raw.trim();
    if (!input) { prompt(); return; }

    // ── CLI commands ──────────────────────────────────────────────────────────
    if (input === "/exit" || input === "/quit") {
      console.log(`\n${INDENT}${C.dim}Goodbye. VEGA is always watching.${C.reset}\n`);
      process.exit(0);
    }
    if (input === "/help") { helpText(); prompt(); return; }
    if (input === "/clear") { banner(sessionId); prompt(); return; }

    if (input === "/session") {
      console.log(
        `\n${INDENT}${C.gray}session  ${C.reset}${rgb(160, 230, 180)}${sessionId}${C.reset}\n`
      );
      prompt();
      return;
    }
    if (input.startsWith("/session ")) {
      sessionId = input.slice(9).trim();
      console.log(
        `\n${INDENT}${rgb(80, 220, 160)}✓${C.reset} Switched to session ` +
        `${rgb(160, 230, 180)}${sessionId}${C.reset}\n`
      );
      prompt();
      return;
    }

    // ── Send to agent ─────────────────────────────────────────────────────────
    messageCount++;
    renderUserMessage(input);

    const stopSpinner = startSpinner(sessionId);
    try {
      const reply = await sendMessage(input, sessionId);
      stopSpinner();
      renderAgentResponse(reply, messageCount);
    } catch (err) {
      stopSpinner();
      const msg = String(err).replace(/^Error: /, "");
      renderErrorMessage(msg);
    }

    prompt();
  });

  rl.on("close", () => {
    console.log(`\n\n${INDENT}${C.dim}Session ended.${C.reset}\n`);
    process.exit(0);
  });
}

main();