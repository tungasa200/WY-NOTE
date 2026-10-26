// S-11 마크다운 내보내기(F-06). 고르기 → 진행 → 결과(성공 위치·바뀐 것) / 실패 이유.
// 폴더 선택 창은 Rust가 띄운다(계약-AI 5.1). 표현하지 못한 것이 없으면 창을 닫고 알림(onExported)으로 끝낸다.
import { useEffect, useId, useRef, useState } from "react";
import { api, errorReason, isAppError } from "../api";
import type { PageId } from "../lib/db-types";
import { displayTitle } from "../lib/title";
import { buildExport, type ExportSource } from "./exportTree";
import "./ExportDialog.css";

type Props = {
  page: { id: PageId; title: string };
  source: ExportSource;
  /** 아직 보내지 않은 편집을 먼저 저장한다(내보낸 파일에 마지막 입력까지 들어가게). */
  beforeExport?: () => Promise<void>;
  /** 표현하지 못한 것 없이 끝났을 때 알림 문구를 넘긴다. 부모가 토스트로 띄운다. */
  onExported: (message: string) => void;
  onClose: () => void;
  /** 닫힌 뒤 연 요소가 사라졌으면(예: 닫힌 메뉴 항목) 대신 포커스를 줄 곳. */
  fallbackFocus?: () => void;
};

type Phase =
  | { step: "options" }
  | { step: "reading"; done: number; total: number }
  | { step: "writing" }
  | { step: "done"; dir: string; fileCount: number; notes: string[] }
  | { step: "error"; reason: string; partial: boolean };

const shortName = (n: string) => (n.length > 40 ? n.slice(0, 39) + "…" : n);
/** 이름은 5개까지만 적는다(수백 개여도 알림이 한 화면에 들어가게). */
const listNames = (names: string[]) =>
  names.slice(0, 5).map(shortName).join(", ") + (names.length > 5 ? ` 외 ${names.length - 5}개` : "");

export function ExportDialog({ page, source, beforeExport, onExported, onClose, fallbackFocus }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [opener] = useState(() => document.activeElement);
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  const mounted = useRef(false);
  const childCount = source.childrenOf(page.id).length;
  const [includeChildren, setIncludeChildren] = useState(true);
  const [phase, setPhase] = useState<Phase>({ step: "options" });
  const busy = phase.step === "reading" || phase.step === "writing";

  useEffect(() => {
    mounted.current = true;
    const dlg = ref.current!;
    if (!dlg.open) dlg.showModal();
    return () => {
      mounted.current = false;
      requestAnimationFrame(() => {
        if (mounted.current) return; // StrictMode에서 다시 붙었다
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
        else fallback.current?.();
      });
    };
  }, []);

  // 단계가 바뀌면 그 단계의 주 버튼으로 포커스를 옮긴다(누른 버튼이 사라지므로).
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [phase.step]);

  const run = async () => {
    try {
      setPhase({ step: "reading", done: 0, total: 0 });
      await beforeExport?.();
      const built = await buildExport(source, page.id, includeChildren, (done, total) => {
        if (mounted.current) setPhase({ step: "reading", done, total });
      });
      if (!mounted.current) return;
      setPhase({ step: "writing" });
      const r = await api.exportMarkdown(built.request);
      if (!mounted.current) return;
      if (r.cancelled) {
        // 저장 위치를 고르지 않았다: 아무것도 쓰지 않았으므로 처음 화면으로 돌아간다.
        setPhase({ step: "options" });
        return;
      }
      const missing = [...built.skippedImages, ...r.missingImages];
      const notes = [
        ...built.warnings.map((w) => w.message),
        ...(missing.length
          ? [`이미지 파일 ${missing.length}개를 찾지 못해 빠졌습니다(${listNames(missing)}). 글 안의 링크는 남아 있습니다.`]
          : []),
      ];
      if (notes.length === 0) {
        onExported(`"${displayTitle(built.request.root.title)}" 페이지를 내보냈습니다. ${r.dir}`);
        onClose();
        return;
      }
      setPhase({ step: "done", dir: r.dir, fileCount: r.fileCount, notes });
    } catch (e) {
      // 계약 5.3 ④: 쓰다가 실패한 경우(Io)만 만든 폴더가 남는다. 입력 검사 실패는 아무것도 쓰기 전이다.
      if (mounted.current) setPhase({ step: "error", reason: errorReason(e), partial: isAppError(e) && e.kind === "Io" });
    }
  };

  const heading =
    phase.step === "done" ? "내보냈습니다" : phase.step === "error" ? "내보내지 못했습니다" : "마크다운으로 내보내기";

  return (
    <dialog
      ref={ref}
      className="dialog export-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault();
        // 진행 중에는 Rust 쪽 쓰기를 멈출 수 없으므로 닫지 않는다.
        if (!busy) onClose();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {heading}
      </h2>

      {(phase.step === "options" || busy) && (
        <>
          <div className="dialog-body">
            <p>
              "{displayTitle(page.title)}" 페이지를 .md 파일로 저장합니다. 고른 폴더 안에 새 폴더를 만들어 그 안에만 쓰고, 이미지는
              images 폴더로 함께 복사합니다.
            </p>
            {childCount > 0 && (
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={includeChildren}
                  disabled={busy}
                  onChange={(e) => setIncludeChildren(e.target.checked)}
                />
                <span>하위 페이지 포함 (폴더 구조로 저장)</span>
              </label>
            )}
            <p className="export-progress" role="status">
              {phase.step === "reading" && phase.total > 0
                ? `페이지를 읽는 중… ${phase.done}/${phase.total}`
                : phase.step === "writing"
                  ? "저장 위치를 고르면 파일을 씁니다…"
                  : ""}
            </p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              취소
            </button>
            <button
              type="button"
              className="button button-primary export-go"
              data-autofocus
              // disabled로 막으면 포커스가 버튼에서 빠지므로 aria-disabled로 둔다.
              aria-disabled={busy}
              onClick={() => !busy && void run()}
            >
              {busy ? "내보내는 중…" : "저장 위치 고르기…"}
            </button>
          </div>
        </>
      )}

      {phase.step === "done" && (
        <>
          <div className="dialog-body">
            <p>
              파일 {phase.fileCount}개를 이 폴더에 저장했습니다:
              <br />
              <span className="export-path">{phase.dir}</span>
            </p>
            <p>마크다운으로 그대로 옮기지 못한 것이 있습니다.</p>
            <ul className="export-notes">
              {phase.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
          <div className="dialog-actions">
            <button type="button" className="button button-primary" data-autofocus onClick={onClose}>
              확인
            </button>
          </div>
        </>
      )}

      {phase.step === "error" && (
        <>
          <div className="dialog-body" role="alert">
            <p>{phase.reason}.</p>
            <p>
              {phase.partial
                ? "고른 폴더에 일부 파일이 남아 있을 수 있습니다. 노트는 바뀌지 않았습니다."
                : "아무 파일도 쓰지 않았습니다. 노트는 바뀌지 않았습니다."}
            </p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              닫기
            </button>
            <button type="button" className="button button-primary" data-autofocus onClick={() => void run()}>
              다시 시도
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
