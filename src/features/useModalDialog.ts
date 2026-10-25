import { useLayoutEffect, type RefObject } from "react";

/** 띄울 때 모달로 열고, 내릴 때 닫은 뒤 연 곳으로 포커스를 돌려준다. 닫기는 부모가 컴포넌트를 내리는 것으로 한다. */
export function useModalDialog(ref: RefObject<HTMLDialogElement | null>) {
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}
