//! 마크다운 내보내기 파일 쓰기(F-06, 계약-AI 5절). 저장 위치는 Rust가 폴더 선택 창으로 직접 고른다.
//! 고른 폴더 안에 새 폴더 하나를 만들고 그 안에만 쓴다. 모든 파일을 create_new로 열어 덮어쓰지 않는다.
use crate::commands::AppState;
use crate::db::attachments::mime_for;
use crate::error::{AppError, AppResult, ErrorKind};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind as IoKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// 화면이 보내는 `pageId`는 쓰기에 필요 없어 받지 않는다(serde가 모르는 필드는 무시).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportNode {
    title: String,
    markdown: String,
    #[serde(default)]
    children: Vec<ExportNode>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    cancelled: bool,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    done: Option<ExportDone>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportDone {
    dir: String,
    file_count: usize,
    image_count: usize,
    missing_images: Vec<String>,
}

#[tauri::command]
pub async fn export_markdown(
    app: AppHandle,
    state: State<'_, AppState>,
    root: ExportNode,
    attachments: Vec<String>,
) -> AppResult<ExportResult> {
    if let Some(bad) = attachments.iter().find(|n| !is_attachment_name(n)) {
        return Err(AppError::new(ErrorKind::InvalidInput, format!("첨부 이름이 잘못되었습니다: {bad}")));
    }
    let src_dir = state.attachments_dir();
    // 선택 창 대기·파일 복사는 막는 작업이라 async 작업 스레드가 아닌 blocking 스레드에서 한다(메인 스레드 금지).
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("내보낼 위치 선택");
        if let Some(w) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&w);
        }
        let Some(picked) = dialog.blocking_pick_folder() else {
            return Ok(ExportResult { cancelled: true, done: None });
        };
        let parent = picked.into_path().map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?;
        let done = write_export(&parent, &root, &attachments, &src_dir)?;
        *app.state::<LastExport>().lock() = Some(PathBuf::from(&done.dir));
        Ok(ExportResult { cancelled: false, done: Some(done) })
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, format!("내보내기 작업이 비정상 종료되었습니다: {e}")))?
}

/// 마지막으로 내보낸 폴더. 앱을 다시 켜면 비어 있다. 화면이 경로를 넘기지 않게 Rust가 기억한다.
#[derive(Default)]
pub struct LastExport(Mutex<Option<PathBuf>>);

impl LastExport {
    fn lock(&self) -> MutexGuard<'_, Option<PathBuf>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 마지막 내보내기 폴더만 탐색기로 연다. opener의 Rust API를 쓰므로 화면 권한(opener 범위)은 넓히지 않는다.
#[tauri::command]
pub async fn open_export_dir(app: AppHandle, last: State<'_, LastExport>) -> AppResult<()> {
    let dir = last.lock().clone().filter(|d| d.is_dir());
    let dir = dir.ok_or_else(|| AppError::new(ErrorKind::NotFound, "열 내보내기 폴더가 없습니다"))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::new(ErrorKind::Io, format!("폴더를 열지 못했습니다: {e}")))
}

/// `save_attachment`가 만든 모양(`<숫자>.<허용 확장자>`)만 받는다. 경로 구분자·`..`는 여기서 걸러진다.
fn is_attachment_name(name: &str) -> bool {
    match name.split_once('.') {
        Some((id, ext)) => {
            !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && ext == ext.to_ascii_lowercase() && mime_for(ext).is_some()
        }
        None => false,
    }
}

