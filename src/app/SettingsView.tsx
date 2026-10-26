// S-08 설정. 지금은 AI 구역만 있다(일반 구역 — 테마·데이터 폴더 — 은 아직 없다).
import { useEffect, useRef } from "react";
import { AiSettings } from "../ai/AiSettings";
import "./SettingsView.css";

export function SettingsView() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // 사이드바·Ctrl+,로 열면 제목에 포커스를 둬 화면 낭독기와 Tab이 여기서 시작하게 한다.
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h1 id="settings-heading" className="settings-title" ref={headingRef} tabIndex={-1}>
        설정
      </h1>
      <section aria-labelledby="settings-ai">
        <h2 id="settings-ai" className="settings-section">
          AI
        </h2>
        <AiSettings />
      </section>
    </section>
  );
}
