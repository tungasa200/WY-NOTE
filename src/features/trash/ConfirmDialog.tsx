import { useId, useRef, type ReactNode } from "react";
import { useModalDialog } from "../useModalDialog";

type ConfirmDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** 처리 중이면 버튼을 막고 폭을 유지한 채 "처리 중"으로 보인다. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** S-03 모양의 확인 창. 위험 버튼에 처음 포커스(S-03), Esc·취소로 닫힌다. 닫힐 때 연 곳으로 포커스를 돌려준다. */
export function ConfirmDialog({ title, children, confirmLabel, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useModalDialog(ref);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId} className="confirm-title">
        {title}
      </h2>
      <p id={descId} className="confirm-body">
        {children}
      </p>
      <div className="confirm-actions">
        <button type="button" className="trash-btn" onClick={onCancel} disabled={busy}>
          취소
        </button>
        <button type="button" className="trash-btn trash-btn-danger" onClick={() => !busy && onConfirm()}
          // disabled로 막으면 포커스가 버튼에서 빠지므로 aria-disabled로 둔다.
          aria-disabled={busy}
          autoFocus
        >
          {busy ? "지우는 중…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
