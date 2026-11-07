// 페이지 안 찾기·바꾸기(F-11, S-14)의 편집기 쪽: 일치 찾기, 강조(꾸밈), 바꾸기 거래, 검색 결과 강조(F-04).
// 꾸밈은 문서를 바꾸지 않아 실행 취소 기록·자동 저장·본문 JSON에 남지 않는다.
import { Extension, type Editor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export type Range = { from: number; to: number };

/** 강조는 앞 1,000개까지만 그린다. 세기·모두 바꾸기는 전부(F-11). */
export const MARK_LIMIT = 1000;
const RECOUNT_MS = 100;
const FLASH_MS = 1500;
/** 지금 일치를 보일 때 막대 아래·편집 영역 아래에 남기는 틈(S-14). */
const SCROLL_INSET = 16;

/** 찾는 말 비교 형태: NFC + 소문자(대소문자 구별 없음, F-11). */
export const normalizeQuery = (q: string) => q.normalize("NFC").toLowerCase();

// NFC·소문자로 바꾸면 길이가 바뀌는 글(조합형 한글 자모, 결합 부호 등)은 이 단위로 묶어 원문 위치를 맞춘다.
const CLUSTER = /[ᄀ-ᅟꥠ-ꥼ]+[ᅠ-ᆧힰ-ퟆ]*[ᆨ-ᇿퟋ-ퟻ]*|[\s\S]\p{M}*/gu;

/** 글 조각 하나(블록 안, 글이 아닌 노드 사이)에서 겹치지 않게 찾는다. start는 조각 첫 글자의 문서 위치. */
function searchSegment(text: string, start: number, q: string, out: Range[]) {
  const lower = text.toLowerCase();
  if (lower.length === text.length && text.normalize("NFC") === text) {
    for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length))
      out.push({ from: start + i, to: start + i + q.length });
    return;
  }
  // at[k]: 바꾼 글의 k번째 글자가 시작하는 원문 자리. 묶음 가운데면 -1(일치가 거기서 시작·끝나지 않는다).
  let hay = "";
  const at: number[] = [];
  for (const m of text.matchAll(CLUSTER)) {
    const part = m[0].normalize("NFC").toLowerCase();
    for (let k = 0; k < part.length; k++) at.push(k === 0 ? m.index : -1);
    hay += part;
  }
  at.push(text.length);
  for (let i = hay.indexOf(q); i !== -1; ) {
    const a = at[i];
    const b = at[i + q.length];
    if (a !== -1 && b !== -1) {
      out.push({ from: start + a, to: start + b });
      i = hay.indexOf(q, i + q.length);
    } else i = hay.indexOf(q, i + 1);
  }
}

/**
 * 본문의 모든 일치(문서 순서). 한 글 블록 안에서만 맞추고, 서식 경계는 건너 맞춘다.
 * 줄바꿈·이미지 같은 글이 아닌 노드를 건너는 일치는 찾지 않는다. q는 normalizeQuery를 거친 값.
 */
export function findMatches(doc: PMNode, q: string): Range[] {
  const out: Range[] = [];
  if (!q) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    let start = 0;
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) start = pos + 1 + offset;
        text += child.text;
      } else {
        if (text) searchSegment(text, start, q, out);
        text = "";
      }
    });
    if (text) searchSegment(text, start, q, out);
    return false;
  });
  return out;
}

/** pos 뒤(같은 자리 포함)의 첫 일치. 없으면 처음으로 돌아간다. 일치가 없으면 -1. */
function indexAfter(matches: Range[], pos: number) {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i === -1 ? 0 : i;
}

/** pos 앞의 마지막 일치. 없으면 끝으로 돌아간다. */
function indexBefore(matches: Range[], pos: number) {
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < pos) return i;
  return matches.length - 1;
}

type FindState = {
  /** 비교 형태의 찾는 말. 비었으면 막대가 닫혔거나 찾는 말이 없다(강조 없음). */
  query: string;
  matches: Range[];
  /** matches를 센 문서. 지금 문서와 다르면 matches는 옮겨 놓은 옛 값이라 다시 세야 한다. */
  matchesDoc: PMNode | null;
  current: number;
  /** 검색 결과로 열었을 때 1.5초 옅게 강조하는 자리(F-04). */
  flash: Range | null;
  deco: DecorationSet;
};
type FindMeta = Partial<Pick<FindState, "query" | "matches" | "current" | "flash">>;

export const findKey = new PluginKey<FindState>("find");

