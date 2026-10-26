// 되돌리기 어려운 일의 확인 창(화면설계 S-03). Esc·취소로 닫힌다. 닫으면 연 곳으로 포커스를 돌린다.
import { useId, useRef, type ReactNode } from "react";
import { useModalDialog } from "./useModalDialog";
import "./dialog.css";

type Props = {
  title: string;
  /** 본문. 문단은 <p>로 넣는다. */
  children: ReactNode;
  confirmLabel: string;
  /** 처리 중이면 버튼을 막고 폭을 유지한 채 busyLabel로 보인다. Esc·취소도 막는다. */
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * 처음 포커스. 되돌릴 수 없는 일(영구 삭제·비우기·키 삭제)은 "cancel"(기본),
   * 되돌릴 수 있는 일(휴지통으로 이동)은 "confirm"(화면설계 v0.2).
   */
  initialFocus?: "cancel" | "confirm";
  /** 닫힌 뒤 연 요소가 사라졌으면(예: 삭제한 행) 대신 포커스를 줄 곳. */
  fallbackFocus?: () => void;
};

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy = false,
  busyLabel = "처리 중…",
  onConfirm,
  onCancel,
  initialFocus = "cancel",
  fallbackFocus,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useModalDialog(ref, { fallbackFocus });

  return (
    <dialog
      ref={ref}
      className="dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <div id={descId} className="dialog-body">
        {children}
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="button"
          data-autofocus={initialFocus === "cancel" || undefined}
          onClick={onCancel}
          disabled={busy}
        >
          취소
        </button>
        <button
          type="button"
          className="button button-danger"
          data-autofocus={initialFocus === "confirm" || undefined}
          // disabled로 막으면 포커스가 버튼에서 빠지므로 aria-disabled로 둔다.
          aria-disabled={busy}
          onClick={() => !busy && onConfirm()}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
