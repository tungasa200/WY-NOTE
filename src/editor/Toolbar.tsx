import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { CODE_LANGUAGES } from "./lowlight";
import { Icon, type IconName } from "./icons";

type Tool = {
  id: string;
  label: string;
  icon: IconName;
  /** 단축키(aria-keyshortcuts 형식) */
  keys?: string;
  /** 마크다운 단축 입력 안내 */
  hint?: string;
  act: (editor: Editor, ctx: { pickImage: () => void }) => void;
};

/** pressed가 undefined이면 켜고 끄는 도구가 아니다(실행 취소, 넣기 등). */
type ToolState = { pressed?: boolean; disabled?: boolean };

const run = (e: Editor) => e.chain().focus();

// 묶음 순서(S-06 v0.8): 기록 → 블록 종류 → 글자 서식 → 정렬 → 넣기.
const GROUPS: Tool[][] = [
  [
    { id: "undo", label: "실행 취소", icon: "undo", keys: "Control+Z", act: (e) => run(e).undo().run() },
    { id: "redo", label: "다시 실행", icon: "redo", keys: "Control+Y", act: (e) => run(e).redo().run() },
  ],
  [
    { id: "paragraph", label: "본문", icon: "text", act: (e) => run(e).setParagraph().run() },
    { id: "h1", label: "제목 1", icon: "h1", hint: "#", act: (e) => run(e).toggleHeading({ level: 1 }).run() },
    { id: "h2", label: "제목 2", icon: "h2", hint: "##", act: (e) => run(e).toggleHeading({ level: 2 }).run() },
    { id: "h3", label: "제목 3", icon: "h3", hint: "###", act: (e) => run(e).toggleHeading({ level: 3 }).run() },
    { id: "bulletList", label: "글머리 목록", icon: "list", hint: "-", act: (e) => run(e).toggleBulletList().run() },
    { id: "orderedList", label: "번호 목록", icon: "olist", hint: "1.", act: (e) => run(e).toggleOrderedList().run() },
    { id: "taskList", label: "체크리스트", icon: "todo", hint: "[]", act: (e) => run(e).toggleTaskList().run() },
    { id: "blockquote", label: "인용", icon: "quote", keys: "Control+Shift+B", act: (e) => run(e).toggleBlockquote().run() },
    { id: "codeBlock", label: "코드 블록", icon: "codeBlock", keys: "Control+Alt+C", act: (e) => run(e).toggleCodeBlock().run() },
  ],
  [
    { id: "bold", label: "굵게", icon: "bold", keys: "Control+B", act: (e) => run(e).toggleBold().run() },
    { id: "italic", label: "기울임", icon: "italic", keys: "Control+I", act: (e) => run(e).toggleItalic().run() },
    { id: "underline", label: "밑줄", icon: "underline", keys: "Control+U", act: (e) => run(e).toggleUnderline().run() },
    { id: "strike", label: "취소선", icon: "strike", keys: "Control+Shift+S", act: (e) => run(e).toggleStrike().run() },
    { id: "code", label: "인라인 코드", icon: "code", keys: "Control+E", act: (e) => run(e).toggleCode().run() },
  ],
  (
    [
      ["left", "왼쪽 정렬", "alignLeft", "Control+Shift+L"],
      ["center", "가운데 정렬", "alignCenter", "Control+Shift+E"],
      ["right", "오른쪽 정렬", "alignRight", "Control+Shift+R"],
      ["justify", "양쪽 정렬", "alignJustify", "Control+Shift+J"],
    ] as const
  ).map(([value, label, icon, keys]) => ({
    id: `align-${value}`,
    label,
    icon,
    keys,
    act: (e: Editor) => run(e).setTextAlign(value).run(),
  })),
  [
    {
      id: "table",
      label: "표 넣기",
      icon: "table",
      act: (e) => run(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    // 파일 창을 열기 전에 편집기에 포커스를 둔다. 취소하면 브라우저가 포커스를 편집기로 돌려준다(메뉴에서 골랐을 때도).
    {
      id: "image",
      label: "이미지 넣기",
      icon: "image",
      act: (e, { pickImage }) => {
        e.commands.focus();
        pickImage();
      },
    },
    { id: "rule", label: "구분선", icon: "rule", hint: "---", act: (e) => run(e).setHorizontalRule().run() },
  ],
];

const TOOLS = GROUPS.flatMap((tools, group) => tools.map((tool) => ({ tool, group })));

// 폭 계산용 크기(Editor.css의 도구 막대와 같은 값): 버튼 30, 묶음 안 간격 2, 묶음 사이 13(여백 6 + 세로선 1 + 여백 6).
const BUTTON = 30;
const GAP = 2;
const SEP = 13;
/** 늘 막대에 남는 도구 수(기록). 나머지는 끝에서부터 넣기 → 정렬 → 글자 서식 → 블록 종류 순으로 '더 보기'로 간다. */
const ALWAYS = GROUPS[0].length;

/** WIDTHS[i]: 앞에서 i+1개 도구를 한 줄에 놓은 폭. */
const WIDTHS: number[] = [];
TOOLS.forEach((t, i) => {
  WIDTHS[i] = i === 0 ? BUTTON : WIDTHS[i - 1] + BUTTON + (t.group === TOOLS[i - 1].group ? GAP : SEP);
});
/** 묶음마다 첫 도구의 TOOLS 순번. */
const STARTS = GROUPS.map((_, g) => TOOLS.findIndex((t) => t.group === g));
const MENU_ITEM = "[role^=menuitem]";

/** 안쪽 폭 avail에 들어가는 도구 수. 넘치면 '더 보기' 버튼 자리(SEP + BUTTON)를 빼고 센다. */
function fitCount(avail: number, reserve: number) {
  if (WIDTHS[TOOLS.length - 1] + reserve <= avail) return TOOLS.length;
  let n = TOOLS.length - 1;
  while (n > ALWAYS && WIDTHS[n - 1] + SEP + BUTTON + reserve > avail) n--;
  return n;
}

/** 보여 줄 단축키. 마크다운 입력이면 그 글자(prefix를 붙여서). */
function shortcut(tool: Tool, prefix = "") {
  return tool.keys ? tool.keys.replace(/Control/g, "Ctrl") : tool.hint ? `${prefix}${tool.hint}` : undefined;
}

export function Toolbar({
  editor,
  canInsertImage,
  onPickImage,
}: {
  editor: Editor;
  canInsertImage: boolean;
  onPickImage: () => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const [bulletList, orderedList, taskList, blockquote] = ["bulletList", "orderedList", "taskList", "blockquote"].map(
        (n) => e.isActive(n),
      );
      const wrapped = bulletList || orderedList || taskList || blockquote;
      const code = e.isActive("codeBlock");
      // 블록을 새로 넣는 도구는 코드 블록(쪼개진다)·표 안(셀 안에 들어간다)에서 끈다.
      // insertTable·setHorizontalRule의 can()은 이 두 곳에서도 참을 돌려줘 그것만으로는 막을 수 없다.
      const inTable = e.isActive("table");
      const noBlock = code || inTable;
      const parent = e.state.selection.$from.parent;
      // 정렬을 줄 수 있는 블록(문단·제목)일 때만 지금 정렬을 돌려준다. 값이 없으면 왼쪽.
      const align = ["paragraph", "heading"].includes(parent.type.name)
        ? ((parent.attrs.textAlign as string | null) ?? "left")
        : null;
      const tools: Record<string, ToolState> = {
        undo: { disabled: undoDepth(e.state) === 0 },
        redo: { disabled: redoDepth(e.state) === 0 },
        // 목록·인용은 안의 글 블록을 감싸므로 함께 눌릴 수 있다. '본문'은 그 밖의 문단일 때만 눌린다.
        paragraph: { pressed: e.isActive("paragraph") && !wrapped },
        h1: { pressed: e.isActive("heading", { level: 1 }) },
        h2: { pressed: e.isActive("heading", { level: 2 }) },
        h3: { pressed: e.isActive("heading", { level: 3 }) },
        bulletList: { pressed: bulletList },
        orderedList: { pressed: orderedList },
        taskList: { pressed: taskList },
        blockquote: { pressed: blockquote },
        codeBlock: { pressed: code },
        bold: { pressed: e.isActive("bold"), disabled: !e.can().toggleBold() },
        italic: { pressed: e.isActive("italic"), disabled: !e.can().toggleItalic() },
        underline: { pressed: e.isActive("underline"), disabled: !e.can().toggleUnderline() },
        strike: { pressed: e.isActive("strike"), disabled: !e.can().toggleStrike() },
        code: { pressed: e.isActive("code"), disabled: !e.can().toggleCode() },
        table: { disabled: noBlock },
        image: { disabled: !canInsertImage || noBlock },
        rule: { disabled: noBlock || !e.can().setHorizontalRule() },
      };
      for (const v of ["left", "center", "right", "justify"])
        tools[`align-${v}`] = { pressed: align === v, disabled: align === null };
      return { tools, code, codeLanguage: (e.getAttributes("codeBlock").language as string | null) ?? "" };
    },
  });

  const barRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [avail, setAvail] = useState(Infinity);
  const [selectWidth, setSelectWidth] = useState(0);

  // 좁은 창에서 AI 패널이 편집 영역 위에 겹쳐 뜨면(.ai-panel absolute) 막대가 쓸 수 있는 오른쪽 끝을 패널 왼쪽 끝으로 잡는다(pm 결정).
  // 가려진 폭은 --toolbar-cover로 오른쪽 안쪽 여백에 더해, 언어 고르기(margin-left: auto)도 패널 왼쪽에 선다.
  // 패널을 열고 닫거나 폭이 바뀌면 다시 잰다(겹침일 때는 막대 폭이 그대로라 막대만 지켜보면 놓친다).
  useLayoutEffect(() => {
    const bar = barRef.current!;
    const shell = bar.closest(".shell");
    let cover = 0;
    const measure = () => {
      const st = getComputedStyle(bar);
      const box = bar.getBoundingClientRect();
      const ai = shell?.querySelector(".ai-panel")?.getBoundingClientRect();
      const next = ai && ai.width > 0 && ai.left < box.right ? Math.min(box.width, box.right - ai.left) : 0;
      const padRight = parseFloat(st.paddingRight) - cover;
      if (next !== cover) {
        cover = next;
        // 찾기 막대(S-14)도 같은 값을 쓰게 편집기 상자에 적는다.
        bar.parentElement?.style.setProperty("--toolbar-cover", `${next}px`);
      }
      setAvail(bar.clientWidth - parseFloat(st.paddingLeft) - padRight - next);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(bar);
    let panel: Element | null = null;
    const watchPanel = () => {
      const p = shell?.querySelector(".ai-panel") ?? null;
      if (p === panel) return;
      if (panel) resize.unobserve(panel);
      panel = p;
      if (panel) resize.observe(panel);
      measure();
    };
    watchPanel();
    const mutation = new MutationObserver(watchPanel);
    if (shell) mutation.observe(shell, { childList: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  // Alt+F10(표 도구와 같은 키): 코드 블록 안에서는 Tab·Shift+Tab이 들여쓰기라 언어 고르기로 가는 키를 따로 둔다.
  // 표 셀 안의 코드 블록이면 표 도구(TableTools)의 Alt+F10에 맡긴다.
  useEffect(() => {
    if (!s.code) return;
    const dom = editor.view.dom;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "F10" || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || editor.isActive("table")) return;
      e.preventDefault();
      selectRef.current?.focus();
    };
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  }, [editor, s.code]);

  // 코드 언어 선택이 보이면 그 폭만큼 버튼을 더 접는다(언어 선택이 우선). 앞에 세로선이 없어 사이 간격은 더하지 않는다.
  useLayoutEffect(() => {
    setSelectWidth(s.code ? (selectRef.current?.offsetWidth ?? 0) : 0);
  }, [s.code, s.codeLanguage]);

  const shown = fitCount(avail, selectWidth);
  const ctx = { pickImage: onPickImage };

  // 버튼은 눌러도 사라지지 않고 비활성화만 된다. 접히고 펼쳐지는 것은 막대 폭·코드 블록 드나듦 때뿐이다.
  return (
    <div
      ref={barRef}
      className="editor-toolbar"
      role="toolbar"
      aria-label="블록 서식"
      // 버튼을 눌러도(꺼진 버튼 포함) 편집기 포커스를 빼앗지 않는다. 언어 고르기는 눌러야 열리므로 뺀다.
      // 꺼진 버튼에는 mousedown이 오지 않아 pointerdown에서 막는다(click은 그대로 온다).
      onPointerDown={(e) => {
        if (barRef.current?.contains(e.target as Node) && !(e.target as Element).closest("select")) e.preventDefault();
      }}
    >
      {GROUPS.map((tools, g) => {
        const visible = tools.slice(0, Math.max(0, shown - STARTS[g]));
        if (!visible.length) return null;
        return [
          g > 0 && <ToolbarSeparator key={`sep-${g}`} />,
          <div key={g} className="editor-toolbar-group">
            {visible.map((tool) => (
              <ToolButton key={tool.id} tool={tool} state={s.tools[tool.id]} onClick={() => tool.act(editor, ctx)} />
            ))}
          </div>,
        ];
      })}
      {shown < TOOLS.length && (
        <>
          <ToolbarSeparator />
          <MoreMenu editor={editor} ctx={ctx} items={TOOLS.slice(shown)} states={s.tools} />
        </>
      )}
      {/* 코드 블록 안에서만 보인다(P6-2). 맨 끝이라 나타나고 사라져도 다른 버튼 자리가 밀리지 않는다. */}
      {s.code && (
        <select
          ref={selectRef}
          className="editor-select"
          aria-label="코드 언어"
          aria-keyshortcuts="Alt+F10"
          title="코드 언어 (Alt+F10)"
          value={s.codeLanguage}
          onChange={(e) => editor.commands.updateAttributes("codeBlock", { language: e.target.value || null })}
          onKeyDown={(e) => {
            // Esc: 코드 블록의 커서 자리로 돌아간다(편집기는 포커스를 잃어도 선택을 지닌다).
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation(); // 위쪽의 Esc 처리(패널 닫기 등)까지 가지 않게
            editor.commands.focus();
          }}
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
      )}
    </div>
  );
}

function ToolbarSeparator() {
  return <div className="editor-toolbar-sep" role="separator" aria-orientation="vertical" />;
}

function ToolButton({ tool, state, onClick }: { tool: Tool; state: ToolState; onClick: () => void }) {
  const tip = shortcut(tool, "입력: ");
  return (
    <button
      type="button"
      className="editor-button"
      aria-label={tool.label}
      aria-pressed={state.pressed}
      aria-keyshortcuts={tool.keys}
      title={tip ? `${tool.label} (${tip})` : tool.label}
      disabled={state.disabled}
      onClick={onClick}
    >
      <Icon name={tool.icon} />
    </button>
  );
}

/** 막대에 다 못 들어간 도구를 담는 '더 보기' 메뉴(S-06 v0.8). */
function MoreMenu({
  editor,
  ctx,
  items,
  states,
}: {
  editor: Editor;
  ctx: { pickImage: () => void };
  items: typeof TOOLS;
  states: Record<string, ToolState>;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 아래 4px, 오른쪽 끝 맞춤. 화면 왼쪽 밖으로 나가면 왼쪽 끝 맞춤. 열리면 첫 항목에 포커스.
  // 그리기 전에 자리를 정하므로 상태로 두지 않고 바로 적는다(숨겨 두면 포커스를 줄 수 없다).
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current!;
    const b = buttonRef.current!.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${b.bottom + 4}px`;
    // 창이 낮으면 메뉴 안에서 스크롤한다.
    menu.style.maxHeight = `${window.innerHeight - b.bottom - 12}px`;
    menu.style.left = `${b.right - w >= 4 ? b.right - w : b.left}px`;
    menu.querySelector<HTMLElement>(MENU_ITEM)?.focus();
  }, [open]);

  // 바깥을 누르면 닫는다(포커스는 누른 곳으로 간다).
  // 창 크기가 바뀌거나 편집 영역이 스크롤되면 자리(position: fixed)가 버튼에서 떨어지므로 닫고 포커스를 버튼에 둔다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    const onResize = () => {
      if (menuRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
      setOpen(false);
    };
    // 버튼을 움직이는 스크롤(편집 영역 등 버튼을 품은 곳)만 센다. 메뉴 안·AI 패널 대화 스크롤은 메뉴를 닫지 않는다.
    const onScroll = (e: Event) => {
      if (buttonRef.current && (e.target as Node).contains(buttonRef.current)) onResize();
    };
    // 막대가 pointerdown을 막아 막대 버튼에는 mousedown이 오지 않으므로 pointerdown으로 센다.
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onResize);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // 열린 채 담긴 도구가 바뀌면(막대 폭 변화) 포커스가 있던 항목이 막대로 옮겨 사라질 수 있다. 닫고 버튼으로 돌린다.
  const first = items[0].tool.id;
  const firstRef = useRef(first);
  useLayoutEffect(() => {
    if (firstRef.current === first) return;
    firstRef.current = first;
    if (!open) return;
    buttonRef.current?.focus();
    setOpen(false);
  }, [first, open]);

  const onMenuKey = (e: KeyboardEvent) => {
    const list = [...menuRef.current!.querySelectorAll<HTMLElement>(MENU_ITEM)];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") list[Math.min(i + 1, list.length - 1)].focus();
    else if (e.key === "ArrowUp") list[Math.max(i - 1, 0)].focus();
    else if (e.key === "Home") list[0].focus();
    else if (e.key === "End") list[list.length - 1].focus();
    else if (e.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "Tab") {
      // 더 보기 버튼에서 Tab을 누른 것처럼 다음(앞) 요소로 간다.
      buttonRef.current?.focus();
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation(); // 위쪽의 Esc 처리(패널 닫기 등)까지 가지 않게
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="editor-button"
        aria-label="더 보기"
        title="더 보기"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          if (open) menuRef.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus();
          else setOpen(true);
        }}
      >
        <Icon name="more" />
      </button>
      {/* body에 띄운다. 막대(sticky, z-sticky)의 쌓임 맥락 안에 있으면 표 도구·블록 손잡이·목차 띠가 메뉴 위로 올라온다. */}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="toolbar-menu"
            role="menu"
            aria-label="더 보기"
            onKeyDown={onMenuKey}
          >
            {items.map(({ tool, group }, i) => {
              const st = states[tool.id];
              const keys = shortcut(tool);
              return [
                i > 0 && group !== items[i - 1].group && <div key={`sep-${i}`} className="toolbar-menu-sep" role="separator" />,
                <button
                  key={tool.id}
                  type="button"
                  tabIndex={-1}
                  className="toolbar-menu-item"
                  role={st.pressed === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={st.pressed}
                  aria-disabled={st.disabled || undefined}
                  aria-keyshortcuts={tool.keys}
                  onClick={() => {
                    if (st.disabled) return;
                    setOpen(false);
                    tool.act(editor, ctx);
                  }}
                >
                  <Icon name={tool.icon} />
                  <span>{tool.label}</span>
                  {keys && <kbd>{keys}</kbd>}
                </button>,
              ];
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
