param([string]$ExePath = (Join-Path $PSScriptRoot '..\prt.exe'))
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $ExePath).ProviderPath
if (-not [IO.File]::Exists($exe)) { throw 'Reader executable not found.' }
$progId = 'prt.Portable.PDF'
$caps = 'Software\prt\PortableCapabilities'
function Set-UserValue([string]$path, [string]$name, [string]$value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
    try { $key.SetValue($name, $value, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $key.Dispose() }
}
Set-UserValue "Software\Classes\$progId" '' 'prt PDF'
Set-UserValue "Software\Classes\$progId" 'FriendlyTypeName' 'prt PDF'
Set-UserValue "Software\Classes\$progId\Application" 'ApplicationName' 'prt'
Set-UserValue "Software\Classes\$progId\shell\open\command" '' ('"{0}" "%1"' -f $exe)
Set-UserValue 'Software\Classes\.pdf\OpenWithProgids' $progId ''
Set-UserValue $caps 'ApplicationName' 'prt'
Set-UserValue $caps 'ApplicationDescription' 'prt PDF reader'
Set-UserValue "$caps\FileAssociations" '.pdf' $progId
Set-UserValue 'Software\RegisteredApplications' 'prt Portable' $caps
Add-Type -Namespace Prt -Name ShellNotify -MemberDefinition '[System.Runtime.InteropServices.DllImport("shell32.dll")] public static extern void SHChangeNotify(int id, uint flags, System.IntPtr first, System.IntPtr second);'
[Prt.ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
