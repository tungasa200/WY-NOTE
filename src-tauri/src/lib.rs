mod ai;
mod commands;
mod db;
mod error;
mod export;
mod secret;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewWindowBuilder};

/// 앱 자체 주소와 wyasset만 허용한다(NF-06). 그 밖의 탐색·새 창은 막는다.
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match (url.scheme(), url.host_str()) {
        ("http" | "https", Some("tauri.localhost" | "wyasset.localhost")) => true,
        ("tauri" | "wyasset", Some("localhost")) => true,
        _ => cfg!(debug_assertions) && dev_url.is_some_and(|d| d.origin() == url.origin()),
    }
}

/// 디버그 빌드에서만 이 환경 변수로 데이터 폴더를 바꾼다(테스트 데이터 격리, 카드 4-④). 릴리스 빌드에는 이 코드가 없다.
const DATA_DIR_ENV: &str = "WYNOTE_DATA_DIR";

fn data_dir_override() -> Option<std::path::PathBuf> {
    // cfg!는 컴파일 때 정해지는 상수라 릴리스 빌드에서는 아래가 통째로 빠진다.
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()).map(Into::into)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 두 번째 실행이면 새 창 대신 켜진 창을 앞으로(NF-03). 가장 먼저 등록해야 한다.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = match data_dir_override() {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
            // 실패해도 앱은 띄우고, 명령마다 이 오류를 돌려줘 화면이 알리게 한다.
            let db = std::fs::create_dir_all(data_dir.join("attachments"))
                .map_err(error::AppError::from)
                .and_then(|_| db::open(&data_dir.join("wy-note.db")));
            if let Err(e) = &db {
                eprintln!("DB 열기 실패: {e}");
            }
            app.manage(commands::AppState::new(db, data_dir));
            // 실패해도 앱은 띄운다. 키 명령이 Keyring 오류를 돌려준다.
            if let Err(e) = secret::init() {
                eprintln!("자격 증명 저장소 준비 실패: {e}");
            }
            app.manage(ai::AiState::new());
            app.manage(export::LastExport::default());

            // 창은 tauri.conf.json에서 create=false로 두고 여기서 만든다(탐색 차단을 걸기 위해).
            let config = app.config().app.windows.first().ok_or("창 설정이 없습니다")?.clone();
            let dev_url = app.config().build.dev_url.clone();
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(move |url| is_app_url(url, dev_url.as_ref()))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        // 파일 읽기가 화면 스레드를 막지 않게 비동기 프로토콜로 받아 작업 스레드에서 읽는다.
        .register_asynchronous_uri_scheme_protocol("wyasset", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_owned();
            tauri::async_runtime::spawn_blocking(move || responder.respond(commands::asset_response(&app, &path)));
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tree,
            commands::get_page,
            commands::create_page,
            commands::rename_page,
            commands::save_page,
            commands::move_page,
            commands::set_expanded,
            commands::trash_page,
            commands::list_trash,
            commands::restore_page,
            commands::delete_page_permanently,
            commands::empty_trash,
            commands::search,
            commands::get_start_page_id,
            commands::set_last_page,
            commands::save_attachment,
            commands::get_data_dir,
            commands::get_ui_state,
            commands::set_ui_state,
            ai::set_api_key,
            ai::has_api_key,
            ai::delete_api_key,
            ai::ai_summarize,
            ai::ai_rewrite,
            ai::ai_ask,
            ai::ai_cancel,
            ai::get_ai_status,
            ai::set_ai_exclude,
            ai::set_ai_daily_limit,
            ai::list_ai_usage,
            export::export_markdown,
            export::open_export_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event
                && let Some(state) = app.try_state::<commands::AppState>()
            {
                state.checkpoint();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 환경 변수를 건드리는 테스트는 이것 하나뿐이라 다른 테스트와 부딪히지 않는다.
    #[test]
    fn data_dir_env_only_in_debug() {
        let dir = std::env::temp_dir().join("wy-note-env-test");
        // SAFETY: 이 변수를 읽거나 쓰는 다른 스레드가 없다.
        unsafe { std::env::set_var(DATA_DIR_ENV, &dir) };
        let got = data_dir_override();
        unsafe { std::env::set_var(DATA_DIR_ENV, "") };
        let empty = data_dir_override();
        unsafe { std::env::remove_var(DATA_DIR_ENV) };
        if cfg!(debug_assertions) {
            assert_eq!(got, Some(dir));
        } else {
            assert_eq!(got, None, "릴리스 빌드는 환경 변수를 무시해야 한다");
        }
        assert_eq!(empty, None);
        assert_eq!(data_dir_override(), None);
    }

    #[test]
    fn navigation_allows_only_app_urls() {
        let dev: Url = "http://localhost:1420".parse().unwrap();
        let ok = ["http://tauri.localhost/", "tauri://localhost/index.html", "http://wyasset.localhost/1.png"];
        for u in ok {
            assert!(is_app_url(&u.parse().unwrap(), Some(&dev)), "{u}");
        }
        // 개발 서버 주소는 디버그 빌드에서만 허용한다.
        assert_eq!(is_app_url(&"http://localhost:1420/x".parse().unwrap(), Some(&dev)), cfg!(debug_assertions));
        let bad = [
            "https://example.com/",
            "http://localhost:8080/",
            "http://evil.tauri.localhost.example.com/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "about:blank",
        ];
        for u in bad {
            assert!(!is_app_url(&u.parse().unwrap(), Some(&dev)), "{u}");
        }
    }
}
