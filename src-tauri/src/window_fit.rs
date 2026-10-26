//! 창 상태 복원 보정(P4-3). window-state 플러그인은 저장값을 그대로 복원한다. 그래서 최소 크기보다 작은 크기나
//! 화면 밖에 있는 최대화 전 위치(prev_x·prev_y)도 그대로 쓰인다. 플러그인이 파일을 읽기 전에 저장값을 고친다.
use serde_json::Value;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

/// 물리 픽셀 사각형. 창은 x·y가 바깥 왼쪽 위(투명 테두리 포함), w·h가 안쪽 크기다(플러그인 저장 형식).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

/// 모니터의 작업 영역(작업 표시줄을 뺀 곳)과 배율.
struct Area {
    rect: Rect,
    scale: f64,
}

/// Windows 10 창틀(논리 픽셀): 왼쪽·오른쪽·아래의 투명 크기 조절 테두리, 위쪽 제목 표시줄.
/// 안쪽 900×600 창의 바깥 사각형이 916×639로 잰 값이다.
const BORDER: f64 = 8.0;
const TITLE: f64 = 31.0;

fn overlap(a: Rect, b: Rect) -> i64 {
    let span = |a0: i32, al: u32, b0: i32, bl: u32| {
        let (a0, b0) = (a0 as i64, b0 as i64);
        ((a0 + al as i64).min(b0 + bl as i64) - a0.max(b0)).max(0)
    };
    span(a.x, a.w, b.x, b.w) * span(a.y, a.h, b.y, b.h)
}

fn off_screen(r: Rect, areas: &[Area]) -> bool {
    areas.iter().all(|a| overlap(r, a.rect) == 0)
}

/// 길이 size인 구간의 시작을 [start, start+len) 안에 넣는다. 들어가지 않으면 start.
fn clamp_start(pos: i32, start: i32, len: u32, size: u32) -> i32 {
    pos.min(start + len as i32 - size as i32).max(start)
}

/// 창을 가장 많이 겹치는 모니터 안에 넣고 최소 크기(논리 픽셀) 이상으로 만든다. 보이는 창(제목 표시줄 포함,
/// 투명 테두리 제외)이 작업 영역 안에 들어가게 한다. 겹치는 모니터가 없으면 첫 모니터(주 모니터) 가운데에 둔다.
/// 모니터를 모르면 None.
fn fit(win: Rect, min: (f64, f64), areas: &[Area]) -> Option<Rect> {
    let (best, ov) = areas.iter().map(|a| (a, overlap(win, a.rect))).max_by_key(|&(_, o)| o)?;
    let inside = ov > 0;
    let area = if inside { best } else { &areas[0] };
    let a = area.rect;
    let px = |v: f64| (v * area.scale).round();
    let (b, t) = (px(BORDER) as i32, px(TITLE) as u32);
    let w = win.w.min(a.w).max(px(min.0) as u32);
    let h = win.h.min(a.h.saturating_sub(t)).max(px(min.1) as u32);
    let (x, y) = if inside {
        (clamp_start(win.x.saturating_add(b), a.x, a.w, w) - b, clamp_start(win.y, a.y, a.h, h + t))
    } else {
        (a.x + (a.w as i32 - w as i32).max(0) / 2 - b, a.y + (a.h as i32 - (h + t) as i32).max(0) / 2)
    };
    Some(Rect { x, y, w, h })
}

