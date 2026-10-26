// 창 닫기 때 저장하지 못했을 때 묻는 창(S-12, 결정 db-v2). "다시 저장"에 처음 포커스: Enter 한 번으로 내용을 잃지 않게.
// Esc로는 닫지 않는다(둘 중 하나를 고르게).
import { useId, useRef } from "react";
import { useModalDialog } from "../lib/useModalDialog";
import "../lib/dialog.css";

const NAMES_MAX = 3;

type Props = {
  reason: string;
  /** 저장하지 못한 페이지 제목(화면용으로 다듬은 것). */
  titles: string[];
  /** 다시 저장하는 중 */
  busy: boolean;
  onRetry: () => void;
  onCloseAnyway: () => void;
};

export function CloseSaveDialog({ reason, titles, busy, onRetry, onCloseAnyway }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useModalDialog(ref);
  const rest = titles.length - NAMES_MAX;

  return (
    <dialog
      ref={ref}
      className="dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => e.preventDefault()}
    >
      <h2 id={titleId} className="dialog-title">
        저장하지 못한 내용이 있습니다
      </h2>
      <div id={descId} className="dialog-body">
        {titles.length > 0 && (
          <p>
            {titles.slice(0, NAMES_MAX).map((t, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <strong>{t}</strong>
              </span>
            ))}
            {rest > 0 && ` 외 ${rest}개`}
          </p>
        )}
        <p>{reason}. 그래도 닫으면 저장하지 못한 편집 내용을 잃습니다.</p>
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="button button-primary"
          data-autofocus
          aria-disabled={busy}
          onClick={() => !busy && onRetry()}
        >
          {busy ? "저장 중…" : "다시 저장"}
        </button>
        <button type="button" className="button button-danger" disabled={busy} onClick={onCloseAnyway}>
          그래도 닫기
        </button>
      </div>
    </dialog>
  );
}
