// 되돌리기 어려운 일의 확인 창(화면설계 S-03). 위험 버튼에 처음 포커스, Esc 취소, 닫으면 연 곳으로 포커스를 돌린다.
import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 닫힌 뒤 연 요소가 사라졌으면(예: 삭제한 행) 대신 포커스를 줄 곳. */
  fallbackFocus?: () => void;
};

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, fallbackFocus }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // 처음 그릴 때 한 번만 잡는다(StrictMode의 두 번째 effect 때는 이미 이 창 안에 포커스가 있다).
  const [opener] = useState(() => document.activeElement);
  const mounted = useRef(false);
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;

  useEffect(() => {
    mounted.current = true;
    const dlg = ref.current!;
    if (!dlg.open) dlg.showModal();
    dlg.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();
    return () => {
      mounted.current = false;
      // 닫힌 뒤 화면이 다시 그려진 다음에 돌린다(지운 행이 사라졌는지 알 수 있게).
      requestAnimationFrame(() => {
        if (mounted.current) return; // StrictMode에서 다시 붙었다
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
        else fallback.current?.();
      });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title" className="dialog-title">
        {title}
      </h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="button button-danger" data-autofocus onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
