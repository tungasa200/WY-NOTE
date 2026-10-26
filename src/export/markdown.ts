// TipTap JSON → 마크다운(GFM) 변환(F-06). 파일 쓰기는 하지 않는 순수 함수다.
// Node 타입 제거 실행(scripts/check-markdown.ts)으로도 돌기 때문에 enum·namespace 같은 TS 전용 문법을 쓰지 않는다.
import type { JSONContent } from "@tiptap/react";

export type ExportWarningKind = "tableCellBlock" | "tableSpan" | "underline" | "unknownNode" | "imageNoSource";

export type ExportWarning = { kind: ExportWarningKind; count: number; message: string };

export type MarkdownResult = {
  markdown: string;
  /** 본문이 쓰는 첨부 파일 이름(중복 없음, 나온 순서). 내보내는 쪽이 imageDir로 복사한다. */
  images: string[];
  /** 마크다운으로 그대로 옮기지 못한 것(F-06 "내보내기 후 알린다"). 없으면 빈 배열. */
  warnings: ExportWarning[];
};

export type MarkdownOptions = {
  /** .md 파일에서 본 이미지 폴더의 상대 경로. 기본 "images". */
  imageDir?: string;
};

const WARNING_TEXT: Record<ExportWarningKind, (n: number) => string> = {
  tableCellBlock: (n) => `표 셀 안의 목록·코드 등 ${n}곳은 글로 바뀌었습니다.`,
  tableSpan: (n) => `합친 표 셀 ${n}곳은 나뉘어 내보내졌습니다.`,
  underline: (n) => `밑줄 ${n}곳은 마크다운에 없어 밑줄 없이 내보내졌습니다.`,
  unknownNode: (n) => `알 수 없는 블록 ${n}곳은 글만 내보내졌습니다.`,
  imageNoSource: (n) => `파일 이름이 없는 이미지 ${n}개는 빠졌습니다.`,
};

/** 코드 언어 별칭을 편집기 언어 이름(D-16의 10개)으로 맞춘다. 목록에 없는 언어는 소문자로만 바꾼다. */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", python3: "python",
  rs: "rust",
  jsonc: "json",
  sh: "bash", shell: "bash", zsh: "bash",
  html: "xml", xhtml: "xml", svg: "xml",
  md: "markdown", mkd: "markdown",
};

