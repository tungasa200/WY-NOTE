// 알림(화면설계 공통 규칙): 화면 아래 가운데, 동작 버튼 1개, 5초. 겹치면 마지막 것만(부모가 하나만 둔다).
import { useEffect, useRef } from "react";

export type ToastData = { message: string; action?: { label: string; run: () => void } };

const TOAST_MS = 5000;

export function Toast({ data, onClose }: { data: ToastData; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = () => {
    stop();
    timer.current = setTimeout(() => close.current(), TOAST_MS);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
  };

  useEffect(() => {
    start();
    return stop;
  }, []);

  // 버튼을 누르러 가는 동안(마우스·포커스)에는 사라지지 않게 멈춘다.
  return (
    <div className="toast" role="status" onMouseEnter={stop} onMouseLeave={start} onFocus={stop} onBlur={start}>
      <span>{data.message}</span>
      {data.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            data.action!.run();
            onClose();
          }}
        >
          {data.action.label}
        </button>
      )}
    </div>
  );
}
