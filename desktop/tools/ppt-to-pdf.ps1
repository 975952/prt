# Shared by the Node server and embedded Rust desktop server. ASCII only.
param([Parameter(Mandatory=$true)][string]$InputPath,
      [Parameter(Mandatory=$true)][string]$OutputPath,
      [Parameter(Mandatory=$true)][string]$StatePath)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($StatePath, 'waiting')
$mutex = New-Object Threading.Mutex($false, 'Local\prt-powerpoint-conversion')
try { [void]$mutex.WaitOne() } catch [Threading.AbandonedMutexException] { }
[IO.File]::WriteAllText($StatePath, 'converting')
$app = $null
$deck = $null
$oldSecurity = $null
$oldAlerts = $null
$existing = @(Get-Process POWERPNT -ErrorAction SilentlyContinue)
$result = 1
try {
    try { $app = New-Object -ComObject PowerPoint.Application }
    catch { exit 2 }
    $oldSecurity = $app.AutomationSecurity
    $oldAlerts = $app.DisplayAlerts
    $app.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
    $app.DisplayAlerts = 1 # ppAlertsNone
    # ReadOnly=true, Untitled=false, WithWindow=false. Never save the source.
    $deck = $app.Presentations.Open($InputPath, -1, 0, 0)
    $deck.SaveAs($OutputPath, 32) # ppSaveAsPDF
    if (Test-Path -LiteralPath $OutputPath) { $result = 0 }
} catch {
    $result = 1
} finally {
    if ($null -ne $deck) {
        try { $deck.Close() } catch { }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)
    }
    if ($null -ne $app) {
        try { if ($null -ne $oldSecurity) { $app.AutomationSecurity = $oldSecurity } } catch { }
        try { if ($null -ne $oldAlerts) { $app.DisplayAlerts = $oldAlerts } } catch { }
        # PowerPoint may share an existing user's process. Never quit that instance.
        try { if ($existing.Count -eq 0 -and $app.Presentations.Count -eq 0) { $app.Quit() } } catch { }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
    }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
exit $result
