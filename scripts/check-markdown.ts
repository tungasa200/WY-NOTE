// 마크다운 변환(F-06) 확인 스크립트. 테스트 프레임워크 없이 Node 타입 제거 실행으로 돈다.
// 실행: node scripts/check-markdown.ts
import assert from "node:assert/strict";
import { buildExport } from "../src/export/exportTree.ts";
import { docToMarkdown, normalizeLanguage } from "../src/export/markdown.ts";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };

const t = (text: string, ...marks: (string | { type: string; attrs?: Record<string, unknown> })[]): Node => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (...content: Node[]): Node => ({ type: "paragraph", content });
const doc = (...content: Node[]): Node => ({ type: "doc", content });
const li = (...content: Node[]): Node => ({ type: "listItem", content });
const task = (checked: boolean, ...content: Node[]): Node => ({ type: "taskItem", attrs: { checked }, content });
const code = (language: string | null, text: string): Node => ({ type: "codeBlock", attrs: { language }, content: text ? [t(text)] : [] });
const cell = (type: "tableHeader" | "tableCell", ...content: Node[]): Node => ({ type, content });
const row = (...content: Node[]): Node => ({ type: "tableRow", content });
const img = (src: string, alt = ""): Node => ({ type: "image", attrs: { src, alt } });