/// 저장된 창 하나(label)를 고친다. 고쳤으면 true.
/// 최대화 상태면 최대화를 풀 때 돌아갈 곳(prev_x·prev_y와 크기)을 고친다.
fn fix_state(state: &mut Value, label: &str, min: (f64, f64), areas: &[Area]) -> bool {
    let Some(s) = state.get_mut(label).and_then(Value::as_object_mut) else {
        return false;
    };
    let maximized = s.get("maximized").and_then(Value::as_bool).unwrap_or(false);
    let (kx, ky) = if maximized { ("prev_x", "prev_y") } else { ("x", "y") };
    let num = |k: &str| s.get(k).and_then(Value::as_i64);
    let pos = |k: &str| num(k).and_then(|v| i32::try_from(v).ok());
    // 크기 0은 플러그인의 '저장값 없음'이다. 범위를 벗어난 값과 함께 건드리지 않는다.
    let size = |k: &str| num(k).and_then(|v| u32::try_from(v).ok()).filter(|&v| v > 0);
    let (Some(x), Some(y), Some(w), Some(h), Some(mx), Some(my)) =
        (pos(kx), pos(ky), size("width"), size("height"), pos("x"), pos("y"))
    else {
        return false;
    };
    let saved = Rect { x, y, w, h };
    // 최대화 전 위치가 어느 화면에도 없으면 최대화된 모니터(x·y) 안으로 옮긴다.
    let win = if maximized && off_screen(saved, areas) { Rect { x: mx, y: my, ..saved } } else { saved };
    let Some(fixed) = fit(win, min, areas) else {
        return false;
    };
    // 플러그인은 x·y가 화면에 걸칠 때만 위치를 복원한다. 최대화된 모니터가 없어졌으면 x·y도 옮겨야 prev를 쓴다.
    let move_max = maximized && off_screen(Rect { x: mx, y: my, ..saved }, areas);
    if fixed == saved && !move_max {
        return false;
    }
    s.insert(kx.into(), fixed.x.into());
    s.insert(ky.into(), fixed.y.into());
    s.insert("width".into(), fixed.w.into());
    s.insert("height".into(), fixed.h.into());
    if move_max {
        s.insert("x".into(), fixed.x.into());
        s.insert("y".into(), fixed.y.into());
    }
    true
}

fn fix_file<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_config_dir()?.join(tauri_plugin_window_state::DEFAULT_FILENAME);
    // 파일이 없으면 첫 실행이다(설정의 기본 크기로 열린다).
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let mut state: Value = serde_json::from_str(&text)?;
    let Some(win) = app.config().app.windows.first() else {
        return Ok(());
    };
    let min = (win.min_width.unwrap_or(0.0), win.min_height.unwrap_or(0.0));
    // 주 모니터를 맨 앞에 둔다(겹치는 모니터가 없을 때 쓴다).
    let primary = app.primary_monitor()?.map(|m| *m.position());
    let mut monitors = app.available_monitors()?;
    monitors.sort_by_key(|m| Some(*m.position()) != primary);
    let areas: Vec<Area> = monitors
        .iter()
        .map(|m| {
            let r = m.work_area();
            Area {
                rect: Rect { x: r.position.x, y: r.position.y, w: r.size.width, h: r.size.height },
                scale: m.scale_factor(),
            }
        })
        .collect();
    if fix_state(&mut state, &win.label, min, &areas) {
        // 쓰다 끊겨도 원래 파일이 남게 임시 파일에 쓰고 바꿔 넣는다.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&state)?)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(())
}

