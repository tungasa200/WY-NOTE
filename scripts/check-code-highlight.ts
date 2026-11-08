// 코드 강조(P7-4) 확인 스크립트: 편집 뒤 '바뀐 블록만 다시 강조'한 결과가 문서 전체를 다시 강조한 결과와 같은지 본다.
// 실행: node scripts/check-code-highlight.ts
import assert from "node:assert/strict";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { codeHighlightPlugin } from "../src/editor/codeHighlight.ts";
import { lowlight } from "../src/editor/lowlight.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    codeBlock: { group: "block", content: "text*", code: true, attrs: { language: { default: null } } },
    text: {},
  },
});
const plugin = codeHighlightPlugin({ name: "codeBlock", lowlight, defaultLanguage: null });
const p = (text: string) => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const code = (language: string | null, text: string) => schema.node("codeBlock", { language }, [schema.text(text)]);
const JS = 'function f(a) { return a > 1 ? "yes" : 42; } // 주석';

const decos = (set: DecorationSet) =>
  set
    .find()
    .map((d) => `${d.from}-${d.to}:${(d as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`)
    .sort();
const fresh = (doc: PMNode) => decos(plugin.getState(EditorState.create({ doc, plugins: [plugin] }))!);

let failed = 0;
function check(name: string, doc: PMNode, edit: (s: EditorState) => Transaction) {
  const before = EditorState.create({ doc, plugins: [plugin] });
  const after = before.apply(edit(before));
  try {
    assert.deepEqual(decos(plugin.getState(after)!), fresh(after.doc));
    console.log(`ok   ${name}`);
  } catch {
    failed++;
    console.log(`FAIL ${name}`);
  }
}
const posOf = (doc: PMNode, k: number) => {
  let n = -1;
  let found = -1;
  doc.forEach((node, offset) => {
    if (node.type.name === "codeBlock" && ++n === k) found = offset;
  });
  return found;
};

const base = schema.node("doc", null, [p("앞 문단"), code("javascript", JS), p("가운데"), code("python", "def g(x):\n    return 'a' + str(x)"), code("json", '{"a": [1, true, null]}'), p("끝")]);

check("코드 안 입력", base, (s) => s.tr.insertText("const z = 'q';", posOf(s.doc, 0) + 10));
check("코드 안 지우기", base, (s) => s.tr.delete(posOf(s.doc, 1) + 3, posOf(s.doc, 1) + 9));
check("문단 입력(코드 강조 그대로)", base, (s) => s.tr.insertText("abc", 3));
check("언어 바꾸기 setNodeMarkup", base, (s) => s.tr.setNodeMarkup(posOf(s.doc, 0), undefined, { language: "rust" }));
check("언어 바꾸기 AttrStep", base, (s) => s.tr.setNodeAttribute(posOf(s.doc, 2), "language", "sql"));
check("언어 없음(자동 감지)", base, (s) => s.tr.setNodeAttribute(posOf(s.doc, 1), "language", null));
check("코드 블록 → 문단(setBlockType)", base, (s) => {
  const at = posOf(s.doc, 0);
  return s.tr.setBlockType(at + 1, at + 1, schema.nodes.paragraph);
});
check("문단 → 코드 블록", base, (s) => s.tr.setBlockType(2, 2, schema.nodes.codeBlock, { language: "javascript" }));
check("코드 블록을 위 문단에 합치기(join)", base, (s) => s.tr.join(posOf(s.doc, 0)));
check("코드 블록 통째로 지우기", base, (s) => {
  const at = posOf(s.doc, 1);
  return s.tr.delete(at, at + s.doc.nodeAt(at)!.nodeSize);
});
check("두 블록에 걸쳐 지우기", base, (s) => s.tr.delete(posOf(s.doc, 1) + 5, posOf(s.doc, 2) + 4));
check("블록 옮기기(같은 노드)", base, (s) => {
  const at = posOf(s.doc, 0);
  const node = s.doc.nodeAt(at)!;
  const tr = s.tr.delete(at, at + node.nodeSize);
  return tr.insert(tr.doc.content.size, node);
});
check("코드 블록 넣기", base, (s) => s.tr.insert(0, code("css", "a { color: red; }")));
check("여러 단계(곳곳 입력)", base, (s) => {
  const tr = s.tr;
  for (let i = 0; i < 50; i++) tr.insertText("x", tr.mapping.map(posOf(s.doc, i % 3) + 2));
  return tr;
});
check("문서 전체 교체", base, (s) => s.tr.replaceWith(0, s.doc.content.size, [code("bash", "echo $HOME | grep x"), p("새")]));

if (failed) {
  console.log(`\n${failed}개 실패`);
  process.exit(1);
}
console.log("\n모두 통과");