const cases: { name: string; input: Node; expected: string; images?: string[]; warnings?: string[] }[] = [
  {
    name: "F-02.1 제목 1·2·3",
    input: doc(
      { type: "heading", attrs: { level: 1 }, content: [t("하나")] },
      { type: "heading", attrs: { level: 2 }, content: [t("둘")] },
      { type: "heading", attrs: { level: 3 }, content: [t("셋")] },
    ),
    expected: "# 하나\n\n## 둘\n\n### 셋\n",
  },
  {
    name: "문단 서식: 굵게·기울임·취소선·인라인 코드·링크, 이어지는 서식은 한 번만",
    input: doc(
      p(
        t("굵", "bold"),
        t("게", "bold", "italic"),
        t(" 보통 "),
        t("취소", "strike"),
        t(" "),
        t("a`b", "code"),
        t(" "),
        t("링크", { type: "link", attrs: { href: "https://example.com/a b" } }),
      ),
    ),
    expected: "**굵*게*** 보통 ~~취소~~ ``a`b`` [링크](https://example.com/a%20b)\n",
  },
  {
    name: "서식 앞뒤 공백은 서식 밖으로",
    input: doc(p(t("a"), t(" 굵게 ", "bold"), t("b"))),
    expected: "a **굵게** b\n",
  },
  {
    name: "글자 이스케이프(줄 머리 기호·별표·꺾쇠·엔티티)",
    input: doc(p(t("# 해시 *별* <b> &amp; 1. 아님")), p(t("1. 번호 아님")), p(t("- 목록 아님"))),
    expected: "\\# 해시 \\*별\\* \\<b\\> \\&amp; 1. 아님\n\n1\\. 번호 아님\n\n\\- 목록 아님\n",
  },
  {
    name: "줄바꿈(hardBreak)은 백슬래시 줄바꿈",
    input: doc(p(t("첫 줄"), { type: "hardBreak" }, t("둘째 줄"))),
    expected: "첫 줄\\\n둘째 줄\n",
  },
  {
    name: "문단 끝 줄바꿈은 버린다(홀로 남은 \\ 방지)",
    input: doc(p(t("a"), { type: "hardBreak" }, { type: "hardBreak" }), p(t("b"))),
    expected: "a\n\nb\n",
  },
  {
    name: "빈 문단은 건너뛴다",
    input: doc(p(t("a")), { type: "paragraph" }, p(t("b"))),
    expected: "a\n\nb\n",
  },
  {
    name: "F-02.2 글머리·번호 목록, 들여쓰기 수준",
    input: doc(
      { type: "bulletList", content: [li(p(t("가")), { type: "bulletList", content: [li(p(t("가-1")))] }), li(p(t("나")))] },
      { type: "orderedList", attrs: { start: 1 }, content: [li(p(t("하나")), { type: "orderedList", attrs: { start: 1 }, content: [li(p(t("하나-1")))] }), li(p(t("둘")))] },
    ),
    expected: "- 가\n  - 가-1\n- 나\n\n1. 하나\n   1. 하나-1\n2. 둘\n",
  },
  {
    name: "연달은 체크리스트·글머리 목록은 합쳐지지 않게 끊는다",
    input: doc(
      { type: "taskList", content: [task(false, p(t("할 일")))] },
      { type: "bulletList", content: [li(p(t("글머리")))] },
      { type: "orderedList", attrs: { start: 1 }, content: [li(p(t("번호")))] },
    ),
    expected: "- [ ] 할 일\n\n<!-- -->\n\n- 글머리\n\n1. 번호\n",
  },
  {
    name: "번호 목록 시작 번호",
    input: doc({ type: "orderedList", attrs: { start: 9 }, content: [li(p(t("a"))), li(p(t("b")))] }),
    expected: "9. a\n10. b\n",
  },
  {
    name: "F-02.3 체크리스트(중첩 포함)",
    input: doc({
      type: "taskList",
      content: [task(true, p(t("끝남"))), task(false, p(t("할 일")), { type: "taskList", content: [task(false, p(t("하위")))] })],
    }),
    expected: "- [x] 끝남\n- [ ] 할 일\n  - [ ] 하위\n",
  },
  {
    name: "F-02.4 코드 블록 언어 정규화(js → javascript)",
    input: doc(code("js", "let a = 1;\nconsole.log(a);"), code("TS", "x"), code("unknownlang", "y"), code(null, "z")),
    expected: "```javascript\nlet a = 1;\nconsole.log(a);\n```\n\n```typescript\nx\n```\n\n```unknownlang\ny\n```\n\n```\nz\n```\n",
  },
  {
    name: "코드 안의 백틱 3개는 더 긴 펜스로 감싼다",
    input: doc(code("markdown", "```js\nx\n```")),
    expected: "````markdown\n```js\nx\n```\n````\n",
  },
  {
    name: "목록 안 코드 블록 들여쓰기",
    input: doc({ type: "bulletList", content: [li(p(t("a")), code("bash", "ls\n\npwd"))] }),
    expected: "- a\n\n  ```bash\n  ls\n\n  pwd\n  ```\n",
  },
  {
    name: "F-02.5 표(GFM), 셀의 | 이스케이프, 여러 문단은 <br>",
    input: doc({
      type: "table",
      content: [
        row(cell("tableHeader", p(t("이름"))), cell("tableHeader", p(t("값|단위")))),
        row(cell("tableCell", p(t("a")), p(t("a2"))), cell("tableCell", p(t("1", "bold")))),
        row(cell("tableCell", p()), cell("tableCell", p(t("2")))),
      ],
    }),
    expected: "| 이름 | 값\\|단위 |\n| --- | --- |\n| a<br>a2 | **1** |\n|  | 2 |\n",
    warnings: [],
  },
  {
    name: "표 셀 안의 목록은 글로 바뀌고 알린다",
    input: doc({
      type: "table",
      content: [
        row(cell("tableHeader", p(t("h")))),
        row(cell("tableCell", { type: "bulletList", content: [li(p(t("x"))), li(p(t("y")))] })),
      ],
    }),
    expected: "| h |\n| --- |\n| x<br>y |\n",
    warnings: ["tableCellBlock:1"],
  },
  {
    name: "합친 셀은 빈 칸으로 채우고 알린다",
    input: doc({
      type: "table",
      content: [
        row({ type: "tableHeader", attrs: { colspan: 2 }, content: [p(t("합침"))] }),
        row(cell("tableCell", p(t("a"))), cell("tableCell", p(t("b")))),
      ],
    }),
    expected: "| 합침 |  |\n| --- | --- |\n| a | b |\n",
    warnings: ["tableSpan:1"],
  },
  {
    name: "F-02.6 이미지: 파일 이름 기준 상대 경로, 목록 수집(중복 없음)",
    input: doc(img("12.png", "그림 *하나*"), p(t("글")), img("12.png"), img("7.jpg")),
    expected: "![그림 \\*하나\\*](images/12.png)\n\n글\n\n![](images/12.png)\n\n![](images/7.jpg)\n",
    images: ["12.png", "7.jpg"],
  },
  {
    name: "밑줄은 마크다운에 없어 알린다",
    input: doc(p(t("밑줄", "underline"))),
    expected: "밑줄\n",
    warnings: ["underline:1"],
  },
  {
    name: "인용·구분선",
    input: doc({ type: "blockquote", content: [p(t("인용")), p(t("둘째"))] }, { type: "horizontalRule" }),
    expected: "> 인용\n>\n> 둘째\n\n---\n",
  },
  {
    name: "빈 문서",
    input: doc({ type: "paragraph" }),
    expected: "",
  },
];