function decorate(doc: PMNode, s: Omit<FindState, "deco">) {
  const list: Decoration[] = [];
  // 지운 글처럼 빈 자리는 그리지 않는다.
  const mark = (r: Range | null | undefined, cls: string) => {
    if (r && r.from < r.to) list.push(Decoration.inline(r.from, r.to, { class: cls }));
  };
  const n = Math.min(s.matches.length, MARK_LIMIT);
  for (let i = 0; i < n; i++) if (i !== s.current) mark(s.matches[i], "find-match");
  mark(s.matches[s.current], "find-match find-match-current");
  // 찾기 강조와 겹치면 찾기가 이긴다(S-14).
  if (!s.query) mark(s.flash, "find-flash");
  return DecorationSet.create(doc, list);
}

/** 꾸밈만 바꾸는 거래(실행 취소 기록에 넣지 않는다). 본문을 바꾸는 바꾸기 거래에는 쓰지 않는다. */
const setMeta = (tr: Transaction, meta: FindMeta) => tr.setMeta(findKey, meta).setMeta("addToHistory", false);

export const FindExtension = Extension.create({
  name: "find",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: "", matches: [], matchesDoc: null, current: -1, flash: null, deco: DecorationSet.empty }),
          apply(tr, s) {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            let next = s;
            if (tr.docChanged) {
              const map = (r: Range) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) });
              const flash = s.flash && map(s.flash);
              // 거래가 새 일치를 들고 오면(바꾸기) 옛 일치를 옮기지 않는다(모두 바꾸기는 걸음이 수천 개다).
              next = meta?.matches
                ? { ...s, flash }
                : { ...s, matches: s.matches.map(map), flash, deco: s.deco.map(tr.mapping, tr.doc) };
            }
            if (meta) {
              const merged = { ...next, ...meta, ...(meta.matches && { matchesDoc: tr.doc }) };
              next = { ...merged, deco: decorate(tr.doc, merged) };
            }
            return next;
          },
        },
        props: { decorations: (state) => findKey.getState(state)?.deco },
        // 막대가 열린 채 본문이 바뀌면 입력이 멈추고 100ms 뒤 다시 센다. 본문 한글 조합 중에는 세지 않는다
        // (조합 중에 꾸밈을 바꾸면 입력기 글자가 깨질 수 있다).
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const recount = () => {
            if (view.composing) {
              timer = setTimeout(recount, RECOUNT_MS);
              return;
            }
            timer = undefined;
            const s = findKey.getState(view.state);
            if (!s?.query || s.matchesDoc === view.state.doc) return;
            const matches = findMatches(view.state.doc, s.query);
            // 지금 일치는 가까운 자리로 둔다.
            const current = indexAfter(matches, s.matches[s.current]?.from ?? 0);
            view.dispatch(setMeta(view.state.tr, { matches, current }));
          };
          return {
            update(v, prev) {
              const s = findKey.getState(v.state);
              // 바꾸기는 새 문서로 센 일치를 함께 보내므로 다시 세지 않는다.
              if (v.state.doc === prev.doc || !s?.query || s.matchesDoc === v.state.doc) return;
              clearTimeout(timer);
              timer = setTimeout(recount, RECOUNT_MS);
            },
            destroy: () => clearTimeout(timer),
          };
        },
      }),
    ];
  },
});

export type FindResult = { total: number; current: number };

/** 개수 칸·낭독에 쓰는 지금 상태. */
export const findResult = (state: EditorState): FindResult => {
  const s = findKey.getState(state);
  return { total: s?.matches.length ?? 0, current: s?.current ?? -1 };
};
const result = (view: EditorView) => findResult(view.state);

/** 일치가 없을 때: 강조를 지우고 찾는 말만 기억한다. */
function noMatches(view: EditorView, query: string) {
  view.dispatch(setMeta(view.state.tr, { query, matches: [], current: -1 }));
}

/** 찾는 말로 새로 찾는다. 지금 일치는 origin 뒤의 첫 일치(dir < 0이면 앞의 마지막). 찾는 말이 비면 강조를 지운다. */
export function runFind(view: EditorView, raw: string, origin: number, dir: 1 | -1 = 1): FindResult {
  const query = normalizeQuery(raw);
  const matches = findMatches(view.state.doc, query);
  const current = !matches.length ? -1 : dir > 0 ? indexAfter(matches, origin) : indexBefore(matches, origin);
  view.dispatch(setMeta(view.state.tr, { query, matches, current }));
  revealCurrent(view);
  return result(view);
}