/// window-state 플러그인보다 먼저 등록한다(플러그인 setup은 등록 순서대로 돈다).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("wynote-window-fit")
        .setup(|app, _| {
            // 실패해도 앱은 띄운다(플러그인이 저장값 그대로 복원한다).
            if let Err(e) = fix_file(app) {
                eprintln!("창 상태 보정 실패: {e}");
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MIN: (f64, f64) = (900.0, 600.0);

    fn screens() -> Vec<Area> {
        vec![
            // 주 모니터 1920×1080(작업 표시줄 40), 배율 1
            Area { rect: Rect { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1.0 },
            // 오른쪽 보조 모니터 2560×1440, 배율 1.5
            Area { rect: Rect { x: 1920, y: 0, w: 2560, h: 1400 }, scale: 1.5 },
        ]
    }

    fn saved(x: i32, y: i32, w: u32, h: u32, prev: (i32, i32), maximized: bool) -> Value {
        json!({"main": {"width": w, "height": h, "x": x, "y": y, "prev_x": prev.0, "prev_y": prev.1,
            "maximized": maximized, "visible": true, "decorated": true, "fullscreen": false}})
    }

    fn rect_of(v: &Value, kx: &str, ky: &str) -> Rect {
        let m = &v["main"];
        let n = |k: &str| m[k].as_i64().unwrap();
        Rect { x: n(kx) as i32, y: n(ky) as i32, w: n("width") as u32, h: n("height") as u32 }
    }

    #[test]
    fn too_small_grows_to_min() {
        let mut v = saved(100, 100, 600, 400, (0, 0), false);
        assert!(fix_state(&mut v, "main", MIN, &screens()));
        assert_eq!(rect_of(&v, "x", "y"), Rect { x: 100, y: 100, w: 900, h: 600 });
    }

    #[test]
    fn min_uses_monitor_scale() {
        let mut v = saved(2000, 100, 1000, 700, (0, 0), false);
        assert!(fix_state(&mut v, "main", MIN, &screens()));
        assert_eq!(rect_of(&v, "x", "y"), Rect { x: 2000, y: 100, w: 1350, h: 900 });
    }

    #[test]
    fn off_screen_goes_to_primary_center() {
        let mut v = saved(-5000, -5000, 1200, 800, (0, 0), false);
        assert!(fix_state(&mut v, "main", MIN, &screens()));
        // 보이는 창(1200×(800+31))이 작업 영역 가운데. x는 투명 테두리 8만큼 왼쪽.
        assert_eq!(rect_of(&v, "x", "y"), Rect { x: 352, y: 104, w: 1200, h: 800 });
    }

    #[test]
    fn partly_outside_is_pulled_in() {
        let mut v = saved(1000, 600, 1200, 800, (0, 0), false);
        assert!(fix_state(&mut v, "main", MIN, &screens()));
        assert_eq!(rect_of(&v, "x", "y"), Rect { x: 712, y: 209, w: 1200, h: 800 });
    }

    #[test]
    fn larger_than_screen_shrinks_but_not_below_min() {
        let mut v = saved(-10, -10, 3000, 2000, (0, 0), false);
        assert!(fix_state(&mut v, "main", MIN, &screens()));
        assert_eq!(rect_of(&v, "x", "y"), Rect { x: -8, y: 0, w: 1920, h: 1009 });
        let tiny = [Area { rect: Rect { x: 0, y: 0, w: 800, h: 560 }, scale: 1.0 }];
        let mut v = saved(0, 0, 1200, 800, (0, 0), false);
        assert!(fix_state(&mut v, "main", MIN, &tiny));
        assert_eq!(rect_of(&v, "x", "y"), Rect { x: -8, y: 0, w: 900, h: 600 });
    }

    #[test]
    fn maximized_fixes_prev_on_its_monitor() {
        // 보조 모니터에서 최대화, 최대화 전 위치가 화면 밖(-5000)
        let mut v = saved(1912, -8, 1200, 800, (-5000, -5000), true);
        assert!(fix_state(&mut v, "main", MIN, &screens()));
        assert_eq!(rect_of(&v, "prev_x", "prev_y"), Rect { x: 1912, y: 0, w: 1350, h: 900 });
        assert_eq!((v["main"]["x"].as_i64(), v["main"]["y"].as_i64()), (Some(1912), Some(-8)), "최대화 위치는 그대로");
        // 최대화된 모니터도 없으면(모니터 분리) 주 모니터 가운데
        let mut v = saved(5000, 0, 1200, 800, (-5000, -5000), true);
        assert!(fix_state(&mut v, "main", MIN, &screens()));
        assert_eq!(rect_of(&v, "prev_x", "prev_y"), Rect { x: 352, y: 104, w: 1200, h: 800 });
        // 플러그인이 prev를 쓰도록 x·y도 화면 안으로
        assert_eq!(rect_of(&v, "x", "y"), Rect { x: 352, y: 104, w: 1200, h: 800 });
    }

    #[test]
    fn valid_state_is_left_alone() {
        for mut v in [
            saved(100, 100, 1200, 800, (0, 0), false),
            saved(0, 0, 900, 600, (0, 0), false),
            saved(-8, -8, 1200, 800, (100, 100), true),
            // 왼쪽 절반에 붙인 창(투명 테두리만큼 화면 밖)
            saved(-8, 0, 952, 1009, (0, 0), false),
        ] {
            let before = v.clone();
            assert!(!fix_state(&mut v, "main", MIN, &screens()));
            assert_eq!(v, before);
        }
    }

    #[test]
    fn unknown_shapes_are_left_alone() {
        let mut v = saved(0, 0, 0, 0, (0, 0), false);
        assert!(!fix_state(&mut v, "main", MIN, &screens()), "크기 0은 저장값 없음");
        let mut v = json!({"main": {"width": "x"}});
        assert!(!fix_state(&mut v, "main", MIN, &screens()));
        let mut v = json!({"main": {"width": 5_000_000_000u64, "height": 800, "x": 0, "y": 0}});
        assert!(!fix_state(&mut v, "main", MIN, &screens()), "범위 밖 값");
        let mut v = json!({"other": {}});
        assert!(!fix_state(&mut v, "main", MIN, &screens()));
        let mut v = saved(-5000, -5000, 600, 400, (0, 0), false);
        assert!(!fix_state(&mut v, "main", MIN, &[]), "모니터를 모르면 그대로");
    }
}