let failed = 0;
for (const c of cases) {
  try {
    const r = docToMarkdown(c.input);
    assert.equal(r.markdown, c.expected);
    if (c.images) assert.deepEqual(r.images, c.images);
    if (c.warnings) assert.deepEqual(r.warnings.map((w) => `${w.kind}:${w.count}`), c.warnings);
    console.log(`ok   ${c.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}\n${(e as Error).message}`);
  }
}

// 이미지 폴더 옵션: 공백·괄호·한글은 경로에서 인코딩한다.
try {
  const r = docToMarkdown(doc(img("3.png")), { imageDir: "회의 (1)/" });
  assert.equal(r.markdown, "![](%ED%9A%8C%EC%9D%98%20%281%29/3.png)\n");
  console.log("ok   이미지 폴더 경로 인코딩");
} catch (e) {
  failed++;
  console.log(`FAIL 이미지 폴더 경로 인코딩\n${(e as Error).message}`);
}

// 내보내기 묶음(계약-AI 5.2·5.3): 깊이 d의 페이지는 ../×d + images/, 첨부 이름 모양만 attachments로, 알림은 더한다.
{
  const pages: Record<number, { title: string; children: number[]; doc: Node }> = {
    1: { title: "위", children: [2], doc: doc(img("1.png"), p(t("밑", "underline"))) },
    2: { title: "가운데 (2)", children: [3], doc: doc(img("1.png"), img("2.jpg")) },
    3: { title: "아래", children: [], doc: doc(img("3 a.png"), p(t("밑", "underline"))) },
  };
  const src = {
    childrenOf: (id: number) => pages[id].children.map((c) => ({ id: c })),
    getPage: async (id: number) => ({ title: pages[id].title, content: pages[id].doc }),
  };
  const progress: string[] = [];
  const all = await buildExport(src, 1, true, (d, n) => progress.push(`${d}/${n}`));
  const only = await buildExport(src, 1, false);
  const checks: [string, () => void][] = [
    ["깊이별 이미지 경로", () => {
      assert.equal(all.request.root.markdown, "![](images/1.png)\n\n밑\n");
      assert.equal(all.request.root.children[0].markdown, "![](../images/1.png)\n\n![](../images/2.jpg)\n");
      assert.equal(all.request.root.children[0].children[0].markdown, "![](../../images/3%20a.png)\n\n밑\n");
    }],
    ["트리 모양·제목 그대로", () => {
      assert.equal(all.request.root.children[0].title, "가운데 (2)");
      assert.equal(all.request.root.children[0].children[0].pageId, 3);
      assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
    }],
    ["첨부 이름 모양만 보낸다", () => {
      assert.deepEqual(all.request.attachments, ["1.png", "2.jpg"]);
      assert.deepEqual(all.skippedImages, ["3 a.png"]);
    }],
    ["알림은 페이지를 더해 한 번", () => assert.deepEqual(all.warnings.map((w) => `${w.kind}:${w.count}`), ["underline:2"])],
    ["하위 제외", () => {
      assert.deepEqual(only.request.root.children, []);
      assert.deepEqual(only.request.attachments, ["1.png"]);
    }],
  ];
  for (const [name, fn] of checks) {
    try {
      fn();
      console.log(`ok   내보내기 묶음: ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL 내보내기 묶음: ${name}\n${(e as Error).message}`);
    }
  }
}

for (const [input, want] of [["js", "javascript"], ["JSX", "javascript"], ["py", "python"], ["sh", "bash"], ["html", "xml"], ["rust", "rust"], [" Go ", "go"]] as const) {
  if (normalizeLanguage(input) !== want) {
    failed++;
    console.log(`FAIL normalizeLanguage(${JSON.stringify(input)}) = ${normalizeLanguage(input)}, 기대 ${want}`);
  }
}

console.log(failed ? `\n${failed}건 실패` : `\n모두 통과`);
process.exit(failed ? 1 : 0);
