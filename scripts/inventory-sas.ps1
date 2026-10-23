# ============================================================================
# SAS installation inventory - READ ONLY.
#
# Finds what is installed on this machine that automation can use: SAS programs (Management Console, Enterprise Guide,
# Base SAS), the automation / integration libraries (COM objects, DLLs, JAR files), the batch tools, Java and the Java
# Access Bridge, the SAS Viya command line and Python packages, and (optionally) whether the SAS servers answer.
#
# It changes NOTHING: no registry writes, no files written except the report text file, no logons, no passwords read or
# printed (profile files are listed by NAME only). Run it in a normal PowerShell window on the machine where the SAS
# software is installed, then send back the report file it names at the end.
#
#   powershell -ExecutionPolicy Bypass -File scripts\inventory-sas.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\inventory-sas.ps1 -ViyaUrl https://viya.example.com -MetadataHost sas94.example.com -MetadataPort 8561
#
# Not run on a real SAS machine by its author: if a section reports an error, send the report anyway.
# ============================================================================
param(
    [string]$ViyaUrl = '',
    [string]$MetadataHost = '',
    [int]$MetadataPort = 8561,
    [string]$OutFile = ''
)

$ErrorActionPreference = 'SilentlyContinue'
if ([string]::IsNullOrEmpty($OutFile)) {
    $OutFile = Join-Path (Get-Location) ('sas-inventory-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
}
$script:Lines = New-Object System.Collections.ArrayList

function Say([string]$Text) {
    Write-Host $Text
    [void]$script:Lines.Add($Text)
}
function Section([string]$Title) {
    Say ''
    Say ('=== ' + $Title + ' ' + ('=' * [Math]::Max(3, 70 - $Title.Length)))
}
function Show-File($File) {
    $version = ''
    if ($File.VersionInfo -and $File.VersionInfo.FileVersion) { $version = ' v' + $File.VersionInfo.FileVersion }
    Say ('  ' + $File.FullName + $version + '  (' + [Math]::Round($File.Length / 1KB) + ' KB)')
}

Section 'This machine'
Say ('Computer : ' + $env:COMPUTERNAME)
Say ('User     : ' + $env:USERDOMAIN + '\' + $env:USERNAME)
Say ('Windows  : ' + [Environment]::OSVersion.VersionString + ' (64-bit OS: ' + [Environment]::Is64BitOperatingSystem + ')')
Say ('PowerShell: ' + $PSVersionTable.PSVersion.ToString() + ' (64-bit process: ' + [Environment]::Is64BitProcess + ')')
Say ('Session  : ' + $env:SESSIONNAME + ' (interactive desktop needed for UI automation)')
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say ('Elevated : ' + $isAdmin)

Section 'SAS install folders'
$roots = New-Object System.Collections.ArrayList
$candidates = @(
    'C:\Program Files\SASHome', 'C:\Program Files (x86)\SASHome', 'D:\SASHome', 'E:\SASHome', 'C:\SASHome',
    'C:\Program Files\SAS', 'C:\Program Files (x86)\SAS', 'C:\SAS', 'D:\SAS'
)
foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($pf) {
        foreach ($name in @('SASHome', 'SAS', 'SAS Institute')) { $candidates += (Join-Path $pf $name) }
    }
}
foreach ($c in ($candidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $c) { [void]$roots.Add($c); Say ('  found: ' + $c) }
}
foreach ($key in @('HKLM:\SOFTWARE\SAS Institute Inc.', 'HKLM:\SOFTWARE\WOW6432Node\SAS Institute Inc.')) {
    if (Test-Path $key) {
        Say ('  registry: ' + $key)
        Get-ChildItem $key -Recurse -Depth 2 | ForEach-Object { Say ('    ' + $_.Name) }
    }
}
if ($roots.Count -eq 0) { Say '  no SAS folder found in the usual places - tell us where SAS is installed (and re-run with that folder in mind).' }

Section 'SAS programs and tools (by file name)'
$wanted = @(
    'sasmc.exe', 'SEGuide.exe', 'sas.exe', 'sasv9.cfg', 'sasv9_usermods.cfg',
    'ExportPackage*', 'ImportPackage*', 'BatchExport*', 'BatchImport*', 'SASDIStudio*.exe', 'sasdi*.exe', 'SASMetadataServer*',
    'jabswitch.exe', 'sas-viya*.exe', 'saslaunch*.exe', 'sassrv*.exe', 'objspawn*.exe'
)
foreach ($root in $roots) {
    foreach ($pattern in $wanted) {
        Get-ChildItem -LiteralPath $root -Recurse -Depth 8 -Filter $pattern -File | Select-Object -First 6 | ForEach-Object { Show-File $_ }
    }
}

Section 'Automation and integration DLLs / assemblies (by file name)'
$dllPatterns = @(
    '*Scripting*.dll', 'SAS*Interop*.dll', 'SASObjectManager*.dll', 'sas.*.dll', 'SAS.*.dll', 'SASEG*.dll', 'sasoledb*.dll', 'sas*.tlb',
    'WindowsAccessBridge*.dll', 'sashost*.dll'
)
foreach ($root in $roots) {
    foreach ($pattern in $dllPatterns) {
        Get-ChildItem -LiteralPath $root -Recurse -Depth 8 -Filter $pattern -File | Select-Object -First 8 | ForEach-Object { Show-File $_ }
    }
}
foreach ($gac in @('C:\Windows\Microsoft.NET\assembly\GAC_MSIL', 'C:\Windows\assembly')) {
    if (Test-Path $gac) {
        Get-ChildItem -LiteralPath $gac -Directory -Filter 'SAS*' | ForEach-Object { Say ('  GAC: ' + $_.FullName) }
    }
}

Section 'SAS Java libraries (JAR files used by the Metadata and Integration clients)'
$jarPatterns = @('sas.svc.connection*.jar', 'sas.oma*.jar', 'sas.core*.jar', 'sas.security*.jar', 'sas.launcher*.jar', 'sas.entities*.jar', 'sas.rutil*.jar', 'sas.management*.jar', 'sas.mdserver*.jar', 'log4j*.jar')
foreach ($root in $roots) {
    foreach ($pattern in $jarPatterns) {
        Get-ChildItem -LiteralPath $root -Recurse -Depth 9 -Filter $pattern -File | Select-Object -First 5 | ForEach-Object { Show-File $_ }
    }
}

Section 'COM objects registered for SAS (these can be driven from PowerShell / VBScript / .NET)'
$progIdPatterns = @('SASEG*', 'SASObjectManager*', 'SAS.*', 'SASWorkspace*', 'SASOLEDB*', 'SASHelp*', 'SASMeta*', 'SASServer*')
$seen = @{}
foreach ($base in @('Registry::HKEY_CLASSES_ROOT', 'HKLM:\SOFTWARE\Classes', 'HKLM:\SOFTWARE\WOW6432Node\Classes')) {
    foreach ($pattern in $progIdPatterns) {
        Get-ChildItem -Path $base -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like $pattern } | ForEach-Object {
            $progId = $_.PSChildName
            if (-not $seen.ContainsKey($progId)) {
                $seen[$progId] = $true
                $clsid = (Get-ItemProperty -Path (Join-Path $_.PSPath 'CLSID')).'(default)'
                $server = ''
                if ($clsid) {
                    foreach ($hive in @('Registry::HKEY_CLASSES_ROOT\CLSID\', 'HKLM:\SOFTWARE\Classes\WOW6432Node\CLSID\')) {
                        foreach ($kind in @('InprocServer32', 'LocalServer32')) {
                            $p = $hive + $clsid + '\' + $kind
                            if (Test-Path $p) { $server += ' [' + $kind + ': ' + (Get-ItemProperty $p).'(default)' + ']' }
                        }
                    }
                }
                Say ('  ' + $progId + $server)
            }
        }
    }
}
if ($seen.Count -eq 0) { Say '  none found' }

Section 'Can PowerShell create the common SAS COM objects? (create only, nothing is connected)'
foreach ($progId in @('SASObjectManager.ObjectFactoryMulti2', 'SASObjectManager.ObjectFactory', 'SASObjectManager.ObjectKeeper')) {
    try {
        $o = New-Object -ComObject $progId
        Say ('  OK     ' + $progId)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o)
    } catch { Say ('  FAILED ' + $progId + '  ' + $_.Exception.Message.Split("`n")[0]) }
}
foreach ($v in @('9.1', '8.1', '8.3', '8.2', '8.0', '7.15', '7.1', '6.1', '5.1')) {
    $progId = 'SASEGObjectModel.Application.' + $v
    try {
        $o = New-Object -ComObject $progId
        Say ('  OK     ' + $progId + '   (Enterprise Guide automation object model)')
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o)
    } catch { if ($_.Exception.Message -notmatch 'class not registered|80040154|Invalid class string') { Say ('  FAILED ' + $progId + '  ' + $_.Exception.Message.Split("`n")[0]) } }
}
if ([Environment]::Is64BitProcess) { Say '  (this is a 64-bit PowerShell: a 32-bit-only SAS COM object needs C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe)' }

