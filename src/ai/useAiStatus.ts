// AI 패널·설정이 같이 쓰는 상태: 온라인 여부(F-08 오프라인 비활성)와 get_ai_status.
import { useCallback, useEffect, useRef, useState } from "react";
import { aiApi } from "../api/ai";
import type { PageId } from "../lib/db-types";
import type { AiStatus } from "../lib/ai-types";
import { localDay, msUntilMidnight } from "./aiLogic";

const CHANGED = "wy-ai-status-changed";

/** 키 저장·삭제, 상한·전송 제외 변경 뒤에 불러 열려 있는 패널이 상태를 다시 읽게 한다. */
export function notifyAiStatusChanged() {
  window.dispatchEvent(new Event(CHANGED));
}

/** navigator.onLine + online/offline 이벤트. 네트워크 요청을 하지 않는다(NF-06). 인터넷만 끊긴 경우는 호출 실패(Offline)로 드러난다. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/** status가 null이면 아직 읽는 중이다(그동안 '키 없음'·0회를 먼저 보이지 않는다). */
export function useAiStatus(pageId: PageId | null) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const s = await aiApi.getStatus(pageId, localDay());
      if (my === seq.current) {
        setStatus(s);
        setFailed(false);
      }
    } catch {
      if (my === seq.current) setFailed(true);
    }
  }, [pageId]);

  useEffect(() => {
    setStatus(null);
    void refresh();
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, [refresh]);

  // 자정이 지나면 오늘 횟수가 0으로 돌아간다.
  useEffect(() => {
    const t = setTimeout(() => void refresh(), msUntilMidnight() + 1000);
    return () => clearTimeout(t);
  }, [refresh, status]);

  return { status, failed, refresh };
}