export function normalizeLanguage(language: unknown): string {
  if (typeof language !== "string") return "";
  // 펜스 정보 문자열에는 공백·백틱이 들어갈 수 없다.
  const lang = language.trim().toLowerCase().replace(/[\s`]+/g, "");
  return LANGUAGE_ALIASES[lang] ?? lang;
}

type Ctx = {
  imageDir: string;
  images: string[];
  counts: Map<ExportWarningKind, number>;
  inTableCell: boolean;
};

/** 여러 페이지의 알림을 종류별로 더한다(하위 포함 내보내기에서 한 번에 보여 줄 때). */
export function mergeWarnings(list: ExportWarning[]): ExportWarning[] {
  const counts = new Map<ExportWarningKind, number>();
  for (const w of list) counts.set(w.kind, (counts.get(w.kind) ?? 0) + w.count);
  return toWarnings(counts);
}

function toWarnings(counts: Map<ExportWarningKind, number>): ExportWarning[] {
  return [...counts].map(([kind, count]) => ({ kind, count, message: WARNING_TEXT[kind](count) }));
}

function warn(ctx: Ctx, kind: ExportWarningKind) {
  ctx.counts.set(kind, (ctx.counts.get(kind) ?? 0) + 1);
}

export function docToMarkdown(doc: JSONContent, options: MarkdownOptions = {}): MarkdownResult {
  const ctx: Ctx = {
    imageDir: (options.imageDir ?? "images").replace(/[\\/]+$/, ""),
    images: [],
    counts: new Map(),
    inTableCell: false,
  };
  const body = blocks(doc.content ?? [], ctx, "\n\n");
  return { markdown: body ? body + "\n" : "", images: ctx.images, warnings: toWarnings(ctx.counts) };
}

// ---------- 블록 ----------

function blocks(nodes: JSONContent[], ctx: Ctx, sep: string): string {
  let out = "";
  let prev: JSONContent | undefined;
  for (const n of nodes) {
    const s = block(n, ctx);
    if (s === "") continue;
    // 같은 머리표(-, 1.)를 쓰는 목록이 연달으면 마크다운에서 한 목록으로 합쳐지므로 빈 주석으로 끊는다.
    if (prev) out += sep + (isList(prev) && isList(n) && (prev.type === "orderedList") === (n.type === "orderedList") ? "<!-- -->" + sep : "");
    out += s;
    prev = n;
  }
  return out;
}

function block(node: JSONContent, ctx: Ctx): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.content ?? [], ctx);
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      // 제목은 한 줄이어야 하므로 줄바꿈을 공백으로 바꾼다.
      return `${"#".repeat(level)} ${inline(node.content ?? [], ctx, " ")}`.trimEnd();
    }
    case "bulletList":
      return list(node, ctx, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1) || 1;
      return list(node, ctx, (i) => `${start + i}. `);
    }
    case "taskList":
      return list(node, ctx, (_i, item) => (item.attrs?.checked ? "- [x] " : "- [ ] "), 2);
    case "codeBlock":
      return codeBlock(node);
    case "blockquote":
      return blocks(node.content ?? [], ctx, "\n\n")
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "horizontalRule":
      return "---";
    case "table":
      return table(node, ctx);
    case "image":
      return image(node, ctx);
    default:
      warn(ctx, "unknownNode");
      // 블록 자식이 있으면 블록으로, 아니면 글로 내보낸다.
      if (node.content?.some((c) => c.type !== "text" && c.type !== "hardBreak")) return blocks(node.content, ctx, "\n\n");
      return inline(node.content ?? [], ctx);
  }
}

/** indent: 둘째 줄부터 들여쓸 칸 수. 없으면 머리표 길이. 체크리스트는 "- " 뒤에 내용이 붙는 것으로 보아 2칸. */
function list(
  node: JSONContent,
  ctx: Ctx,
  marker: (i: number, item: JSONContent) => string,
  indent?: number,
): string {
  return (node.content ?? [])
    .map((item, i) => {
      const m = marker(i, item);
      const pad = " ".repeat(indent ?? m.length);
      const children = item.content ?? [];
      // 문단 뒤에 하위 목록이 오면 붙여 써서 목록이 느슨해지지 않게 한다.
      const parts = children.map((c) => block(c, ctx));
      let text = "";
      parts.forEach((p, j) => {
        if (j === 0) text = p;
        else text += (isList(children[j]) || isList(children[j - 1]) ? "\n" : "\n\n") + p;
      });
      return text
        .split("\n")
        .map((l, j) => (j === 0 ? m + l : l ? pad + l : ""))
        .join("\n")
        .trimEnd();
    })
    .join("\n");
}

function isList(n: JSONContent) {
  return n.type === "bulletList" || n.type === "orderedList" || n.type === "taskList";
}

function codeBlock(node: JSONContent): string {
  const code = (node.content ?? []).map((c) => c.text ?? "").join("");
  // 본문 안의 가장 긴 백틱 줄보다 길게 펜스를 만들어 코드가 펜스를 닫지 않게 한다.
  const longest = longestTicks(code);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${normalizeLanguage(node.attrs?.language)}\n${code}${code.endsWith("\n") || code === "" ? "" : "\n"}${fence}`;
}

function image(node: JSONContent, ctx: Ctx): string {
  const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
  if (!src) {
    warn(ctx, "imageNoSource");
    return "";
  }
  // 본문의 src는 첨부 파일 이름이다(D-17). 혹시 경로가 붙어 있어도 이름만 쓴다.
  const fileName = src.split(/[\\/]/).pop()!;
  if (!ctx.images.includes(fileName)) ctx.images.push(fileName);
  const path = [ctx.imageDir, fileName].filter(Boolean).map(encodePathSegment).join("/");
  const alt = escapeText(String(node.attrs?.alt ?? "")).replace(/\n/g, " ");
  const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/["\\]/g, "\\$&")}"` : "";
  return `![${alt}](${path}${title})`;
}

function encodePathSegment(path: string): string {
  return path
    .split(/[\\/]/)
    .map((s) => encodeURIComponent(s).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");
}

// ---------- 표 ----------

function table(node: JSONContent, ctx: Ctx): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).flatMap((cell) => {
      const colspan = Math.max(1, Number(cell.attrs?.colspan) || 1);
      const rowspan = Math.max(1, Number(cell.attrs?.rowspan) || 1);
      if (colspan > 1 || rowspan > 1) warn(ctx, "tableSpan");
      return [tableCell(cell, ctx), ...Array<string>(colspan - 1).fill("")];
    }),
  );
  if (rows.length === 0) return "";
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  // GFM 표는 머리 행이 꼭 있어야 하므로 첫 행을 머리로 쓴다.
  const [head, ...rest] = rows;
  return [line(head), line(Array(cols).fill("---")), ...rest.map(line)].join("\n");
}

function tableCell(cell: JSONContent, ctx: Ctx): string {
  const prev = ctx.inTableCell;
  ctx.inTableCell = true;
  const lines = (cell.content ?? []).flatMap((c) => {
    if (c.type === "paragraph") return [inline(c.content ?? [], ctx, "<br>")];
    if (c.type === "image") return [image(c, ctx)];
    warn(ctx, "tableCellBlock");
    return plainLines(c).map(escapeText);
  });
  ctx.inTableCell = prev;
  return lines.filter((l) => l !== "").join("<br>").replace(/\|/g, "\\|");
}

/** 표 셀 안의 목록·코드 같은 블록을 글줄로 편다. */
function plainLines(node: JSONContent): string[] {
  if (node.type === "text") return [node.text ?? ""];
  const children = node.content ?? [];
  if (children.every((c) => c.type === "text" || c.type === "hardBreak")) {
    const text = children.map((c) => (c.type === "hardBreak" ? "\n" : (c.text ?? ""))).join("");
    return text.split("\n");
  }
  return children.flatMap(plainLines);
}

// ---------- 글(인라인) ----------

type Mark = { type: string; attrs?: Record<string, unknown> };

const MARK_SYNTAX: Record<string, { open: (m: Mark) => string; close: (m: Mark) => string }> = {
  bold: { open: () => "**", close: () => "**" },
  italic: { open: () => "*", close: () => "*" },
  strike: { open: () => "~~", close: () => "~~" },
  link: {
    open: () => "[",
    close: (m) => {
      const href = String(m.attrs?.href ?? "").replace(/[()<> ]/g, (c) => encodeURIComponent(c));
      return `](${href})`;
    },
  },
};

const sameMark = (a: Mark, b: Mark) => a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);

/**
 * 연달은 글 조각의 서식을 하나의 열림·닫힘 순서로 맞춘다(같은 굵게가 이어지면 `**a****b**`가 되지 않게).
 * breakText: 줄바꿈(hardBreak) 대신 쓸 글. 문단은 마크다운 줄바꿈(백슬래시 + 줄바꿈).
 */
function inline(nodes: JSONContent[], ctx: Ctx, breakText = "\\\n"): string {
  let out = "";
  let open: Mark[] = [];
  let pendingSpace = "";

  const closeTo = (keep: number) => {
    while (open.length > keep) {
      const m = open.pop()!;
      out += MARK_SYNTAX[m.type].close(m);
    }
  };

  // 끝에 붙은 줄바꿈은 보이지 않고, 남기면 `\`만 홀로 남아 글자로 보인다.
  let end = nodes.length;
  while (end > 0 && nodes[end - 1].type === "hardBreak") end--;

  for (const node of nodes.slice(0, end)) {
    if (node.type === "hardBreak") {
      closeTo(0);
      out += pendingSpace + breakText;
      pendingSpace = "";
      continue;
    }
    if (node.type === "image") {
      closeTo(0);
      out += pendingSpace + image(node, ctx);
      pendingSpace = "";
      continue;
    }
    const text = node.type === "text" ? (node.text ?? "") : plainLines(node).join(" ");
    if (node.type !== "text") warn(ctx, "unknownNode");
    const marks = (node.marks ?? []) as Mark[];
    if (marks.some((m) => m.type === "underline")) warn(ctx, "underline");
    const isCode = marks.some((m) => m.type === "code");
    const wanted = marks.filter((m) => m.type in MARK_SYNTAX);

    // 이어지는 서식은 열린 채로 두고, 처음 달라지는 곳부터 닫는다.
    let keep = 0;
    while (keep < open.length && wanted.some((m) => sameMark(m, open[keep]))) keep++;
    closeTo(keep);

    // `** 굵게**`는 굵게로 읽히지 않으므로 앞뒤 공백은 서식 밖으로 뺀다.
    const [, lead, core, trail] = isCode ? ["", "", text, ""] : text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    out += pendingSpace + lead;
    pendingSpace = "";
    if (core === "") {
      pendingSpace = trail;
      continue;
    }
    for (const m of wanted) {
      if (!open.some((o) => sameMark(o, m))) {
        out += MARK_SYNTAX[m.type].open(m);
        open.push(m);
      }
    }
    out += isCode ? codeSpan(core) : escapeText(core);
    pendingSpace = trail;
  }
  closeTo(0);
  out += pendingSpace;
  // 문단 맨 앞·맨 뒤 공백은 마크다운에서 사라지거나 코드 블록이 되므로 걷어 낸다.
  return ctx.inTableCell ? out.trim() : out.replace(/^[ \t]+/gm, "").trimEnd();
}

function codeSpan(text: string): string {
  const longest = longestTicks(text);
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return ticks + pad + text + pad + ticks;
}

function longestTicks(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** 글자가 마크다운 문법으로 읽히지 않게 이스케이프한다. */
export function escapeText(text: string): string {
  return text
    .replace(/[\\`*_[\]<>~]/g, "\\$&")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/^(\s*)([#+\-=>])/gm, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/gm, "$1\\$2");
}
