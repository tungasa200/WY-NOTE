// 알림(화면설계 공통 규칙): 화면 아래 가운데, 동작 버튼 1개, 5초. 한 번에 하나(부모가 하나만 둔다).
import { useEffect, useRef } from "react";

export type ToastData = { message: string; action?: { label: string; run: () => void } };

/** 떠 있는 알림과, 동작 버튼 알림이 닫히기를 기다리는 일반 알림(마지막 것 하나). id가 바뀌면 5초를 새로 센다. */
export type ToastQueue = { current: (ToastData & { id: number }) | null; waiting: ToastData | null };

let toastSeq = 0;

/**
 * 새 알림을 받는다(화면설계 v0.5 우선순위). 동작 버튼 알림이 떠 있으면 일반 알림은 기다리게 한다
 * (되돌릴 기회를 덮지 않게). 동작 버튼 알림은 언제나 지금 것을 바꾼다. 그 밖에는 마지막 것만.
 */
export function pushToast(q: ToastQueue, t: ToastData): ToastQueue {
  if (!t.action && q.current?.action) return { ...q, waiting: t };
  return { ...q, current: { ...t, id: ++toastSeq } };
}

/** 알림 id가 닫히면 기다리던 일반 알림을 띄운다. 이미 다른 알림으로 바뀌었으면 그대로 둔다. */
export function closeToast(q: ToastQueue, id: number): ToastQueue {
  if (q.current?.id !== id) return q;
  return { current: q.waiting && { ...q.waiting, id: ++toastSeq }, waiting: null };
}

const TOAST_MS = 5000;

export function Toast({ data, onClose }: { data: ToastData; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 알림으로 들어오기 전 포커스 자리. 버튼을 눌러 알림이 사라지면 그리로 돌려보낸다(body로 빠지지 않게).
  const back = useRef<HTMLElement | null>(null);

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
    <div
      className="toast"
      onMouseEnter={stop}
      onMouseLeave={start}
      onFocus={(e) => {
        stop();
        if (e.relatedTarget instanceof HTMLElement && !e.currentTarget.contains(e.relatedTarget)) back.current = e.relatedTarget;
      }}
      onBlur={start}
    >
      <span>{data.message}</span>
      {data.action && (
        <button
          type="button"
          className="toast-action"
          onClick={(e) => {
            data.action!.run();
            if (e.currentTarget === document.activeElement && back.current?.isConnected) back.current.focus();
            onClose();
          }}
        >
          {data.action.label}
        </button>
      )}
    </div>
  );
}
