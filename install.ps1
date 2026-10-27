# wy-note 설치 스크립트 (Windows PowerShell 5.1 이상)
# 한 줄 설치: irm https://raw.githubusercontent.com/tungasa200/WY-NOTE/main/install.ps1 | iex
# 최신 설치 파일을 받아 현재 사용자로 조용히 설치하고 앱을 실행한다. 관리자 권한은 필요 없다.
# UTF-8(BOM 없음)으로 저장한다. 5.1의 irm은 BOM을 문자로 남겨 iex가 첫 줄을 명령으로 읽는다.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'  # 5.1에서 진행 표시줄이 내려받기를 크게 느리게 한다
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $url = 'https://github.com/tungasa200/WY-NOTE/releases/latest/download/wy-note-setup.exe'
    $setup = Join-Path $env:TEMP "wy-note-setup-$([guid]::NewGuid().ToString('N')).exe"
    $appExe = Join-Path $env:LOCALAPPDATA 'wy-note\wy-note.exe'

    function Fail([string]$msg) {
        Write-Host ''
        Write-Host "설치하지 못했습니다: $msg" -ForegroundColor Red
    }

    if (Get-Process -Name 'wy-note' -ErrorAction SilentlyContinue) {
        Fail 'wy-note가 실행 중입니다. 앱을 닫은 뒤 다시 실행해 주세요.'
        return
    }

    Write-Host 'wy-note 설치 파일을 내려받는 중...'
    try {
        Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing
    } catch {
        Fail "설치 파일을 내려받지 못했습니다. 인터넷 연결을 확인해 주세요. ($($_.Exception.Message))"
        return
    }

    Write-Host '설치하는 중...'
    try {
        # -Wait는 자식 프로세스까지 기다리므로 설치 프로그램 자체만 기다린다. Handle을 먼저 잡아야 5.1에서 ExitCode가 남는다.
        $p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru
        $null = $p.Handle
        $p.WaitForExit()
    } catch {
        Fail "설치 프로그램을 실행하지 못했습니다. 백신 프로그램이 막았는지 확인해 주세요. ($($_.Exception.Message))"
        return
    } finally {
        Remove-Item $setup -Force -ErrorAction SilentlyContinue
    }
    if ($p.ExitCode -ne 0) {
        Fail "설치 프로그램이 오류 코드 $($p.ExitCode)로 끝났습니다."
        return
    }

    if (-not (Test-Path $appExe)) {
        Fail '설치는 끝났지만 실행 파일을 찾지 못했습니다. 시작 메뉴에서 wy-note를 찾아 실행해 주세요.'
        return
    }

    Write-Host 'wy-note 설치를 마쳤습니다. 앱을 실행합니다.' -ForegroundColor Green
    Start-Process -FilePath $appExe
}
