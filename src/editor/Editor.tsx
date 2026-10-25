import { useRef, useState } from "react";
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor as TiptapEditor,
  type FocusPosition,
  type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import FileHandler from "@tiptap/extension-file-handler";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { CODE_LANGUAGES, lowlight } from "./lowlight";
import { IMAGE_TYPES, WyImage } from "./image";
import { BlockMove } from "./blockMove";
import { SlashCommand } from "./slashMenu";
import { BlockHandle } from "./BlockHandle";
import { EmptyParagraphHint } from "./placeholder";
import { UploadPlaceholder, addUploadPlaceholder, removeUploadPlaceholder } from "./uploadPlaceholder";
import "highlight.js/styles/github.css";
import "./Editor.css";

/** 빈 문서 기본값(DB 계약과 같은 값). */
export const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

type EditorProps = {
  /** 처음 보여 줄 본문(TipTap JSON). 없으면 EMPTY_DOC. */
  content?: JSONContent;
  /** 본문이 바뀔 때마다 editor.getJSON() 결과를 그대로 넘긴다(DB에 저장하는 형식). 저장 연결은 아직 없다. */
  onChange?: (doc: JSONContent) => void;
  /**
   * 이미지 파일을 첨부 폴더에 저장하고 저장된 파일 이름을 돌려준다(F-02.6, D-17).
   * 이미지 노드의 src에는 이 파일 이름만 들어간다. 없으면 이미지를 넣을 수 없다.
   */
  onImageUpload?: (file: File) => Promise<string>;
  /**
   * 처음 만들 때 커서를 둘 곳. 기본 "end"(본문 끝). 페이지 제목에 커서를 둘 때는 false.
   * 만들 때 한 번만 읽는다.
   */
  autofocus?: FocusPosition;
};

const SAVING = "이미지 저장 중…";

type ImageHandlers = {
  insert: (editor: TiptapEditor, files: File[], pos?: number) => void;
  canInsert: () => boolean;
  pick: () => void;
};

// 렌더마다 새로 만들면 useEditor가 옵션이 바뀐 것으로 보고 setOptions를 다시 부르므로 편집기마다 한 번만 만든다.
// 바뀔 수 있는 값(콜백)은 handlers 안에서 ref로 읽는다.
const createExtensions = (handlers: ImageHandlers) => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    codeBlock: false,
    // 링크는 보존하되 클릭으로 WebView가 외부 주소로 이동하지 않게 한다(NF-06).
    link: { openOnClick: false },
    // 블록을 끌 때 놓일 자리를 보여 준다.
    dropcursor: { color: "var(--color-drop-indicator)", width: 2 },
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
  WyImage,
  FileHandler.configure({
    allowedMimeTypes: IMAGE_TYPES,
    // 붙여넣은 파일을 다른 붙여넣기 처리가 한 번 더 넣지 않게 한다.
    consumePasteEvent: true,
    onPaste: (editor, files, html) => {
      // 워드·엑셀에서 복사하면 글과 함께 그 모습을 찍은 그림도 실린다. 글이 있으면 글을 붙여 넣는다.
      if (html && new DOMParser().parseFromString(html, "text/html").body.textContent?.trim()) {
        editor.view.pasteHTML(html);
      } else {
        handlers.insert(editor, files);
      }
    },
    onDrop: (editor, files, pos) => handlers.insert(editor, files, pos),
  }),
  UploadPlaceholder,
  EmptyParagraphHint,
  BlockMove,
  SlashCommand.configure({ canInsertImage: handlers.canInsert, pickImage: handlers.pick }),
];

const EDITOR_PROPS = {
  attributes: { class: "editor-body", "aria-label": "노트 본문", spellcheck: "false" },
};

export function Editor({ content = EMPTY_DOC, onChange, onImageUpload, autofocus = "end" }: EditorProps) {
  const uploadRef = useRef(onImageUpload);
  uploadRef.current = onImageUpload;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("");
  // 저장 중인 묶음 수. 여러 번 넣을 때 먼저 끝난 쪽이 "저장 중" 알림을 지우지 않게 한다.
  const pendingRef = useRef(0);

  const [handlers] = useState<ImageHandlers>(() => ({
    canInsert: () => !!uploadRef.current,
    pick: () => fileInputRef.current?.click(),
    insert: async (editor, files, pos) => {
      const upload = uploadRef.current;
      if (!upload) {
        setStatus("이미지를 저장할 곳이 없어 넣지 않았습니다.");
        return;
      }
      pendingRef.current += 1;
      setStatus(SAVING);
      // 저장하는 동안 놓을 자리에 회색 상자를 둔다. 상자는 그동안의 편집을 따라 옮겨진다.
      // 넣은 이미지는 선택된 채로 남는다. 이어 붙여넣은 이미지가 그것을 덮어쓰지 않게 블록이 선택돼 있으면 그 뒤에 둔다.
      const { selection } = editor.state;
      const spot = pos ?? (selection instanceof NodeSelection ? selection.to : selection.from);
      const placeholder = addUploadPlaceholder(editor.view, spot, files);
      // 한 장이 실패해도 저장된 것은 넣는다(넣지 않으면 저장된 파일만 남는다).
      const results = await Promise.allSettled(files.map(async (f) => upload(f)));
      pendingRef.current -= 1;
      if (editor.isDestroyed) return;
      const at = removeUploadPlaceholder(editor.view, placeholder);

      const names = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (names.length) {
        // 여러 장도 실행 취소 한 번에 되돌린다.
        const nodes = names.map((name) => ({ type: "image", attrs: { src: name } }));
        // 자리가 지워졌으면 지금 커서 자리에 넣는다.
        const chain = editor.chain().focus();
        if (at === undefined) chain.insertContent(nodes);
        else chain.insertContentAt(Math.min(at, editor.state.doc.content.size), nodes);
        chain.run();
      }

      const failed = results.find((r) => r.status === "rejected");
      if (failed) {
        const reason = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
        const what = files.length > 1 ? `이미지 ${files.length}장 중 ${files.length - names.length}장을` : "이미지를";
        setStatus(`${what} 저장하지 못했습니다(${reason}). 그 이미지를 다시 넣어 보세요.`);
      } else if (pendingRef.current === 0) {
        // 다른 묶음의 실패 알림은 지우지 않는다.
        setStatus((s) => (s === SAVING ? "" : s));
      }
    },
  }));
  const [extensions] = useState(() => createExtensions(handlers));

  const editor = useEditor({
    extensions,
    content,
    autofocus,
    editorProps: EDITOR_PROPS,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
  });

  return (
    <div className="editor">
      <Toolbar editor={editor} canInsertImage={!!onImageUpload} onPickImage={handlers.pick} />
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_TYPES.join(",")}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ""; // 같은 파일을 다시 고를 수 있게 비운다.
          if (files.length) handlers.insert(editor, files);
        }}
      />
      <div className="editor-content" ref={wrapRef}>
        <BlockHandle editor={editor} wrapRef={wrapRef} />
        <EditorContent editor={editor} />
      </div>
      <p className="editor-status" role="status">
        {status}
      </p>
    </div>
  );
}

function Toolbar({
  editor,
  canInsertImage,
  onPickImage,
}: {
  editor: TiptapEditor;
  canInsertImage: boolean;
  onPickImage: () => void;
}) {
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
      <div className="editor-toolbar-group">
        <ToolButton label="이미지 넣기" disabled={!canInsertImage} onClick={onPickImage} />
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
