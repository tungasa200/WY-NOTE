// S-08 설정. 일반(화면 — 테마·강조색, 데이터)과 AI 구역.
import { isTauri } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { AiSettings } from "../ai/AiSettings";
import { ACCENTS, THEMES, type Appearance } from "./appearance";
import "./SettingsView.css";

type Props = {
  appearance: Appearance;
  onAppearance: (a: Appearance) => void;
  /** 테마·강조색이 저장될 때마다 는다. */
  appearanceSaves: number;
};

export function SettingsView({ appearance, onAppearance, appearanceSaves }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // 사이드바·Ctrl+,로 열면 제목에 포커스를 둬 화면 낭독기와 Tab이 여기서 시작하게 한다.
  useEffect(() => headingRef.current?.focus(), []);

  // 바꾼 행에만, 바꾼 뒤 저장이 끝났을 때 '저장됨'을 1.5초 보인다.
  const [savedRow, setSavedRow] = useState<keyof Appearance | null>(null);
  const pending = useRef<{ row: keyof Appearance; at: number } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (!p || appearanceSaves <= p.at) return;
    setSavedRow(p.row);
    const t = setTimeout(() => setSavedRow(null), 1500);
    return () => clearTimeout(t);
  }, [appearanceSaves]);
  const change = (patch: Partial<Appearance>) => {
    pending.current = { row: Object.keys(patch)[0] as keyof Appearance, at: appearanceSaves };
    setSavedRow(null);
    onAppearance({ ...appearance, ...patch });
  };

  const goto = (id: string) => {
    const h = document.getElementById(id);
    h?.scrollIntoView({ block: "start" });
    h?.focus();
  };

  const accentLabel = ACCENTS.find((a) => a.value === appearance.accent)!.label;

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h1 id="settings-heading" className="settings-title" ref={headingRef} tabIndex={-1}>
        설정
      </h1>
      <nav className="settings-tabs" aria-label="설정 구역">
        <button type="button" className="settings-tab" onClick={() => goto("settings-general")}>
          일반
        </button>
        <button type="button" className="settings-tab" onClick={() => goto("settings-ai")}>
          AI
        </button>
      </nav>

      <section aria-labelledby="settings-general">
        <h2 id="settings-general" className="settings-section" tabIndex={-1}>
          일반
        </h2>
        <h3 className="settings-group">화면</h3>
        <div className="settings-row">
          <span id="settings-theme" className="settings-label">
            테마
          </span>
          <div className="settings-control">
            <div className="segmented" role="radiogroup" aria-labelledby="settings-theme">
              {THEMES.map((t) => (
                <label key={t.value} className="segmented-item">
                  <input
                    type="radio"
                    name="settings-theme"
                    value={t.value}
                    checked={appearance.theme === t.value}
                    onChange={() => change({ theme: t.value })}
                  />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
            <span className="settings-saved" role="status">
              {savedRow === "theme" ? "저장됨" : ""}
            </span>
          </div>
        </div>
        <div className="settings-row">
          <span id="settings-accent" className="settings-label">
            강조색
          </span>
          <div className="settings-control">
            <div className="swatches" role="radiogroup" aria-labelledby="settings-accent">
              {ACCENTS.map((a) => (
                <label key={a.value} className="swatch" data-swatch={a.value} title={a.label}>
                  <input
                    type="radio"
                    name="settings-accent"
                    value={a.value}
                    aria-label={a.label}
                    checked={appearance.accent === a.value}
                    onChange={() => change({ accent: a.value })}
                  />
                  <span className="swatch-dot" aria-hidden="true">
                    {appearance.accent === a.value && <Check size={12} strokeWidth={2} />}
                  </span>
                </label>
              ))}
            </div>
            <span className="settings-value">{appearance.accent === "teal" ? `${accentLabel} (기본)` : accentLabel}</span>
            <span className="settings-saved" role="status">
              {savedRow === "accent" ? "저장됨" : ""}
            </span>
          </div>
        </div>

        <h3 className="settings-group">데이터</h3>
        <DataFolder />
      </section>

      <section aria-labelledby="settings-ai">
        <h2 id="settings-ai" className="settings-section" tabIndex={-1}>
          AI
        </h2>
        <AiSettings />
      </section>
    </section>
  );
}

/** 데이터 폴더(NF-01): 경로와 폴더 열기. */
function DataFolder() {
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api.getDataDir().then(
      (d) => alive && setDir(d),
      () => alive && setError("데이터 폴더 위치를 읽지 못했습니다."),
    );
    return () => {
      alive = false;
    };
  }, []);
  const open = () => {
    setError("");
    if (dir) openPath(dir).catch(() => setError("폴더를 열지 못했습니다."));
  };

  return (
    <div className="settings-row">
      <span className="settings-label">데이터 폴더</span>
      <div className="settings-control settings-control-stack">
        <p className="settings-help">노트·이미지·설정이 모두 이 폴더 하나에 있습니다. 앱을 끈 뒤 폴더를 통째로 복사하면 백업입니다.</p>
        <div className="settings-path-row">
          <code className="settings-path" title={dir ?? undefined}>
            {dir ?? (error ? "—" : "읽는 중…")}
          </code>
          {isTauri() && (
            <button type="button" className="button" onClick={open} disabled={!dir}>
              폴더 열기
            </button>
          )}
        </div>
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
