import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * 띄울 때 모달로 열고 `[data-autofocus]` 요소(없으면 브라우저 기본: 첫 조작 요소)에 포커스를 둔다.
 * 내릴 때 닫고, 화면이 다시 그려진 뒤 연 곳으로 포커스를 돌려준다. 연 곳이 사라졌으면 fallbackFocus를 부른다.
 * shouldRestore가 false를 돌려주면 포커스를 돌려주지 않는다(부모가 다른 곳으로 옮길 때).
 * 닫기는 부모가 컴포넌트를 내리는 것으로 한다.
 */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  opts: { fallbackFocus?: () => void; shouldRestore?: () => boolean } = {},
) {
  // 처음 그릴 때 한 번만 잡는다(StrictMode의 두 번째 effect 때는 이미 이 창 안에 포커스가 있다).
  const [opener] = useState(() => document.activeElement);
  const latest = useRef(opts);
  latest.current = opts;
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    // 반복 Esc는 cancel의 preventDefault를 무시하고 닫힐 수 있다(CloseWatcher). 붙어 있는 동안은 다시 연다.
    const reopen = () => {
      if (mounted.current && !dialog.open) dialog.showModal();
    };
    dialog.addEventListener("close", reopen);
    return () => {
      dialog.removeEventListener("close", reopen);
      mounted.current = false;
      if (dialog.open) dialog.close();
      // 닫힌 뒤 화면이 다시 그려진 다음에 돌린다(지운 행이 사라졌는지 알 수 있게).
      requestAnimationFrame(() => {
        if (mounted.current) return; // StrictMode에서 다시 붙었다
        const { fallbackFocus, shouldRestore } = latest.current;
        if (shouldRestore && !shouldRestore()) return;
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
        else fallbackFocus?.();
      });
    };
  }, [ref, opener]);
}
