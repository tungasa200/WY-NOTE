// 설정의 AI 부분(화면설계 S-08, F-08.4·F-08.6·F-08.7). 앱의 설정 화면이 이 컴포넌트를 넣는다.
// 키는 붙여넣은 뒤 시험 호출이 통과해야 저장된다(set_api_key). 화면은 끝 4자리만 받는다. 키 원문은 이 화면의 입력칸에만 잠깐 있다.
import { useEffect, useId, useRef, useState } from "react";
import { AI_FAIL, errorReason } from "../api";
import { aiApi } from "../api/ai";
import type { AiUsageDay, KeyStatus } from "../lib/ai-types";
import { notifyAiStatusChanged, useAiStatus, useOnline } from "./useAiStatus";
import "./AiSettings.css";

const fmt = (n: number) => n.toLocaleString("ko-KR");

export function AiSettings() {
  return (
    <div className="ai-settings">
      <KeySection />
      <LimitSection />
      <UsageSection />
    </div>
  );
}

function KeySection() {
  const online = useOnline();
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  // 누른 버튼이 사라진 뒤 포커스를 줄 곳(다음 그리기 뒤에 옮긴다).
  const focusNext = useRef<"input" | "change" | null>(null);
  const helpId = useId();

  const load = () => {
    setLoadError(false);
    aiApi.hasApiKey().then(setKey, () => setLoadError(true));
  };
  useEffect(load, []);

  useEffect(() => {
    const f = focusNext.current;
    focusNext.current = null;
    if (f === "input") inputRef.current?.focus();
    if (f === "change") changeRef.current?.focus();
  });

  const savingRef = useRef(false); // 두 번 제출 막기(상태는 다음 그리기 때 바뀐다)
  const save = async () => {
    const k = draft.trim();
    if (!k || savingRef.current || !online) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const { last4 } = await aiApi.setApiKey(k);
      setKey({ present: true, last4 });
      setDraft("");
      setEditing(false);
      focusNext.current = "change";
      notifyAiStatusChanged();
    } catch (e) {
      setError(`키를 확인하지 못했습니다: ${errorReason(e, AI_FAIL)}.`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirming(false);
    try {
      await aiApi.deleteApiKey();
      setKey({ present: false, last4: null });
      setEditing(false);
      setError("");
      focusNext.current = "input";
      notifyAiStatusChanged();
    } catch (e) {
      setError(`키를 삭제하지 못했습니다: ${errorReason(e, AI_FAIL)}.`);
    }
  };

  const showInput = key !== null && (!key.present || editing);

  return (
    <section className="ai-set-section" aria-labelledby="ai-set-key">
      <h3 id="ai-set-key" className="ai-set-title">
        Claude API 키
      </h3>
      {key === null && !loadError && <p className="ai-set-help">읽는 중…</p>}
      {loadError && (
        <p className="ai-set-error" role="alert">
          키 상태를 읽지 못했습니다.{" "}
          <button type="button" className="button ai-set-small" onClick={load}>
            다시 읽기
          </button>
        </p>
      )}
      {key?.present && !editing && (
        <div className="ai-set-row">
          <span className="ai-set-masked" aria-label={`저장된 키, 끝 4자리 ${key.last4 ?? ""}`}>
            ••••••••••••{key.last4}
          </span>
          <span className="ai-set-ok">확인됨</span>
          <button
            ref={changeRef}
            type="button"
            className="button"
            onClick={() => {
              setEditing(true);
              setError("");
              focusNext.current = "input";
            }}
          >
            바꾸기
          </button>
          <button type="button" className="button ai-set-danger-text" onClick={() => setConfirming(true)}>
            삭제
          </button>
        </div>
      )}
      {showInput && (
        <form
          className="ai-set-row"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            ref={inputRef}
            className="ai-set-input ai-set-key-input"
            type="password"
            aria-label="Claude API 키"
            aria-describedby={helpId}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-로 시작하는 키 붙여넣기"
            value={draft}
            disabled={saving}
            onChange={(e) => {
              setDraft(e.target.value);
              setError("");
            }}
          />
          <button type="submit" className="button button-primary" disabled={!draft.trim() || saving || !online}>
            {saving ? "확인하는 중…" : "확인하고 저장"}
          </button>
          {editing && (
            <button
              type="button"
              className="button"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setDraft("");
                setError("");
                focusNext.current = "change";
              }}
            >
              취소
            </button>
          )}
        </form>
      )}
      {(showInput || error) && (
        <p id={helpId} className={error ? "ai-set-error" : "ai-set-help"} role={error ? "alert" : undefined}>
          {error ||
            (online
              ? "붙여넣은 키로 짧은 시험 호출을 해서 통과하면 Windows 자격 증명 관리자에 저장합니다."
              : "오프라인에서는 확인할 수 없습니다")}
        </p>
      )}
      {confirming && <DeleteKeyDialog onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />}
    </section>
  );
}

