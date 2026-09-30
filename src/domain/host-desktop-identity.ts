import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Authenticate the archive header through the vendor-signed carrier rather
 * than through metadata stored in that same archive. Never execute app code. */
export function verifyDesktopCarrier(archivePath: string, headerSha256: string): string {
  const archive = realpathSync(archivePath)
  if (!/^[a-f0-9]{64}$/.test(headerSha256)) throw new Error('desktop header identity missing')
  const options = { encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] }
  if (process.platform === 'darwin') {
    const contents = dirname(dirname(archive))
    const app = dirname(contents)
    if (!app.endsWith('.app') || archive !== join(contents, 'Resources', 'app.asar')) {
      throw new Error('desktop archive is outside its signed app carrier')
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R',
      '=anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"', app], options)
    const info = join(contents, 'Info.plist')
    const integrity = JSON.parse(execFileSync('/usr/bin/plutil', ['-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', info], options)) as Record<string, { algorithm?: string; hash?: string }>
    if (integrity['Resources/app.asar']?.algorithm !== 'SHA256'
      || integrity['Resources/app.asar']?.hash !== headerSha256) throw new Error('desktop signed archive header mismatch')
    const executableName = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', info], options).trim()
    if (!executableName || executableName.includes('/') || executableName.includes('\\')) throw new Error('desktop carrier executable invalid')
    return realpathSync(join(contents, 'MacOS', executableName))
  }
  if (process.platform === 'win32') {
    const installation = dirname(dirname(archive))
    if (archive !== join(installation, 'resources', 'app.asar')) throw new Error('desktop archive is outside its signed carrier')
    const executable = join(installation, 'DeepSeek Harness.exe')
    if (!existsSync(executable)) throw new Error('desktop carrier executable missing')
    // LoadLibraryEx DATAFILE_EXCLUSIVE | IMAGE_RESOURCE reads PE resources and
    // does not execute the executable. The certificate and embedded header
    // are independent of the ASAR's self-reported metadata.
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:DSH_GUARD_DESKTOP_EXECUTABLE
$sig = Get-AuthenticodeSignature -LiteralPath $p
if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -notin @('Hangzhou DeepSeek Artificial Intelligence Co., Ltd.', 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd')) { throw 'desktop vendor signature mismatch' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshGuardResource {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryEx(string file, IntPtr unused, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr FindResource(IntPtr module, string name, string type);
  [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr resource);
  [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
}
'@
$h = [DshGuardResource]::LoadLibraryEx($p, [IntPtr]::Zero, 0x60)
if ($h -eq [IntPtr]::Zero) { throw 'desktop carrier resource unavailable' }
try {
  $r = [DshGuardResource]::FindResource($h, 'ElectronAsar', 'Integrity')
  if ($r -eq [IntPtr]::Zero) { throw 'desktop signed archive resource missing' }
  $n = [DshGuardResource]::SizeofResource($h, $r)
  if ($n -eq 0 -or $n -gt 65536) { throw 'desktop archive resource invalid' }
  $ptr = [DshGuardResource]::LockResource([DshGuardResource]::LoadResource($h, $r))
  if ($ptr -eq [IntPtr]::Zero) { throw 'desktop archive resource unreadable' }
  $bytes = New-Object byte[] $n
  [System.Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $n)
  $rows = @([System.Text.Encoding]::UTF8.GetString($bytes).TrimEnd([char]0) | ConvertFrom-Json)
  $selected = @($rows | Where-Object { $_.file -ceq 'resources\app.asar' -and $_.alg -ceq 'sha256' })
  if ($selected.Count -ne 1 -or $selected[0].value -cne $env:DSH_GUARD_DESKTOP_HEADER) { throw 'desktop signed archive header mismatch' }
  [Console]::Write('verified')
} finally { [void][DshGuardResource]::FreeLibrary($h) }
`
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot) throw new Error('desktop signature verifier unavailable')
    const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      ...options, env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        DSH_GUARD_DESKTOP_EXECUTABLE: executable, DSH_GUARD_DESKTOP_HEADER: headerSha256 },
    }).trim()
    if (output !== 'verified') throw new Error('desktop signature verifier result invalid')
    return realpathSync(executable)
  }
  throw new Error('desktop signature verifier unsupported platform')
}