Section 'Java and the Java Access Bridge (needed to see inside Java programs such as SAS Management Console)'
Say ('JAVA_HOME = ' + $env:JAVA_HOME)
$java = Get-Command java.exe -ErrorAction SilentlyContinue
if ($java) { Say ('java on PATH: ' + $java.Source); try { $v = (& cmd /c 'java -version 2>&1'); $v | ForEach-Object { Say ('    ' + $_) } } catch { } } else { Say 'java is not on PATH' }
foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Directory -Recurse -Depth 3 -Filter 'SASPrivateJavaRuntimeEnvironment*' | ForEach-Object { Say ('  SAS private Java: ' + $_.FullName) }
    Get-ChildItem -LiteralPath $root -Recurse -Depth 6 -Filter 'jabswitch.exe' -File | ForEach-Object { Say ('  jabswitch: ' + $_.FullName) }
}
$jabDll = @('C:\Windows\System32\WindowsAccessBridge-64.dll', 'C:\Windows\SysWOW64\WindowsAccessBridge-32.dll', 'C:\Windows\System32\WindowsAccessBridge-32.dll')
foreach ($d in $jabDll) { if (Test-Path $d) { Say ('  Access Bridge DLL present: ' + $d) } }
$props = Join-Path $env:USERPROFILE '.accessibility.properties'
if (Test-Path $props) { Say ('  ' + $props + ' exists: ' + ((Get-Content $props) -join ' | ')) } else { Say '  no .accessibility.properties for this user (the Java Access Bridge is probably not enabled; run jabswitch -enable)' }