/** 지금 일치를 앞뒤로 옮긴다. 끝에서 처음으로, 처음에서 끝으로 돌아간다. */
export function moveFind(view: EditorView, dir: 1 | -1): FindResult {
  const s = findKey.getState(view.state);
  const n = s?.matches.length ?? 0;
  if (!s || !n) return result(view);
  view.dispatch(setMeta(view.state.tr, { current: (s.current + dir + n) % n }));
  revealCurrent(view);
  return result(view);
}

/** 강조를 모두 지운다. 지금 일치가 있으면 그 글을 선택한다(닫기, S-14). */
export function clearFind(view: EditorView) {
  const s = findKey.getState(view.state);
  const cur = s?.matches[s.current];
  const tr = setMeta(view.state.tr, { query: "", matches: [], current: -1 });
  if (cur && cur.from < cur.to) tr.setSelection(TextSelection.create(tr.doc, cur.from, cur.to));
  view.dispatch(tr);
}

/** 바뀐 글 전체가 일치 첫 글자의 서식을 따른다. 빈 말이면 일치를 지운다. */
function replaceRange(tr: Transaction, r: Range, text: string) {
  if (!text) {
    tr.delete(r.from, r.to);
    return;
  }
  const marks = tr.doc.nodeAt(r.from)?.marks ?? [];
  tr.replaceWith(r.from, r.to, tr.doc.type.schema.text(text, marks));
}

/** 바꾸기는 앞뒤의 다른 편집과 실행 취소 묶음을 합치지 않는다(F-03, history 500ms 묶음을 끊는다). */
function dispatchReplace(view: EditorView, tr: Transaction) {
  closeHistory(tr);
  view.dispatch(tr);
  view.dispatch(closeHistory(view.state.tr));
}

/**
 * 지금 일치 하나를 바꾸고, 바꾼 글 바로 뒤의 다음 일치를 지금 일치로 삼는다(바꾼 글 안은 다시 보지 않는다).
 * 미뤄 둔 다시 세기를 기다리지 않고 그 자리에서 다시 센 뒤 바꾼다. 일치가 없으면 바꾸지 않고 null.
 */
export function replaceCurrent(view: EditorView, raw: string, text: string, origin: number): FindResult | null {
  const query = normalizeQuery(raw);
  const { state } = view;
  const old = findKey.getState(state);
  // 이 문서로 이미 세어 두었으면 다시 세지 않는다.
  const fresh = old?.query === query && old.matchesDoc === state.doc;
  const matches = fresh ? old.matches : findMatches(state.doc, query);
  if (!matches.length) {
    noMatches(view, query);
    return null;
  }
  const prev = old?.query === query ? old.matches[old.current] : undefined;
  const target = matches[indexAfter(matches, prev ? prev.from : origin)];
  const tr = state.tr;
  replaceRange(tr, target, text);
  const after = findMatches(tr.doc, query);
  tr.setMeta(findKey, { query, matches: after, current: indexAfter(after, target.from + text.length) });
  dispatchReplace(view, tr);
  revealCurrent(view);
  return result(view);
}

/** 본문의 모든 일치를 거래 하나로 바꾼다(Ctrl+Z 한 번에 되돌림). 바꾼 수를 돌려준다. */
export function replaceAll(view: EditorView, raw: string, text: string): number {
  const query = normalizeQuery(raw);
  const { state } = view;
  const matches = findMatches(state.doc, query);
  if (!matches.length) {
    noMatches(view, query);
    return 0;
  }
  // 뒤에서부터 바꿔 앞 일치의 자리가 밀리지 않게 한다. 일치마다 한 단계씩 보내면 단계 수만큼
  // 모든 플러그인이 자리를 옮겨 5,000개에 1초가 넘게 걸린다. 그래서 따로 바꿔 본 결과에서
  // 첫 일치~끝 일치 구간을 떼어 한 단계로 갈아 끼운다.
  const draft = state.tr;
  for (let i = matches.length - 1; i >= 0; i--) replaceRange(draft, matches[i], text);
  const from = matches[0].from;
  const to = matches[matches.length - 1].to;
  const tr = state.tr.replace(from, to, draft.doc.slice(from, draft.mapping.map(to)));
  // 한 단계로 갈아 끼우면 구간 안의 커서가 구간 끝으로 밀리므로, 일치마다 바꾼 결과로 옮긴 자리에 둔다.
  tr.setSelection(state.selection.map(tr.doc, draft.mapping));
  const after = findMatches(tr.doc, query);
  tr.setMeta(findKey, { query, matches: after, current: after.length ? 0 : -1 });
  dispatchReplace(view, tr);
  return matches.length;
}

