// 페이지별 실행 취소 기록 옮기기(P7-8, F-03) 확인 스크립트.
// prosemirror-history의 내보내지 않는 구조(키 이름·생성자·RopeSequence)에 기대므로, 판이 바뀌어 모양이 달라지면 여기서 깨진다.
// 실행: node scripts/check-undo-keep.ts
import assert from "node:assert/strict";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { closeHistory, history, redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import { packHistory, unpackHistory } from "../src/app/undoKeep.ts";

let n = 0;
const check = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("ok", name);
};

// 편집기마다 스키마가 새로 만들어지는 것처럼 같은 정의로 두 번 만든다.
const spec = {
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] as const },
    text: {},
  },
  marks: { strong: { toDOM: () => ["strong", 0] as const } },
};
const schemaA = new Schema(spec);
const schemaB = new Schema(spec);
const docJSON = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "본문" }] }] };

const make = (schema: Schema) => EditorState.create({ schema, doc: schema.nodeFromJSON(docJSON), plugins: [history()] });
const run = (state: EditorState, cmd: (s: EditorState, d: (tr: Transaction) => void) => boolean) => {
  let next = state;
  cmd(state, (tr) => (next = state.apply(tr)));
  return next;
};
const type = (state: EditorState, text: string) => state.apply(state.tr.insertText(text, state.doc.content.size - 1));
const text = (state: EditorState) => state.doc.textContent;

// A 편집기: 세 번 고친다(묶음 3개). 하나는 굵게.
let a = make(schemaA);
a = type(a, "1");
a = a.apply(closeHistory(a.tr));
a = type(a, "2");
a = a.apply(closeHistory(a.tr));
a = a.apply(a.tr.addMark(1, 3, schemaA.marks.strong.create()));
a = run(a, undo); // 굵게를 되돌려 다시 실행 기록도 하나 둔다.

check("빈 기록은 들고 있지 않는다", () => {
  assert.equal(packHistory(make(schemaA)), null);
});

check("기록 플러그인이 없으면 null", () => {
  const plain = EditorState.create({ schema: schemaA, doc: schemaA.nodeFromJSON(docJSON) });
  assert.equal(packHistory(plain), null);
  const packed = packHistory(a)!;
  assert.equal(unpackHistory(packed, plain), null);
});

check("푼 기록은 스키마 노드를 들고 있지 않는다(JSON)", () => {
  const packed = packHistory(a)!;
  assert.ok(packed);
  const steps = packed.branches.flatMap((b) => b.items.map((i) => i.step)).filter((s) => s !== undefined);
  assert.ok(steps.length >= 3);
  for (const s of steps) assert.doesNotThrow(() => JSON.stringify(s));
  assert.equal(JSON.stringify(steps).includes("schema"), false);
});

check("새 스키마의 편집기로 옮기면 되돌리기·다시 실행이 이어진다", () => {
  const before = { undo: undoDepth(a), redo: redoDepth(a), text: text(a) };
  const packed = packHistory(a)!;
  let b = EditorState.create({ schema: schemaB, doc: schemaB.nodeFromJSON(a.doc.toJSON()), plugins: [history()] });
  assert.equal(undoDepth(b), 0);
  const tr = unpackHistory(packed, b)!;
  assert.ok(tr);
  b = b.apply(tr);
  assert.equal(b.doc.eq(schemaB.nodeFromJSON(a.doc.toJSON())), true, "본문은 바뀌지 않는다");
  assert.equal(undoDepth(b), before.undo);
  assert.equal(redoDepth(b), before.redo);
  // 다시 실행: 굵게가 돌아온다(B 스키마의 마크로).
  const r = run(b, redo);
  assert.equal(r.doc.rangeHasMark(1, 3, schemaB.marks.strong), true);
  // 되돌리기 두 번: "2", "1" 순서로 사라진다.
  b = run(b, undo);
  assert.equal(text(b), "본문1");
  b = run(b, undo);
  assert.equal(text(b), "본문");
  assert.equal(undoDepth(b), 0);
  // 원래 상태는 그대로다(옮기며 고쳐 쓰지 않는다).
  assert.deepEqual({ undo: undoDepth(a), redo: redoDepth(a), text: text(a) }, before);
  assert.equal(text(run(a, undo)), "본문1");
});

check("옮긴 뒤 입력은 옛 묶음에 합쳐지지 않는다", () => {
  let b = make(schemaB);
  b = EditorState.create({ schema: schemaB, doc: schemaB.nodeFromJSON(a.doc.toJSON()), plugins: [history()] });
  b = b.apply(unpackHistory(packHistory(a)!, b)!);
  b = type(b, "3");
  b = run(b, undo);
  assert.equal(text(b), "본문12", "새 입력만 되돌린다");
});

check("새 스키마에 없는 마크가 든 기록은 버린다", () => {
  const narrow = new Schema({ nodes: spec.nodes });
  const c = EditorState.create({ schema: narrow, doc: narrow.nodeFromJSON(a.doc.toJSON()), plugins: [history()] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(unpackHistory(packHistory(a)!, c), null);
  } finally {
    console.warn = warn;
  }
});

console.log(`모두 통과 (${n})`);
