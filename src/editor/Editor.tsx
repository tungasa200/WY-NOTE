import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { CODE_LANGUAGES, lowlight } from "./lowlight";
import "highlight.js/styles/github.css";
import "./Editor.css";

/** 빈 문서 기본값(DB 계약과 같은 값). */
export const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

type EditorProps = {
  /** 처음 보여 줄 본문(TipTap JSON). 없으면 EMPTY_DOC. */
  content?: JSONContent;
  /** 본문이 바뀔 때마다 editor.getJSON() 결과를 그대로 넘긴다(DB에 저장하는 형식). 저장 연결은 아직 없다. */
  onChange?: (doc: JSONContent) => void;
};

// 렌더마다 새로 만들면 useEditor가 옵션이 바뀐 것으로 보고 setOptions를 다시 부르므로 모듈 상수로 둔다.
const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    codeBlock: false,
    // 링크는 보존하되 클릭으로 WebView가 외부 주소로 이동하지 않게 한다(NF-06).
    link: { openOnClick: false },
  }),
  TaskList,
  TaskItem.configure({
    nested: true,
    a11y: {
      checkboxLabel: (node, checked) => `${checked ? "완료" : "할 일"}: ${node.textContent || "빈 항목"}`,
    },
  }),
  // 열이 많아도 셀이 뭉개지지 않게 최소 너비를 두고, 넘치면 표만 가로로 스크롤한다.
  TableKit.configure({ table: { resizable: false, cellMinWidth: 80 } }),
  CodeBlockLowlight.configure({ lowlight, enableTabIndentation: true }),
];

const EDITOR_PROPS = {
  attributes: { class: "editor-body", "aria-label": "노트 본문", spellcheck: "false" },
};

export function Editor({ content = EMPTY_DOC, onChange }: EditorProps) {
  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    autofocus: "end",
    editorProps: EDITOR_PROPS,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
  });

  return (
    <div className="editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: TiptapEditor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      paragraph: e.isActive("paragraph"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      code: e.isActive("codeBlock"),
      codeLanguage: (e.getAttributes("codeBlock").language as string | null) ?? "",
      inTable: e.isActive("table"),
      canUndo: undoDepth(e.state) > 0,
      canRedo: redoDepth(e.state) > 0,
    }),
  });
  const run = () => editor.chain().focus();

  // 버튼은 눌러도 사라지지 않고 비활성화만 되므로 포커스가 길을 잃지 않는다.
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="블록 서식">
      <div className="editor-toolbar-group">
        <ToolButton label="실행 취소" keys="Control+Z" disabled={!s.canUndo} onClick={() => run().undo().run()} />
        <ToolButton label="다시 실행" keys="Control+Y" disabled={!s.canRedo} onClick={() => run().redo().run()} />
      </div>
      <div className="editor-toolbar-group">
        <ToolButton label="본문" pressed={s.paragraph} onClick={() => run().setParagraph().run()} />
        <ToolButton label="제목 1" hint="#" pressed={s.h1} onClick={() => run().toggleHeading({ level: 1 }).run()} />
        <ToolButton label="제목 2" hint="##" pressed={s.h2} onClick={() => run().toggleHeading({ level: 2 }).run()} />
        <ToolButton label="제목 3" hint="###" pressed={s.h3} onClick={() => run().toggleHeading({ level: 3 }).run()} />
        <ToolButton label="글머리 목록" hint="-" pressed={s.bullet} onClick={() => run().toggleBulletList().run()} />
        <ToolButton label="번호 목록" hint="1." pressed={s.ordered} onClick={() => run().toggleOrderedList().run()} />
        <ToolButton label="체크리스트" hint="[]" pressed={s.task} onClick={() => run().toggleTaskList().run()} />
        <ToolButton label="코드 블록" hint="```" pressed={s.code} onClick={() => run().toggleCodeBlock().run()} />
        <select
          className="editor-select"
          aria-label="코드 언어"
          disabled={!s.code}
          value={s.codeLanguage}
          onChange={(e) => editor.commands.updateAttributes("codeBlock", { language: e.target.value || null })}
        >
          <option value="">언어 없음</option>
          {/* ```js처럼 별칭으로 만든 블록도 지금 값이 보이게 한다. */}
          {s.codeLanguage && !CODE_LANGUAGES.some((l) => l.value === s.codeLanguage) && (
            <option value={s.codeLanguage}>{s.codeLanguage}</option>
          )}
          {CODE_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="editor-toolbar-group">
        <ToolButton
          label="표 넣기"
          disabled={s.inTable}
          onClick={() => run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <ToolButton label="행 추가" disabled={!s.inTable} onClick={() => run().addRowAfter().run()} />
        <ToolButton label="행 삭제" disabled={!s.inTable} onClick={() => run().deleteRow().run()} />
        <ToolButton label="열 추가" disabled={!s.inTable} onClick={() => run().addColumnAfter().run()} />
        <ToolButton label="열 삭제" disabled={!s.inTable} onClick={() => run().deleteColumn().run()} />
        <ToolButton label="표 삭제" disabled={!s.inTable} onClick={() => run().deleteTable().run()} />
      </div>
    </div>
  );
}

type ToolButtonProps = {
  label: string;
  /** 단축키(aria-keyshortcuts 형식) */
  keys?: string;
  /** 마크다운 단축 입력 안내 */
  hint?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

function ToolButton({ label, keys, hint, pressed, disabled, onClick }: ToolButtonProps) {
  const tip = keys ? keys.replace("Control", "Ctrl") : hint ? `입력: ${hint}` : undefined;
  return (
    <button
      type="button"
      className="editor-button"
      aria-pressed={pressed}
      aria-keyshortcuts={keys}
      title={tip ? `${label} (${tip})` : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