/** 지금 일치가 보이는 영역(막대 아래 16px ~ 편집 영역 아래 16px 위) 밖이면 1/3 높이에 오게 바로 스크롤한다. */
function revealCurrent(view: EditorView) {
  const s = findKey.getState(view.state);
  const r = s?.matches[s.current];
  if (r) scrollToRange(view, r);
}

/** 편집기 고정 머리(도구 막대 + 열린 찾기 막대). root는 .editor 또는 그 위. */
function stickyHeads(root: Element) {
  const editor = root.matches(".editor") ? root : root.querySelector(".editor");
  return editor ? [...editor.querySelectorAll<HTMLElement>(":scope > .editor-toolbar, :scope > .find-bar")] : [];
}

/** 고정 머리의 지금 아래 끝(화면 좌표). 머리가 없으면 floor. */
export function stickyBottom(root: Element, floor: number) {
  return stickyHeads(root).reduce((bottom, el) => Math.max(bottom, el.getBoundingClientRect().bottom), floor);
}

function scrollToRange(view: EditorView, r: Range) {
  const scroller = view.dom.closest(".content");
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  // 스크롤한 뒤의 머리 자리로 잰다: 아직 붙지 않은 머리는 스크롤하면 위 끝에 붙는다(머리는 위에서부터 이어 붙는다).
  const top = box.top + stickyHeads(scroller).reduce((h, el) => h + el.offsetHeight, 0) + SCROLL_INSET;
  const bottom = box.bottom - SCROLL_INSET;
  const start = view.coordsAtPos(r.from, 1);
  const end = view.coordsAtPos(r.to, -1);
  if (start.top < top || end.bottom > bottom) scroller.scrollTop += start.top - (top + (bottom - top) / 3);
  // 코드 블록·넓은 표는 가로로도 맞춘다.
  const { node } = view.domAtPos(r.from);
  const wide = (node instanceof Element ? node : node.parentElement)?.closest("pre, .tableWrapper");
  if (wide && wide.scrollWidth > wide.clientWidth) {
    const b = wide.getBoundingClientRect();
    if (start.left < b.left || end.right > b.right) wide.scrollLeft += start.left - b.left - b.width / 3;
  }
}

/**
 * 검색 결과로 연 페이지에서 첫 일치로 커서를 옮겨 스크롤하고 1.5초 옅게 강조한다(F-04, 막대는 열지 않는다).
 * 본문에 일치가 없으면 false(부르는 쪽이 맨 위를 연다).
 */
export function revealFirstMatch(editor: Editor, raw: string): boolean {
  const view = editor.view;
  // 여러 낱말로 찾았으면 어느 낱말이든 본문에서 가장 먼저 나오는 일치 하나(pm 결정 5).
  let first: Range | undefined;
  for (const word of normalizeQuery(raw).split(/\s+/)) {
    const m = word ? findMatches(view.state.doc, word)[0] : undefined;
    if (m && (!first || m.from < first.from || (m.from === first.from && m.to > first.to))) first = m;
  }
  if (!first) return false;
  view.dispatch(
    setMeta(view.state.tr, { flash: first }).setSelection(TextSelection.create(view.state.doc, first.from)),
  );
  // 찾기 막대가 열려 있어도 지금 일치가 아니라 검색 결과 자리로 스크롤한다.
  scrollToRange(view, first);
  // 1.5초 안에 다시 열면 앞의 끄기를 버린다(새 강조가 일찍 꺼지지 않게).
  clearTimeout(flashTimers.get(view));
  flashTimers.set(
    view,
    setTimeout(() => {
      flashTimers.delete(view);
      if (!editor.isDestroyed) view.dispatch(setMeta(view.state.tr, { flash: null }));
    }, FLASH_MS),
  );
  return true;
}
const flashTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

// ── 막대 상태(앱을 켜 둔 동안 기억) ──

export type FindCommand = "find" | "replace" | "next" | "prev";

/** 찾는 말·바꿀 말·펼침은 앱을 켜 둔 동안, 열림은 페이지를 바꿔도 이어진다(F-11). */
export const findSession = { open: false, expanded: false, query: "", replacement: "" };

const commandListeners = new Set<(c: FindCommand) => void>();

/** 앱 단축키(Ctrl+F·Ctrl+H·F3·Ctrl+G)를 열린 페이지의 찾기 막대에 보낸다. 받을 막대가 없으면 false. */
export function sendFindCommand(c: FindCommand) {
  commandListeners.forEach((l) => l(c));
  return commandListeners.size > 0;
}

export function onFindCommand(l: (c: FindCommand) => void) {
  commandListeners.add(l);
  return () => void commandListeners.delete(l);
}
