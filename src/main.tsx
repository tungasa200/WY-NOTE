import React from "react";
import ReactDOM from "react-dom/client";
import { initApi } from "./api";
import App from "./App";
import "./styles/tokens.css";
import "./styles/accents.css";

// 백엔드(Tauri 또는 브라우저 mock)를 고른 뒤에 그린다.
void initApi().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
