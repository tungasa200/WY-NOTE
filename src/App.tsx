import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppShell } from "./app/AppShell";
import "./App.css";

function App() {
  // 창은 숨긴 채 만들어진다(tauri.conf.json visible=false). 테마 색이 입혀진 첫 화면을 그린 뒤 보인다(F-09).
  useEffect(() => {
    // 실패하면 Rust가 3초 뒤 대신 보인다(lib.rs).
    if (isTauri()) getCurrentWindow().show().catch(() => {});
  }, []);
  return <AppShell />;
}

export default App;
