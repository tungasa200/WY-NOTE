import { errorReason, isAppError } from "../api";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "./image";

/** 넣지 않은 이유(S-13). 외부 이미지는 이름이 없어 수만 센다. */
type Reason = "remote" | "svg" | "tooBig" | "badType" | "failed";
type FileReason = Exclude<Reason, "remote">;

const LABELS: Record<Reason, string> = {
  remote: "외부 이미지",
  svg: "SVG",
  tooBig: "20MB 초과",
  badType: "넣을 수 없는 형식",
  failed: "저장 실패",
};

/** 한 번의 붙여넣기·끌어 놓기·파일 선택에서 넣지 않은 것. 알림 하나로 합친다. */
export class ImageBatch {
  private rejected = new Map<FileReason, string[]>();
  private failReason = "";
  inserted = 0;

  constructor(private remote = 0) {}

  private add(reason: FileReason, file: File) {
    const names = this.rejected.get(reason);
    if (names) names.push(file.name);
    else this.rejected.set(reason, [file.name]);
  }

  /** 넣을 수 있는 파일만 돌려주고 나머지는 이유와 함께 적어 둔다(사용자 결정: SVG 제외·20MB 상한). */
  check(files: File[]): File[] {
    return files.filter((f) => {
      if (isSvg(f)) this.add("svg", f);
      else if (!IMAGE_TYPES.includes(f.type)) this.add("badType", f);
      else if (f.size > MAX_IMAGE_BYTES) this.add("tooBig", f);
      else return true;
      return false;
    });
  }

  /** 저장 명령이 거절한 파일. Rust의 형식·크기 검사(FileTooLarge·UnsupportedType)도 같은 이유로 센다. */
  fail(file: File, error: unknown) {
    const kind: string | undefined = isAppError(error) ? error.kind : undefined;
    if (kind === "FileTooLarge") this.add("tooBig", file);
    else if (kind === "UnsupportedType") this.add(isSvg(file) ? "svg" : "badType", file);
    else {
      this.add("failed", file);
      this.failReason ||= (error instanceof Error ? error.message : errorReason(error)) || "알 수 없는 오류";
    }
  }

  /** S-13 알림 문구. 넣지 않은 것이 없으면 "". */
  message(): string {
    // 외부 이미지를 맨 앞에 두어 이유 순서를 전과 같게 한다.
    const entries: [Reason, number][] = [...this.rejected].map(([r, names]) => [r, names.length]);
    if (this.remote) entries.unshift(["remote", this.remote]);
    if (!entries.length) return "";
    const skipped = entries.reduce((n, [, count]) => n + count, 0);
    if (entries.length === 1 && this.inserted === 0) {
      const [reason, count] = entries[0];
      const names = reason === "remote" ? [] : this.rejected.get(reason)!;
      switch (reason) {
        case "remote":
          return `외부 이미지 ${count}개는 넣지 않았습니다.`;
        case "svg":
          return "SVG 이미지는 넣을 수 없습니다. PNG로 바꿔 넣으세요.";
        case "tooBig":
          return `20MB가 넘는 이미지는 넣지 않았습니다: ${fileNames(names)}`;
        case "badType":
          return `넣을 수 없는 형식입니다: ${fileNames(names)}. PNG·JPG·GIF·WebP만 넣을 수 있습니다.`;
        case "failed":
          return `이미지를 저장하지 못했습니다(${this.failReason}). 그 이미지를 다시 넣어 보세요.`;
      }
    }
    const total = this.inserted + skipped;
    // 이유가 셋 이상이면 두 줄을 넘으므로 개수만 쓴다.
    const detail = entries.length > 2 ? `${skipped}개` : entries.map(([r, count]) => `${LABELS[r]} ${count}개`).join(", ");
    return this.inserted
      ? `이미지 ${total}개 중 ${this.inserted}개를 넣었습니다. ${detail}는 넣지 않았습니다.`
      : `이미지 ${total}개를 넣지 않았습니다: ${detail}.`;
  }
}

function isSvg(file: File) {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

/** 긴 파일 이름은 가운데를 줄인다(앞 16자…확장자). 여럿이면 앞의 두 개만. */
function fileNames(names: string[]) {
  const short = (name: string) => {
    if (!name) return "이름 없는 파일";
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot) : "";
    const base = ext ? name.slice(0, dot) : name;
    return base.length > 16 ? `${base.slice(0, 16)}…${ext}` : name;
  };
  const shown = names.slice(0, 2).map(short).join(", ");
  return names.length > 2 ? `${shown} 외 ${names.length - 2}개` : shown;
}
