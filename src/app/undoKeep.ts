// 페이지마다 실행 취소 기록을 따로 둔다(F-03). 편집기는 페이지를 바꿀 때마다 새로 만들어지므로,
// 떨어질 때 기록을 들고 있다가 같은 페이지의 새 편집기가 붙을 때 옮겨 준다.
// [pm 결정] 최근 연 페이지 10개(지금 연 페이지 포함)까지만, 휴지통으로 간 페이지는 버린다. 앱을 다시 켜면 비어 있다.
//
// 편집기 상태(EditorState)를 통째로 들고 있다가 다시 쓰지 않는 까닭: 상태는 옛 편집기의 스키마·플러그인에 묶여 있어
// 새 편집기에 넣으면 노드 종류가 어긋나고, 들고 있는 동안 파괴된 편집기 전체가 메모리에 남는다.
// 그래서 기록(prosemirror-history의 상태)만 스키마와 상관없는 값(단계는 JSON)으로 풀어 두고, 새 스키마로 다시 짓는다.
// prosemirror-history가 내보내지 않는 내부 구조에 기대므로 scripts/check-undo-keep.ts가 그 모양을 확인한다.
import type { Schema } from "@tiptap/pm/model";
import type { EditorState, Plugin } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import type { EditorInstance } from "../editor/Editor";
import type { PageId } from "../lib/db-types";

export const UNDO_KEEP_MAX = 10;

// prosemirror-history 내부(1.x): HistoryState(done, undone, prevRanges, prevTime, prevComposition),
// Branch(items: RopeSequence<Item>, eventCount), Item(map, step, selection, mirrorOffset).
type Item = { map: unknown; step?: Step; selection?: unknown; mirrorOffset?: number };
type Rope = { forEach(f: (item: Item) => void): void; slice(from: number, to: number): Rope; append(items: Item[]): Rope };
type Branch = { items: Rope; eventCount: number };
type HistoryState = { done: Branch; undone: Branch };
type Ctor<T> = new (...args: never[]) => T;

/** 스키마에 묶이지 않은 기록. 단계는 JSON, 위치(map)·선택 북마크는 스키마와 상관없어 그대로 둔다. */
export type PackedHistory = {
  branches: { eventCount: number; items: { map: unknown; step?: unknown; selection?: unknown; mirrorOffset?: number }[] }[];
  make: { history: Ctor<HistoryState>; branch: Ctor<Branch>; item: Ctor<Item>; empty: Rope };
};

// 기록 플러그인의 키는 모듈에 하나라 이름이 "history$"다(키를 내보내지 않아 플러그인 목록에서 찾는다).
const historyPlugin = (state: EditorState): Plugin | undefined =>
  state.plugins.find((p) => (p as unknown as { key: string }).key === "history$");

/** 상태의 실행 취소 기록을 스키마와 상관없는 값으로 푼다. 기록 플러그인이 없으면 null. 원래 상태는 고치지 않는다. */
export function packHistory(state: EditorState): PackedHistory | null {
  const plugin = historyPlugin(state);
  const h = plugin?.getState(state) as HistoryState | undefined;
  if (!h) return null;
  let item: Item | undefined;
  const branches = [h.done, h.undone].map((b) => {
    const items: PackedHistory["branches"][number]["items"] = [];
    b.items.forEach((it) => {
      item ??= it;
      items.push({ map: it.map, step: it.step?.toJSON(), selection: it.selection, mirrorOffset: it.mirrorOffset });
    });
    return { eventCount: b.eventCount, items };
  });
  // 기록이 비었으면(Item이 하나도 없으면) 들고 있을 것이 없다.
  if (!item) return null;
  return {
    branches,
    make: {
      history: h.constructor as Ctor<HistoryState>,
      branch: h.done.constructor as Ctor<Branch>,
      item: item.constructor as Ctor<Item>,
      empty: h.done.items.slice(0, 0),
    },
  };
}

/** 푼 기록을 새 스키마로 다시 지어, 새 상태에 넣을 트랜잭션을 만든다. 맞지 않으면 null. */
export function unpackHistory(packed: PackedHistory, state: EditorState) {
  const plugin = historyPlugin(state);
  if (!plugin) return null;
  const { make } = packed;
  const schema: Schema = state.schema;
  let history: HistoryState;
  try {
    const [done, undone] = packed.branches.map((b) => {
      const items = b.items.map((it) => {
        const Item = make.item as unknown as new (m: unknown, s?: Step, sel?: unknown, mo?: number) => Item;
        return new Item(it.map, it.step === undefined ? undefined : Step.fromJSON(schema, it.step), it.selection, it.mirrorOffset);
      });
      const Branch = make.branch as unknown as new (items: Rope, eventCount: number) => Branch;
      return new Branch(make.empty.append(items), b.eventCount);
    });
    // 이어서 입력한 글이 옛 묶음에 합쳐지지 않게 새 묶음부터 시작한다(closeHistory와 같은 값).
    const History = make.history as unknown as new (...a: unknown[]) => HistoryState;
    history = new History(done, undone, null, 0, -1);
  } catch (e) {
    // 단계를 새 스키마로 읽지 못하면(모르는 노드·마크) 기록 없이 연다.
    console.warn("실행 취소 기록을 옮기지 못했습니다", e);
    return null;
  }
  // 기록 플러그인은 이 메타가 붙은 트랜잭션의 historyState를 그대로 제 상태로 삼는다. 본문은 바뀌지 않는다.
  return state.tr.setMeta(plugin, { historyState: history }).setMeta("addToHistory", false);
}

type Kept = { doc: string; history: PackedHistory };
// Map은 넣은 순서를 지킨다: 앞이 가장 오래 안 연 페이지.
const kept = new Map<PageId, Kept>();

const trim = (max: number) => {
  while (kept.size > max) kept.delete(kept.keys().next().value!);
};

/** 편집기가 떨어질 때: 본문과 기록을 들고 있는다. */
export function keepUndo(id: PageId, ed: EditorInstance) {
  kept.delete(id);
  const history = packHistory(ed.state);
  if (history) kept.set(id, { doc: JSON.stringify(ed.getJSON()), history });
  // 옛 편집기가 먼저 떨어지고 새 편집기가 붙는다(React는 정리를 먼저 돈다). 붙을 때 지금 페이지 몫을 비운다.
  trim(UNDO_KEEP_MAX);
}

/**
 * 같은 페이지의 새 편집기가 붙을 때: 본문이 떠날 때와 같으면 기록을 옮긴다.
 * 다른 경로로 본문이 바뀌었으면 버린다(기록의 위치가 맞지 않는다).
 */
export function restoreUndo(id: PageId, ed: EditorInstance) {
  const entry = kept.get(id);
  kept.delete(id);
  // 지금 연 페이지를 한 자리로 센다.
  trim(UNDO_KEEP_MAX - 1);
  if (!entry || ed.isDestroyed || JSON.stringify(ed.getJSON()) !== entry.doc) return;
  const tr = unpackHistory(entry.history, ed.state);
  if (tr) ed.view.dispatch(tr);
}

/** 트리에 없는(휴지통으로 간) 페이지의 기록을 버린다. */
export function pruneUndo(alive: (id: PageId) => boolean) {
  for (const id of [...kept.keys()]) if (!alive(id)) kept.delete(id);
}