/** 삭제 확인(S-08). 실수로 지우지 않게 처음 포커스는 취소에 둔다(공용 ConfirmDialog는 위험 버튼에 둔다). 오프라인에서도 지울 수 있다. */
function DeleteKeyDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dlg = ref.current!;
    if (!dlg.open) dlg.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dlg.open) dlg.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="ai-del-title"
      aria-describedby="ai-del-body"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="ai-del-title" className="dialog-title">
        API 키를 삭제할까요?
      </h2>
      <p id="ai-del-body" className="dialog-body">
        자격 증명 관리자에서 지웁니다. 다시 쓰려면 키를 새로 붙여넣어야 합니다.
      </p>
      <div className="dialog-actions">
        <button ref={cancelRef} type="button" className="button" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="button button-danger" onClick={onConfirm}>
          삭제
        </button>
      </div>
    </dialog>
  );
}

function LimitSection() {
  const { status } = useAiStatus(null);
  const [value, setValue] = useState<string | null>(null); // null: 아직 상태를 받지 않음
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<number | null>(null); // 아직 보내지 않은 값(닫을 때 마저 저장)

  useEffect(() => {
    if (status && value === null) setValue(String(status.dailyLimit));
  }, [status, value]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(savedTimer.current);
      if (pending.current !== null) void aiApi.setDailyLimit(pending.current).then(notifyAiStatusChanged, () => {});
    },
    [],
  );

  const change = (v: string) => {
    setValue(v);
    setSaved(false);
    clearTimeout(timer.current);
    const n = Number(v);
    if (!/^\d+$/.test(v) || n < 1 || n > 1000) {
      pending.current = null;
      setError("1~1000 사이의 정수를 넣으세요.");
      return;
    }
    setError("");
    pending.current = n;
    // 입력하는 동안 매 글자 저장하지 않게 잠깐 기다린다.
    timer.current = setTimeout(async () => {
      pending.current = null;
      try {
        await aiApi.setDailyLimit(n);
        notifyAiStatusChanged();
        setSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1500);
      } catch (e) {
        setError(`저장하지 못했습니다: ${errorReason(e, AI_FAIL)}.`);
      }
    }, 400);
  };

  return (
    <section className="ai-set-section" aria-labelledby="ai-set-limit">
      <h3 id="ai-set-limit" className="ai-set-title">
        하루 호출 상한
      </h3>
      <div className="ai-set-row">
        <input
          className="ai-set-input ai-set-number"
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          step={1}
          aria-labelledby="ai-set-limit"
          aria-invalid={error ? true : undefined}
          aria-describedby="ai-set-limit-msg"
          value={value ?? ""}
          disabled={value === null}
          onChange={(e) => change(e.target.value)}
        />
        <span className="ai-set-help">회 · 오늘 {status ? `${fmt(status.todayCalls)}회` : "…"} 사용</span>
        <span className="ai-set-saved" role="status">
          {saved ? "저장됨" : ""}
        </span>
      </div>
      <p id="ai-set-limit-msg" className={error ? "ai-set-error" : "ai-set-help"}>
        {error || "자정(PC 시간)에 0으로 돌아갑니다. 상한에 닿으면 그날은 AI를 쓸 수 없습니다."}
      </p>
      <h3 className="ai-set-title">한 번에 보낼 수 있는 글</h3>
      <p className="ai-set-help">최대 20,000자. 넘으면 자동으로 잘라 보내지 않고 범위를 줄이라고 알립니다.</p>
    </section>
  );
}

function UsageSection() {
  const [rows, setRows] = useState<AiUsageDay[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      aiApi.listUsage(30).then(
        (r) => alive && (setRows(r), setFailed(false)),
        () => alive && setFailed(true),
      );
    void load();
    window.addEventListener("wy-ai-status-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("wy-ai-status-changed", load);
    };
  }, []);

  return (
    <section className="ai-set-section" aria-labelledby="ai-set-usage">
      <h3 id="ai-set-usage" className="ai-set-title">
        사용 기록 (최근 30일)
      </h3>
      {failed && (
        <p className="ai-set-error" role="alert">
          사용 기록을 읽지 못했습니다.
        </p>
      )}
      {rows === null && !failed && <p className="ai-set-help">읽는 중…</p>}
      {rows?.length === 0 && <p className="ai-set-help">아직 호출하지 않았습니다.</p>}
      {rows && rows.length > 0 && (
        <table className="ai-set-table">
          <thead>
            <tr>
              <th scope="col">날짜</th>
              <th scope="col">호출</th>
              <th scope="col">보낸 글자</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.day}>
                <td>{r.day}</td>
                <td>{fmt(r.calls)}</td>
                <td>{fmt(r.inputChars)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="ai-set-help">노트 내용은 기록하지 않습니다.</p>
    </section>
  );
}
