# wy-note

이 PC에서만 쓰는 오프라인 우선 블록 노트 데스크탑 앱(Windows 전용).

## 설치

### 한 줄 설치(PowerShell)

PowerShell을 열고 아래 한 줄을 실행합니다. 최신 설치 파일을 받아 현재 사용자로 설치하고 앱을 실행합니다. 관리자 권한은 필요 없습니다.

```powershell
irm https://raw.githubusercontent.com/tungasa200/WY-NOTE/main/install.ps1 | iex
```

### 설치 파일 직접 받기

[wy-note-setup.exe](https://github.com/tungasa200/WY-NOTE/releases/latest/download/wy-note-setup.exe)를 받아 실행합니다. 설치 파일에 코드 서명이 없어서 "Windows의 PC 보호" 경고가 뜨면 **추가 정보 → 실행**을 누릅니다. 지난 버전은 [Releases](https://github.com/tungasa200/WY-NOTE/releases)에 있습니다.

### 소스로 빌드

1. [Node.js LTS](https://nodejs.org/) 설치
2. [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)에서 **C++를 사용한 데스크톱 개발** 워크로드 설치
3. [rustup](https://rustup.rs/)으로 Rust 설치
4. 저장소 폴더에서 아래를 실행합니다. 설치 파일은 `src-tauri/target/release/bundle/nsis/`에 생깁니다.

```powershell
npm install
npm run tauri build
```