/// 쓰다가 실패하면 `Io`로 돌려주고, 만든 폴더는 지우지 않는다(사용자가 고른 곳의 파일을 앱이 지우지 않게).
fn write_export(parent: &Path, root: &ExportNode, attachments: &[String], src_dir: &Path) -> AppResult<ExportDone> {
    let base = file_name(&root.title);
    let top = create_unique_dir(parent, &base)?;
    // 꼭대기 페이지의 하위 폴더는 images\의 형제라 형제 이름 규칙으로 겹침을 피한다.
    let root_name = unique_name(&base, &mut HashSet::from(["images".to_owned()]));
    let mut file_count = 0;
    write_node(&top, &root_name, root, &mut file_count)?;

    let mut image_count = 0;
    let mut missing_images = Vec::new();
    let mut seen = HashSet::new();
    let images = top.join("images");
    for name in attachments.iter().filter(|n| seen.insert(n.as_str())) {
        let src = match File::open(src_dir.join(name)) {
            Ok(f) => f,
            Err(e) if e.kind() == IoKind::NotFound => {
                missing_images.push(name.clone());
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        if image_count == 0 {
            fs::create_dir(&images)?;
        }
        io::copy(&mut io::BufReader::new(src), &mut create_new(&images.join(name))?)?;
        image_count += 1;
    }
    Ok(ExportDone { dir: top.to_string_lossy().into_owned(), file_count, image_count, missing_images })
}

/// `<dir>\<name>.md`를 쓰고, 하위가 있으면 같은 이름의 폴더 `<dir>\<name>\`에 하위를 쓴다.
fn write_node(dir: &Path, name: &str, node: &ExportNode, count: &mut usize) -> AppResult<()> {
    create_new(&dir.join(format!("{name}.md")))?.write_all(node.markdown.as_bytes())?;
    *count += 1;
    if node.children.is_empty() {
        return Ok(());
    }
    let sub = dir.join(name);
    fs::create_dir(&sub)?;
    let mut used = HashSet::new();
    for child in &node.children {
        let child_name = unique_name(&file_name(&child.title), &mut used);
        write_node(&sub, &child_name, child, count)?;
    }
    Ok(())
}

fn create_new(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// `<이름>`이 있으면 `<이름> (2)`, `(3)`…
fn create_unique_dir(parent: &Path, base: &str) -> AppResult<PathBuf> {
    for n in 1..10_000 {
        let path = parent.join(numbered(base, n));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == IoKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::new(ErrorKind::Io, "내보낼 폴더 이름을 만들 수 없습니다"))
}

fn numbered(base: &str, n: usize) -> String {
    if n == 1 { base.to_owned() } else { format!("{base} ({n})") }
}

/// 형제끼리 대소문자를 무시하고 겹치면 번호를 붙인다. 이름 하나가 `<이름>.md`와 폴더 `<이름>`을 함께 차지하므로
/// 둘 다 비어 있어야 쓴다(형제 `x.md`의 폴더가 형제 `x`의 파일 `x.md`와 부딪히지 않게).
fn unique_name(base: &str, used: &mut HashSet<String>) -> String {
    let name = (1..)
        .map(|n| numbered(base, n))
        .find(|c| {
            let c = c.to_lowercase();
            !used.contains(&c) && !used.contains(&format!("{c}.md"))
        })
        .unwrap_or_default();
    let lower = name.to_lowercase();
    used.insert(format!("{lower}.md"));
    used.insert(lower);
    name
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
    "LPT9", "LPT¹", "LPT²", "LPT³",
];
const MAX_NAME: usize = 100;

/// 제목 → Windows에서 쓸 수 있는 파일 이름(확장자 없음, 계약-AI 5.2).
fn file_name(title: &str) -> String {
    let mapped: String = title
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .take(MAX_NAME)
        .collect();
    let mut name = mapped.trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() {
        return "제목 없음".into();
    }
    let stem_len = name.find('.').unwrap_or(name.len());
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&name[..stem_len])) {
        name.insert(stem_len, '_');
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::temp_dir;

    fn node(title: &str, md: &str, children: Vec<ExportNode>) -> ExportNode {
        ExportNode { title: title.into(), markdown: md.into(), children }
    }

    #[test]
    fn file_names() {
        assert_eq!(file_name(r#"a<b>c:d"e/f\g|h?i*j"#), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(file_name("탭\t줄\n"), "탭_줄_");
        assert_eq!(file_name("끝점. . "), "끝점");
        assert_eq!(file_name("   "), "제목 없음");
        assert_eq!(file_name(""), "제목 없음");
        assert_eq!(file_name("..."), "제목 없음");
        assert_eq!(file_name("con"), "con_");
        assert_eq!(file_name("LPT9.txt"), "LPT9_.txt");
        assert_eq!(file_name("Console"), "Console");
        assert_eq!(file_name("com0"), "com0_");
        assert_eq!(file_name("LPT²"), "LPT²_");
        assert_eq!(file_name("conin$.md"), "conin$_.md");
        assert_eq!(file_name(&"가".repeat(150)).chars().count(), 100);
        assert_eq!(file_name(&format!("{}.", "a".repeat(99))), "a".repeat(99));
    }

    #[test]
    fn sibling_names_unique_case_insensitive() {
        let mut used = HashSet::new();
        let got: Vec<_> = ["Note", "note", "NOTE", "Note (2)"].iter().map(|n| unique_name(n, &mut used)).collect();
        assert_eq!(got, ["Note", "note (2)", "NOTE (3)", "Note (2) (2)"]);
        let mut used = HashSet::new();
        let got: Vec<_> = ["x", "X.md", "y.md", "Y"].iter().map(|n| unique_name(n, &mut used)).collect();
        assert_eq!(got, ["x", "X.md (2)", "y.md", "Y (2)"]);
    }

    #[test]
    fn attachment_names() {
        for ok in ["12.png", "1.jpeg", "300.webp"] {
            assert!(is_attachment_name(ok), "{ok}");
        }
        for bad in ["../1.png", "1.PNG", "a.png", ".png", "1.exe", "1", "1.png/..", "1.png.png", r"..\1.png", "C:1.png"] {
            assert!(!is_attachment_name(bad), "{bad}");
        }
    }

    #[test]
    fn writes_tree_images_and_never_overwrites() {
        let dir = temp_dir("export");
        let src = dir.join("attachments");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("1.png"), b"img").unwrap();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();

        let root = node(
            "메인",
            "# 메인\n![](images/1.png)",
            vec![node("하위", "a", vec![node("손주", "b", vec![])]), node("하위", "c", vec![]), node("", "d", vec![])],
        );
        let atts = vec!["1.png".to_string(), "2.png".into(), "1.png".into()];
        let done = write_export(&out, &root, &atts, &src).unwrap();
        let top = out.join("메인");
        assert_eq!(done.dir, top.to_string_lossy());
        assert_eq!((done.file_count, done.image_count), (5, 1));
        assert_eq!(done.missing_images, ["2.png"]);
        assert_eq!(fs::read_to_string(top.join("메인.md")).unwrap(), "# 메인\n![](images/1.png)");
        assert_eq!(fs::read(top.join("images/1.png")).unwrap(), b"img");
        assert_eq!(fs::read_to_string(top.join("메인/하위.md")).unwrap(), "a");
        assert_eq!(fs::read_to_string(top.join("메인/하위/손주.md")).unwrap(), "b");
        assert_eq!(fs::read_to_string(top.join("메인/하위 (2).md")).unwrap(), "c");
        assert_eq!(fs::read_to_string(top.join("메인/제목 없음.md")).unwrap(), "d");
        assert!(!top.join("메인/하위 (2)").exists());

        // 같은 곳에 다시 내보내면 새 폴더에 쓰고 앞의 것은 그대로 둔다.
        let again = write_export(&out, &node("메인", "new", vec![]), &[], &src).unwrap();
        assert_eq!(again.dir, out.join("메인 (2)").to_string_lossy());
        assert!(!out.join("메인 (2)/images").exists());
        assert_eq!(fs::read_to_string(top.join("메인.md")).unwrap(), "# 메인\n![](images/1.png)");
        let img = write_export(&out, &node("Images", "x", vec![node("c", "y", vec![])]), &atts[..1], &src).unwrap();
        let img_top = PathBuf::from(&img.dir);
        assert!(img_top.join("Images (2).md").exists() && img_top.join("Images (2)/c.md").exists());
        assert!(img_top.join("images/1.png").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn result_shape() {
        let v = serde_json::to_value(ExportResult { cancelled: true, done: None }).unwrap();
        assert_eq!(v, serde_json::json!({ "cancelled": true }));
        let done = ExportDone { dir: "d".into(), file_count: 1, image_count: 0, missing_images: vec![] };
        let v = serde_json::to_value(ExportResult { cancelled: false, done: Some(done) }).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "cancelled": false, "dir": "d", "fileCount": 1, "imageCount": 0, "missingImages": [] })
        );
    }
}
