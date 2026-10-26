import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SearchHit } from "../../lib/db-types";
import { displayTitle, isUntitled } from "../../lib/title";
import { useModalDialog } from "../../lib/useModalDialog";
import "./SearchPanel.css";

export type RecentPage = { pageId: number; title: string };

type SearchPanelProps = {
  /** search 명령. 1~2글자 검색어도 그대로 넘긴다(백엔드가 LIKE로 찾음, F-04). */
  search: (query: string) => Promise<SearchHit[]>;
  /** 결과를 고르면 부른다. query는 열린 페이지에서 첫 일치 위치를 찾는 데 쓴다. */
  onOpenPage: (pageId: number, query: string) => void;
  onClose: () => void;
  /** 트리 경로("업무 / 회의록"). 최상위면 빈 문자열. 없으면 경로를 보이지 않는다. */
  pathOf?: (pageId: number) => string;
  /** 빈 입력일 때 보여 줄 최근 연 페이지(S-05, 최대 5개). */
  recent?: RecentPage[];
};

const DEBOUNCE_MS = 120;
// 이보다 오래 걸릴 때만 진행 표시를 띄운다(S-05: 0.5초).
const SLOW_MS = 500;

type Row = { pageId: number; title: string; snippet?: SearchHit["snippet"] };

type State =
  | { kind: "idle" } // 빈 입력
  | { kind: "pending"; rows: Row[] } // 응답 대기. 앞 결과를 그대로 두어 '없음'이 깜빡이지 않게 한다
  | { kind: "done"; query: string; rows: Row[] }
  | { kind: "error"; rows: Row[] };

export function SearchPanel({ search, onOpenPage, onClose, pathOf, recent = [] }: SearchPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [active, setActive] = useState(0);
  const [slow, setSlow] = useState(false);
  const listId = useId();
  // 결과를 골라 닫을 때는 연 곳으로 포커스를 돌리지 않는다(부모가 편집기로 옮긴다).
  const opened = useRef(false);

  useModalDialog(dialogRef, { shouldRestore: () => !opened.current, onBackdrop: onClose });

  // 입력이 멈춘 뒤 검색한다. 늦게 온 옛 응답은 버린다.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setState({ kind: "idle" });
      setActive(0);
      return;
    }
    setState((s) => ({ kind: "pending", rows: rowsOf(s) }));
    let stale = false;
    const slowTimer = window.setTimeout(() => setSlow(true), DEBOUNCE_MS + SLOW_MS);
    const timer = window.setTimeout(() => {
      search(q).then(
        (hits) => {
          if (stale) return;
          setState({ kind: "done", query: q, rows: hits });
          setActive(0);
        },
        () => {
          if (!stale) setState((s) => ({ kind: "error", rows: rowsOf(s) }));
        },
      ).finally(() => {
        if (!stale) {
          window.clearTimeout(slowTimer);
          setSlow(false);
        }
      });
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
      window.clearTimeout(slowTimer);
      setSlow(false);
    };
  }, [query, search]);

  const rows: Row[] = state.kind === "idle" ? recent.slice(0, 5) : state.rows;
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const activeIndex = Math.min(active, rows.length - 1);
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, state, listId]);

  const open = (row: Row) => {
    opened.current = true;
    onOpenPage(row.pageId, state.kind === "idle" ? "" : query.trim());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter·화살표는 입력기 몫이다.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[activeIndex]) open(rows[activeIndex]);
    }
  };

  let status: ReactNode = null;
  if (state.kind === "done" && rows.length === 0) {
    status = <p className="search-empty">"{state.query}"와 일치하는 페이지가 없습니다.</p>;
  } else if (state.kind === "error") {
    status = (
      <p className="search-empty" role="alert">
        검색하지 못했습니다. 검색어를 고쳐 다시 입력해 보세요.
      </p>
    );
  }

  const found = `${rows.length}개 페이지`;
  const countText =
    state.kind === "done" ? found : state.kind === "idle" && rows.length > 0 ? "최근 연 페이지" : "";

  return (
    <dialog
      ref={dialogRef}
      className="search-dialog"
      aria-label="검색"
      onCancel={(e) => {
        e.preventDefault(); // 닫기는 부모가 내리는 것으로 한다(포커스 복귀를 한곳에서).
        onClose();
      }}
    >
      <div className="search-input-row">
        <SearchIcon />
        <input
          className="search-input"
          type="text"
          role="combobox"
          aria-label="검색어"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {slow && <span className="search-spinner" role="status" aria-label="검색 중" />}
        <kbd className="search-kbd">Esc</kbd>
      </div>

      <ul id={listId} className="search-results" role="listbox" aria-label="검색 결과" hidden={rows.length === 0}>
        {rows.map((row, i) => {
          const path = pathOf?.(row.pageId);
          return (
            <li
              key={row.pageId}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              className="search-result"
              // 클릭해도 포커스가 입력칸에 남게 한다.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== activeIndex && setActive(i)}
              onClick={() => open(row)}
            >
              <div className="search-result-top">
                <span className={isUntitled(row.title) ? "search-result-title is-untitled" : "search-result-title"}>
                  {isUntitled(row.title) ? displayTitle(row.title) : highlight(row.title, terms)}
                </span>
                {path !== undefined && (
                  <span className="search-result-path" title={path || "최상위"}>
                    {path ? highlight(path, terms) : "최상위"}
                  </span>
                )}
              </div>
              {row.snippet && row.snippet.length > 0 && (
                <div className="search-result-snippet">
                  {row.snippet.map((part, j) => (part.match ? <mark key={j}>{part.text}</mark> : <span key={j}>{part.text}</span>))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {status}

      <div className="search-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 고르기
        </span>
        <span>
          <kbd>Enter</kbd> 열기
        </span>
        <span className="search-count">{countText}</span>
      </div>
      {/* 결과 수는 화면 읽기 프로그램에 따로 알린다(아래 막대는 장식). */}
      <span className="search-sr" role="status">
        {state.kind === "done" ? (rows.length ? found : "일치하는 페이지 없음") : ""}
      </span>
    </dialog>
  );
}

const rowsOf = (s: State): Row[] => ("rows" in s ? s.rows : []);

/** 제목·경로 안의 검색어를 대소문자 구분 없이 강조한다(본문 일부는 백엔드가 나눠 준 조각을 쓴다). */
function highlight(text: string, terms: string[]): ReactNode {
  if (terms.length === 0) return text;
  const lower = text.toLowerCase();
  const marks = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    const t = term.toLowerCase();
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) marks.fill(true, i, i + t.length);
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      const piece = text.slice(start, i);
      parts.push(marks[start] ? <mark key={start}>{piece}</mark> : piece);
      start = i;
    }
  }
  return parts;
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </svg>
  );
}
