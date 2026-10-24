param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\PersonalMemory"
)

$ErrorActionPreference = 'Stop'
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$configPath = Join-Path $InstallRoot 'config.json'
$startService = Join-Path $InstallRoot 'scripts\start-service.ps1'
$stopService = Join-Path $InstallRoot 'scripts\stop-service.ps1'
$pausePath = Join-Path $InstallRoot 'state\service.paused'
$audioConfigPath = Join-Path $InstallRoot 'ambient-audio.config.json'
$audioStatePath = Join-Path $InstallRoot 'state\ambient-audio.json'
$audioPausePath = Join-Path $InstallRoot 'state\ambient-audio.paused'
$audioRunner = Join-Path $InstallRoot 'scripts\run-ambient-audio.mjs'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class AmbientAudioPower {
    [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
'@

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\PersonalMemoryTray', [ref]$createdNew)
if (-not $createdNew) {
    $mutex.Dispose()
    exit 0
}

$notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Text = 'Personal Memory'
$notifyIcon.Visible = $true

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$statusItem = [System.Windows.Forms.ToolStripMenuItem]::new('Checking Personal Memory...')
$statusItem.Enabled = $false
$openMemoryItem = [System.Windows.Forms.ToolStripMenuItem]::new('Open OneDrive Memory')
$openSummaryItem = [System.Windows.Forms.ToolStripMenuItem]::new('Open MEMORY.md')
$refreshItem = [System.Windows.Forms.ToolStripMenuItem]::new('Refresh status')
$pauseItem = [System.Windows.Forms.ToolStripMenuItem]::new('Pause Memory service')
$resumeItem = [System.Windows.Forms.ToolStripMenuItem]::new('Resume Memory service')
$restartItem = [System.Windows.Forms.ToolStripMenuItem]::new('Restart Memory service')
$exitItem = [System.Windows.Forms.ToolStripMenuItem]::new('Exit tray')
$audioStatusItem = [System.Windows.Forms.ToolStripMenuItem]::new('环境录音：检查中')
$audioStatusItem.Enabled = $false
$audioToggleItem = [System.Windows.Forms.ToolStripMenuItem]::new('暂停环境录音')
$audioOpenItem = [System.Windows.Forms.ToolStripMenuItem]::new('打开环境录音文件夹')
$audioDetailsItem = [System.Windows.Forms.ToolStripMenuItem]::new('环境录音状态与说明')
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($audioStatusItem)
[void]$menu.Items.Add($audioToggleItem)
[void]$menu.Items.Add($audioOpenItem)
[void]$menu.Items.Add($audioDetailsItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($openMemoryItem)
[void]$menu.Items.Add($openSummaryItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($refreshItem)
[void]$menu.Items.Add($pauseItem)
[void]$menu.Items.Add($resumeItem)
[void]$menu.Items.Add($restartItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($exitItem)
$notifyIcon.ContextMenuStrip = $menu

$script:dataRoot = $null
$script:memoryFile = $null
$script:lastAutoStart = [DateTime]::MinValue
$script:lastAudioStart = [DateTime]::MinValue
$script:audioTitle = ''
$script:audioWasProblem = $false

function Update-AmbientAudioStatus {
    if (-not (Test-Path -LiteralPath $audioConfigPath)) {
        $audioStatusItem.Text = '环境录音：未启用'
        $audioToggleItem.Enabled = $false
        return
    }
    try {
        $audioConfig = Get-Content -LiteralPath $audioConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $script:audioFolder = if($audioConfig.transcription.enabled) { $audioConfig.transcription.outputDir } else { $audioConfig.outputDir }
        $audioOpenItem.Text = if($audioConfig.transcription.enabled) { '打开环境转写文件夹' } else { '打开环境录音文件夹' }
        $paused = (Test-Path -LiteralPath $audioPausePath) -or -not $audioConfig.enabled
        $audioToggleItem.Text = if ($paused) { '恢复环境录音' } else { '暂停环境录音' }
        $audioToggleItem.Enabled = [bool]$audioConfig.enabled
        $audio = $null
        if (Test-Path -LiteralPath $audioStatePath) {
            try { $audio = Get-Content -LiteralPath $audioStatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
        }
        $alive = $false
        if ($audio.supervisorPid) {
            $worker = Get-CimInstance Win32_Process -Filter "ProcessId=$($audio.supervisorPid)" -ErrorAction SilentlyContinue
            $alive = $worker -and $worker.CommandLine -and $worker.CommandLine.Contains($audioRunner)
        }
        if ($alive -and $audio.checkedAt -and ((Get-Date).ToUniversalTime() - [DateTime]::Parse($audio.checkedAt).ToUniversalTime()).TotalSeconds -gt 90) {
            Stop-Process -Id $worker.ProcessId -Force
            $alive = $false
        }
        if (-not $alive -and ((Get-Date) - $script:lastAudioStart).TotalSeconds -ge 10) {
            $script:lastAudioStart = Get-Date
            $nodePath = if ($audioConfig.nodePath) { $audioConfig.nodePath } else { (Get-Command node.exe).Source }
            Start-Process -FilePath $nodePath -ArgumentList @("`"$audioRunner`"", "`"$InstallRoot`"", "$PID") -WindowStyle Hidden
        }
        $fresh = $false
        if ($audio.checkedAt) { $fresh = ((Get-Date).ToUniversalTime() - [DateTime]::Parse($audio.checkedAt).ToUniversalTime()).TotalSeconds -lt 15 }
        $recording = $alive -and $fresh -and $audio.status -eq 'recording' -and -not $paused
        $label = if ($paused) { '已暂停' } elseif ($recording) { '24/7 录音中' } elseif ($audio.status -eq 'disk-full') { '空间不足，已停止' } elseif ($audio.status -eq 'retrying') { '输入异常，重连中' } else { '正在连接麦克风' }
        $audioStatusItem.Text = "环境录音：$label"
        if($audio.transcriptionStatus -eq 'error') { $audioStatusItem.Text += '；转写失败，缓存保留' }
        $script:audioTitle = "Audio: $(@{ '24/7 录音中'='REC'; '已暂停'='PAUSED'; '空间不足，已停止'='DISK FULL'; '输入异常，重连中'='RETRY'; '正在连接麦克风'='STARTING' }[$label])"
        $baseTitle = ($notifyIcon.Text -split ' \| Audio:')[0]
        if ($baseTitle.Length -gt 40) { $baseTitle = $baseTitle.Substring(0,40) }
        $notifyIcon.Text = "$baseTitle | $script:audioTitle"
        $notifyIcon.Icon = if ($recording) { [System.Drawing.SystemIcons]::Exclamation } elseif ($paused) { [System.Drawing.SystemIcons]::Information } else { [System.Drawing.SystemIcons]::Error }
        # Keep the computer awake while audio is enabled; the display can still turn off.
        if (-not $paused -and $audio.status -ne 'disk-full') {
            $powerResult = [AmbientAudioPower]::SetThreadExecutionState([uint32]2147483649)
            $powerWanted = $true
        } else {
            $powerResult = [AmbientAudioPower]::SetThreadExecutionState([uint32]2147483648)
            $powerWanted = $false
        }
        if ($script:lastPowerWanted -ne $powerWanted) {
            $script:lastPowerWanted = $powerWanted
            [IO.File]::WriteAllText((Join-Path $InstallRoot 'state\ambient-audio-power.json'), (@{requested=$powerWanted;apiSucceeded=($powerResult -ne 0);checkedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        }
        $problem = -not $paused -and ($audio.status -in @('disk-full','retrying') -or $audio.transcriptionStatus -eq 'error')
        if ($problem -and -not $script:audioWasProblem) {
            $notifyIcon.ShowBalloonTip(8000, '环境采集需要注意', "$label`n$($audio.lastError)`n$($audio.transcriptionError)", [System.Windows.Forms.ToolTipIcon]::Warning)
        }
        $script:audioWasProblem = $problem
    } catch {
        $audioStatusItem.Text = '环境录音：配置或启动失败'
        $notifyIcon.Text = 'Memory | Audio: ERROR'
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
    }
}

$audioToggleItem.Add_Click({
    if (Test-Path -LiteralPath $audioPausePath) { Remove-Item -LiteralPath $audioPausePath -Force }
    else { [System.IO.File]::WriteAllText($audioPausePath, (Get-Date).ToString('o')) }
    Update-AmbientAudioStatus
})
$audioOpenItem.Add_Click({
    if ($script:audioFolder) { Start-Process -FilePath 'explorer.exe' -ArgumentList @("`"$script:audioFolder`"") }
})
$audioDetailsItem.Add_Click({
    $detail = $audioStatusItem.Text
    try {
        $s = Get-Content -LiteralPath $audioStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $detail += "`n麦克风：$($s.device)`n当前缓存：$($s.currentFile)`n剩余空间：$([Math]::Round($s.freeBytes/1GB,1)) GB`n最近音频：$($s.lastAudioAt)`n转写状态：$($s.transcriptionStatus)`n待处理片段：$($s.pendingAudioFiles)`n最近转写：$($s.lastTranscript)`n转写异常：$($s.transcriptionError)`n输入提示：$($s.warning)`n异常：$($s.lastError)"
    } catch {}
    $detail += "`n`n连续采集麦克风环境音。本机启用转写时，音频仅作临时缓存；带时间戳文字保存并读回后才删除音频，失败则保留重试。`n自动识别可能有错字漏字；无语音时记录标记，环境噪声不保留。`n仅在本机处理，不自动上传。录音启用时防止自动睡眠，屏幕仍可关闭。`n关机、手动睡眠、麦克风静音或硬件断开期间无法采集。退出托盘也会停止环境采集。"
    [void][System.Windows.Forms.MessageBox]::Show($detail, '环境录音状态', 'OK', 'Information')
})

function Update-MemoryStatus {
    $paused = Test-Path -LiteralPath $pausePath
    $pauseItem.Enabled = -not $paused
    $resumeItem.Enabled = $paused
    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $script:dataRoot = [System.IO.Path]::GetFullPath($config.dataRoot)
        $script:memoryFile = Join-Path $script:dataRoot 'memory\MEMORY.md'
        $headers = @{ Authorization = "Bearer $($config.token)" }
        $apiHost = if ($config.localApiHost) { $config.localApiHost } else { '127.0.0.1' }
        $stats = Invoke-RestMethod -Uri "http://${apiHost}:$($config.port)/api/stats" -Headers $headers -TimeoutSec 3
        $oneDriveRunning = [bool](Get-Process OneDrive -ErrorAction SilentlyContinue)
        $syncText = if ($oneDriveRunning) { 'OneDrive running' } else { 'OneDrive offline' }
        $statusItem.Text = "Online | $($stats.active) entries | $syncText"
        $notifyIcon.Text = "Memory | $($stats.active) | $syncText"
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
        $openMemoryItem.Enabled = Test-Path -LiteralPath $script:dataRoot
        $openSummaryItem.Enabled = Test-Path -LiteralPath $script:memoryFile
    } catch {
        $statusItem.Text = if ($paused) { 'Memory service paused' } else { 'Memory service offline - retrying automatically' }
        $notifyIcon.Text = if ($paused) { 'Personal Memory | paused' } else { 'Personal Memory | reconnecting' }
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
        $openMemoryItem.Enabled = [bool]($script:dataRoot -and (Test-Path -LiteralPath $script:dataRoot))
        $openSummaryItem.Enabled = [bool]($script:memoryFile -and (Test-Path -LiteralPath $script:memoryFile))
        if (-not $paused -and ((Get-Date) - $script:lastAutoStart).TotalSeconds -ge 60) {
            $script:lastAutoStart = Get-Date
            try { & $startService -InstallRoot $InstallRoot -Automatic } catch {}
        }
    }
}

$openMemoryItem.Add_Click({
    if ($script:dataRoot -and (Test-Path -LiteralPath $script:dataRoot)) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList @($script:dataRoot)
    }
})
$openSummaryItem.Add_Click({
    if ($script:memoryFile -and (Test-Path -LiteralPath $script:memoryFile)) {
        Start-Process -FilePath $script:memoryFile
    }
})
$refreshItem.Add_Click({ Update-MemoryStatus; Update-AmbientAudioStatus })
$pauseItem.Add_Click({
    try { & $stopService -InstallRoot $InstallRoot } catch {}
    Update-MemoryStatus
})
$resumeItem.Add_Click({
    try { & $startService -InstallRoot $InstallRoot } catch {}
    Update-MemoryStatus
})
$restartItem.Add_Click({
    $statusItem.Text = 'Restarting Memory service...'
    try {
        & $stopService -InstallRoot $InstallRoot
        & $startService -InstallRoot $InstallRoot
    } catch {}
    $script:restartTimer.Start()
})
$exitItem.Add_Click({
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$notifyIcon.Add_DoubleClick({
    if ($script:dataRoot -and (Test-Path -LiteralPath $script:dataRoot)) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList @($script:dataRoot)
    }
})

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 20000
$timer.Add_Tick({ Update-MemoryStatus; Update-AmbientAudioStatus })
$timer.Start()
$script:restartTimer = [System.Windows.Forms.Timer]::new()
$script:restartTimer.Interval = 1800
$script:restartTimer.Add_Tick({
    $script:restartTimer.Stop()
    Update-MemoryStatus
})
Update-MemoryStatus
$audioTimer = [System.Windows.Forms.Timer]::new()
$audioTimer.Interval = 3000
$audioTimer.Add_Tick({ Update-AmbientAudioStatus })
$audioTimer.Start()
Update-AmbientAudioStatus

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $audioTimer.Stop()
    $audioTimer.Dispose()
    [void][AmbientAudioPower]::SetThreadExecutionState([uint32]2147483648)
    $timer.Stop()
    $timer.Dispose()
    $script:restartTimer.Stop()
    $script:restartTimer.Dispose()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