Section 'SAS Viya tools on this machine'
$cli = Get-Command sas-viya.exe, sas-viya -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cli) { Say ('sas-viya CLI: ' + $cli.Source); try { (& $cli.Source '--version' 2>&1) | Select-Object -First 3 | ForEach-Object { Say ('    ' + $_) } } catch { } } else { Say 'sas-viya CLI: not found on PATH' }
foreach ($py in @('py', 'python', 'python3')) {
    $c = Get-Command $py -ErrorAction SilentlyContinue
    if ($c) {
        Say ($py + ': ' + $c.Source)
        try { (& $c.Source '-m' 'pip' 'list' 2>&1) | Where-Object { $_ -match '^(saspy|swat|sasctl|requests|pywinauto|pyjab|java-access-bridge)' } | ForEach-Object { Say ('    ' + $_) } } catch { }
        break
    }
}
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curl) { Say ('curl: ' + $curl.Source) }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) { Say ('node: ' + $node.Source + '  ' + (& $node.Source '-v')) }

Section 'Saved connection profiles (names only - nothing inside them is read)'
foreach ($dir in @((Join-Path $env:APPDATA 'SAS'), (Join-Path $env:LOCALAPPDATA 'SAS'))) {
    if (Test-Path $dir) {
        Say ('  ' + $dir)
        Get-ChildItem -LiteralPath $dir -Recurse -Depth 4 -Include '*.swa', '*.xml', '*.egp', '*.profile', '*.mdsprf', 'MetadataServerProfiles*' -File | Select-Object -First 25 | ForEach-Object { Say ('    ' + $_.FullName.Substring($dir.Length)) }
    }
}

Section 'Running SAS programs right now (open them first if you want them listed)'
Get-Process | Where-Object { $_.ProcessName -match 'sas|SEGuide|sasmc|java' -and $_.MainWindowTitle } | ForEach-Object { Say ('  ' + $_.ProcessName + ' pid ' + $_.Id + '  window: "' + $_.MainWindowTitle + '"') }

if ($ViyaUrl) {
    Section ('SAS Viya reachability: ' + $ViyaUrl)
    foreach ($path in @('/SASLogon/login', '/SASDrive/', '/SASStudio/', '/SASEnvironmentManager/', '/compute/apiMeta', '/folders/apiMeta', '/identities/apiMeta')) {
        try {
            $r = Invoke-WebRequest -Uri ($ViyaUrl.TrimEnd('/') + $path) -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 20
            Say ('  ' + $r.StatusCode + '  ' + $path)
        } catch {
            $code = ''
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            Say ('  ' + $code + ' ' + $_.Exception.Message.Split("`n")[0] + '  ' + $path)
        }
    }
    Say '  (a 401/403 or a redirect to SASLogon is normal for these without logging on: it proves the address is reachable)'
}
if ($MetadataHost) {
    Section ('SAS 9.4 metadata server reachability: ' + $MetadataHost + ':' + $MetadataPort)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($MetadataHost, $MetadataPort, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(8000)) { $tcp.EndConnect($iar); Say '  TCP connection OK' } else { Say '  TCP connection timed out' }
        $tcp.Close()
    } catch { Say ('  TCP connection failed: ' + $_.Exception.Message.Split("`n")[0]) }
}

Section 'Done'
Say ('Report written to: ' + $OutFile)
Say 'Send that file back. It contains file paths, versions and COM names only - no passwords or profile contents.'
$script:Lines | Out-File -FilePath $OutFile -Encoding UTF8
