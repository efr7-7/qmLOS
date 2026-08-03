export type MemoryImportFormat = "claude-export" | "markdown-note";

export interface MemoryImportResult {
  format: MemoryImportFormat;
  facts: string[];
  scanned: number;
  source: string;
}

export class MemoryImportError extends Error {
  hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "MemoryImportError";
    this.hint = hint;
  }
}

export const MEMORY_IMPORT_MAX_FACTS = 200;
export const MEMORY_IMPORT_MAX_BYTES = 32_000_000;
const MAX_FACT_CHARS = 240;
const MIN_FACT_CHARS = 12;

const FACT_PATTERNS: RegExp[] = [
  /\bi(?:'m| am)\b/i,
  /\bi(?:'ve| have)\b/i,
  /\bi (?:use|prefer|like|hate|avoid|work|live|run|own|need|want|always|never|usually)\b/i,
  /\bmy [a-z][a-z'-]*\b/i,
  /\bwe (?:use|prefer|run|ship|deploy|call)\b/i,
  /\b(?:call me|remember that|note that|for context|fyi)\b/i,
];

function tidy(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keep(text: string): boolean {
  if (text.length < MIN_FACT_CHARS || text.length > MAX_FACT_CHARS) return false;
  if (/^https?:\/\//i.test(text)) return false;
  return /[a-z]/i.test(text);
}

function dedupe(facts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const fact of facts) {
    const key = fact.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
    if (out.length >= MEMORY_IMPORT_MAX_FACTS) break;
  }
  return out;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const m = message as { text?: unknown; content?: unknown };
  if (typeof m.text === "string" && m.text.trim()) return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function isHuman(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { sender?: unknown; role?: unknown };
  const candidates = [m.sender, m.role].filter((v): v is string => typeof v === "string");
  return candidates.some((who) => who === "human" || who === "user");
}

function fromClaudeExport(parsed: unknown, source: string): MemoryImportResult {
  if (!Array.isArray(parsed)) {
    throw new MemoryImportError(
      "That JSON is not a Claude conversation export.",
      "A Claude export is a JSON array of conversations, each with a chat_messages list. Export it from Settings → Privacy → Export data and upload conversations.json.",
    );
  }
  const facts: string[] = [];
  let scanned = 0;
  for (const conversation of parsed) {
    if (typeof conversation !== "object" || conversation === null) continue;
    const messages = (conversation as { chat_messages?: unknown; messages?: unknown }).chat_messages ??
      (conversation as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) continue;
    scanned += 1;
    for (const message of messages) {
      if (!isHuman(message)) continue;
      for (const sentence of sentences(tidy(messageText(message)))) {
        if (!keep(sentence)) continue;
        if (!FACT_PATTERNS.some((re) => re.test(sentence))) continue;
        facts.push(sentence);
      }
    }
  }
  if (!scanned) {
    throw new MemoryImportError(
      "No conversations found in that export.",
      "Upload the conversations.json file from a Claude data export — the array entries need a chat_messages list.",
    );
  }
  return { format: "claude-export", facts: dedupe(facts), scanned, source };
}

function fromMarkdown(content: string, source: string): MemoryImportResult {
  const lines = content.split(/\r?\n/);
  const title = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, "").trim() ?? source.replace(/\.[a-z]+$/i, "");
  const facts: string[] = [];
  let scanned = 0;
  let inCode = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^---+$/.test(line) || /^\|/.test(line)) continue;
    scanned += 1;
    const bullet = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/);
    const text = tidy(bullet ? bullet[1]! : line);
    if (!keep(text)) continue;
    facts.push(title && !text.toLowerCase().includes(title.toLowerCase()) ? `${title}: ${text}` : text);
  }
  if (!scanned) {
    throw new MemoryImportError("That note has no readable lines.", "Upload a Markdown note with bullets or prose.");
  }
  return { format: "markdown-note", facts: dedupe(facts), scanned, source };
}

export function parseMemoryImport(filename: string, content: string): MemoryImportResult {
  const source = filename.trim() || "upload";
  if (!content.trim()) {
    throw new MemoryImportError("That file is empty.", "Upload a Claude conversations.json export or a Markdown note.");
  }
  const looksJson = /\.json$/i.test(source) || /^\s*[[{]/.test(content);
  if (looksJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new MemoryImportError(
        `That file is not valid JSON — ${(e as Error).message}`,
        "Upload the conversations.json file exactly as Claude exported it, or a Markdown note instead.",
      );
    }
    return fromClaudeExport(parsed, source);
  }
  if (!/\.(md|markdown|txt)$/i.test(source) && /\.[a-z0-9]+$/i.test(source)) {
    throw new MemoryImportError(
      `${source} is not a supported import.`,
      "Upload a Claude conversations.json export or a Markdown (.md) note.",
    );
  }
  return fromMarkdown(content, source);
}
