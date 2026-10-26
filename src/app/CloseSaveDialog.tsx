// 창 닫기 때 저장하지 못했을 때 묻는 창(S-12, 결정 db-v2). "다시 저장"에 처음 포커스: Enter 한 번으로 내용을 잃지 않게.
// Esc·바깥 클릭은 이 창만 닫고 앱은 그대로 둔다(닫기 취소).
import { useId, useRef } from "react";
import { useModalDialog } from "../lib/useModalDialog";
import "../lib/dialog.css";

const NAMES_MAX = 3;

type Props = {
  /** 본문 첫 문장(마침표 없이): 실패 이유, 또는 "저장이 끝나지 않았습니다". */
  reason: string;
  /** 저장하지 못한 페이지 제목(화면용으로 다듬은 것). */
  titles: string[];
  /** 다시 저장하는 중 */
  busy: boolean;
  onRetry: () => void;
  onCloseAnyway: () => void;
  /** 창을 닫지 않고 이 대화상자만 내린다. */
  onDismiss: () => void;
};

export function CloseSaveDialog({ reason, titles, busy, onRetry, onCloseAnyway, onDismiss }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useModalDialog(ref);
  const rest = titles.length - NAMES_MAX;
  // 상자 안에서 누르고 밖에서 뗀 끌기(글 고르기)는 바깥 클릭이 아니다. 누른 곳도 바깥이어야 닫는다.
  const downOutside = useRef(false);
  const outside = (e: { target: EventTarget; currentTarget: HTMLDialogElement; clientX: number; clientY: number }) => {
    if (e.target !== e.currentTarget) return false;
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onDismiss();
      }}
      // 바깥(배경)을 누르면 이벤트 대상이 dialog 자신이고 좌표가 상자 밖이다. 상자 안 여백 클릭과 가른다.
      onMouseDown={(e) => {
        downOutside.current = outside(e);
      }}
      onClick={(e) => {
        if (!busy && downOutside.current && outside(e)) onDismiss();
        downOutside.current = false;
      }}
    >
      <h2 id={titleId} className="dialog-title">
        저장하지 못한 내용이 있습니다
      </h2>
      <div id={descId} className="dialog-body">
        <p>
          {reason}. 그래도 닫으면 마지막 저장 뒤에 입력한 내용은 사라집니다.
        </p>
        {titles.length > 1 && (
          <p>
            {titles.slice(0, NAMES_MAX).join(", ")}
            {rest > 0 && ` 외 ${rest}개`}
          </p>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button dialog-danger-text" disabled={busy} onClick={onCloseAnyway}>
          그래도 닫기
        </button>
        <button
          type="button"
          className="button button-primary"
          data-autofocus
          aria-disabled={busy}
          onClick={() => !busy && onRetry()}
        >
          {busy ? "저장 중…" : "다시 저장"}
        </button>
      </div>
    </dialog>
  );
}
