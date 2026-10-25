import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import "./TrashPanel.css";

// 계약-DB.md 8절의 TrashItem과 같은 모양. src/lib/db-types.ts가 생기면 그쪽 타입으로 바꾼다.
export type TrashItem = {
  id: number;
  title: string;
  trashedAt: number;
  descendantCount: number;
};

type TrashPanelProps = {
  list: () => Promise<TrashItem[]>;
  restore: (id: number) => Promise<{ toRoot: boolean }>;
  deletePermanently: (id: number) => Promise<void>;
  empty: () => Promise<{ deletedCount: number }>;
  /** 복원 뒤 알림(S-04 `"…"를 복원했습니다 [열기]`)은 앱 셸이 띄운다. */
  onRestored?: (item: TrashItem, result: { toRoot: boolean }) => void;
};

type Confirm = { kind: "one"; item: TrashItem } | { kind: "all" };

export function TrashPanel({ list, restore, deletePermanently, empty, onRestored }: TrashPanelProps) {
  // null = 아직 불러오는 중. 이때는 '비어 있음'을 보이지 않는다.
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  // 줄이 사라진 뒤 포커스를 옮길 자리(그 줄의 순번).
  const focusAfter = useRef<number | null>(null);

  /** focusIndex: 다시 읽은 뒤 포커스를 둘 줄의 순번. 읽기에 성공했을 때만 예약한다. */
  const reload = useCallback(
    async (focusIndex?: number) => {
      try {
        const next = await list();
        focusAfter.current = focusIndex ?? null;
        setItems(next);
        setLoadFailed(false);
      } catch {
        setLoadFailed(true);
      }
    },
    [list],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // 누른 줄이 목록에서 사라지면 같은 자리(없으면 위) 줄의 복원 버튼으로, 하나도 없으면 제목으로 포커스를 옮긴다.
  useEffect(() => {
    if (focusAfter.current === null || !items) return;
    const i = Math.min(focusAfter.current, items.length - 1);
    focusAfter.current = null;
    const target = i >= 0 ? rowRefs.current.get(items[i].id) : headingRef.current;
    target?.focus();
  }, [items]);

  const indexOf = (id: number) => items?.findIndex((x) => x.id === id) ?? -1;

  const onRestore = async (item: TrashItem) => {
    if (pendingId !== null) return; // 한 번에 하나만 복원한다(목록 다시 읽기가 겹치지 않게).
    setError("");
    setPendingId(item.id);
    try {
      const result = await restore(item.id);
      await reload(indexOf(item.id));
      onRestored?.(item, result);
    } catch {
      setError(`${object(item.title)} 복원하지 못했습니다. 휴지통에 그대로 있으니 다시 시도해 주세요.`);
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    setError("");
    try {
      if (confirm.kind === "one") await deletePermanently(confirm.item.id);
      else await empty();
      setConfirm(null);
      await reload(confirm.kind === "one" ? indexOf(confirm.item.id) : 0);
    } catch {
      setConfirm(null);
      setError(
        confirm.kind === "one"
          ? `${object(confirm.item.title)} 지우지 못했습니다. 휴지통에 그대로 있으니 다시 시도해 주세요.`
          : "휴지통을 비우지 못했습니다. 페이지는 그대로 있으니 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  };

  const totalPages = items?.reduce((n, x) => n + 1 + x.descendantCount, 0) ?? 0;

  return (
    <section className="trash" aria-labelledby="trash-heading">
      <div className="trash-head">
        <div className="trash-head-text">
          <h1 id="trash-heading" className="trash-title" ref={headingRef} tabIndex={-1}>
            휴지통
          </h1>
          <p className="trash-lede">복원하면 원래 위치로 돌아갑니다. 영구 삭제 전까지 첨부 이미지도 남아 있습니다.</p>
        </div>
        <button
          type="button"
          className="trash-btn trash-btn-danger-text"
          disabled={!items || items.length === 0}
          onClick={() => setConfirm({ kind: "all" })}
        >
          휴지통 비우기
        </button>
      </div>

      {error && (
        <p className="trash-error" role="alert">
          {error}
        </p>
      )}

      {loadFailed ? (
        <div className="trash-error" role="alert">
          휴지통 목록을 불러오지 못했습니다.{" "}
          <button type="button" className="trash-btn" onClick={() => void reload()}>
            다시 불러오기
          </button>
        </div>
      ) : items === null ? (
        <p className="trash-loading" aria-busy="true">
          불러오는 중…
        </p>
      ) : items.length === 0 ? (
        <p className="trash-empty">휴지통이 비어 있습니다.</p>
      ) : (
        <ul className="trash-list">
          {items.map((item) => {
            const pending = pendingId === item.id;
            return (
              <li key={item.id} className="trash-row">
                <div className="trash-row-main">
                  <span className={item.title ? "trash-row-title" : "trash-row-title is-untitled"} title={displayTitle(item.title)}>
                    {displayTitle(item.title)}
                  </span>
                  {item.descendantCount > 0 && <span className="trash-badge">하위 {count(item.descendantCount)}개</span>}
                </div>
                <time className="trash-when" dateTime={new Date(item.trashedAt).toISOString()}>
                  {formatWhen(item.trashedAt)}
                </time>
                <div className="trash-row-actions">
                  <button
                    type="button"
                    className="trash-btn"
                    ref={(el) => {
                      if (el) rowRefs.current.set(item.id, el);
                      else rowRefs.current.delete(item.id);
                    }}
                    aria-disabled={pending}
                    aria-label={`${displayTitle(item.title)} 복원`}
                    onClick={() => !pending && void onRestore(item)}
                  >
                    {pending ? "복원 중…" : "복원"}
                  </button>
                  <button
                    type="button"
                    className="trash-btn trash-btn-danger-text"
                    disabled={pending}
                    aria-label={`${displayTitle(item.title)} 영구 삭제`}
                    onClick={() => setConfirm({ kind: "one", item })}
                  >
                    영구 삭제
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === "one"
              ? `${object(confirm.item.title)} 영구 삭제할까요?`
              : "휴지통을 비울까요?"
          }
          confirmLabel="영구 삭제"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void onConfirmDelete()}
        >
          {confirm.kind === "one" ? (
            <>
              {quote(confirm.item.title)}
              {josa(confirm.item.title, "과", "와")}{" "}
              {confirm.item.descendantCount > 0 && (
                <>
                  하위 페이지 <b>{count(confirm.item.descendantCount)}개</b>,{" "}
                </>
              )}
              첨부 이미지를 지웁니다. 되돌릴 수 없습니다.
            </>
          ) : (
            <>
              휴지통의 페이지 <b>{count(totalPages)}개</b>와 첨부 이미지를 모두 지웁니다. 되돌릴 수 없습니다.
            </>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

const displayTitle = (title: string) => title || "제목 없음";
const quote = (title: string) => `"${displayTitle(title)}"`;
/** 목적어: "제목"을 / "제목"를 */
const object = (title: string) => quote(title) + josa(title, "을", "를");
const count = (n: number) => n.toLocaleString("ko-KR");

/** 받침이 있으면 withBatchim, 없으면 without. 한글·숫자가 아닌 끝 글자는 "을(를)"처럼 둘 다 쓴다. */
export function josa(title: string, withBatchim: string, without: string): string {
  const last = displayTitle(title).trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? withBatchim : without;
  if (/[0-9]/.test(last)) return "013678".includes(last) ? withBatchim : without;
  return `${withBatchim}(${without})`;
}

/** 지운 시각. 올해면 "10월 25일 18:40", 아니면 연도를 붙인다. 사용자 PC의 시간대로 보인다. */
export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return (sameYear ? WHEN_THIS_YEAR : WHEN_OTHER_YEAR).format(d);
}

const WHEN_PARTS: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const WHEN_THIS_YEAR = new Intl.DateTimeFormat("ko-KR", WHEN_PARTS);
const WHEN_OTHER_YEAR = new Intl.DateTimeFormat("ko-KR", { ...WHEN_PARTS, year: "numeric" });
