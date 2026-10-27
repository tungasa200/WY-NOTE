// 앱을 켤 때 화면을 그리기 전에 지난번 테마·강조색을 넣는다(번쩍임 막기, P5-2).
// 기준 값은 ui_state이고 여기서 읽는 것은 src/app/appearance.ts가 남긴 사본이다.
// CSP가 인라인 스크립트를 막으므로(script-src 'self') 따로 파일로 두고 <head>에서 동기로 부른다.
// 번들 밖이라 appearance.ts를 못 불러온다: 키(CACHE_KEY)·강조색 목록(ACCENTS)을 바꾸면 여기도 고친다.
(function () {
  try {
    var a = JSON.parse(localStorage.getItem("wy-note-appearance") || "null");
    if (!a) return;
    var html = document.documentElement;
    if (a.theme === "light" || a.theme === "dark") html.setAttribute("data-theme", a.theme);
    if (["navy", "plum", "rust", "gray"].indexOf(a.accent) >= 0) html.setAttribute("data-accent", a.accent);
  } catch (e) {
    // 읽지 못하면 기본(Windows 설정·먹청록)으로 그린다.
  }
})();
