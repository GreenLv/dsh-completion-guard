import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import * as zlib from 'node:zlib'
import { activationCanonical, activationDigest, sessionBirthIdentity } from './session-activation.js'

type Compression = 'none' | 'zstd'
type Identity = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; mode: string; nlink: string }
export interface ActivationGenerationDescriptor { relativePath: string; projectSegment: string; sessionSegment: string; version: number; compression: Compression; contentSha256: string; identity: Identity }
type Restore = { decodeRow(value: unknown): void; finish(): unknown }
type Catalog = { createRestore(header: unknown, options: { recovery: 'strict'; validation: 'current' }): Restore }
type Handle = { header: unknown; inheritedEventCount: unknown; read(): Promise<unknown>; close(): Promise<void> }
type SnapshotRow = { header: unknown; revision: unknown; sizeBytes?: unknown; formatStatus?: unknown }
type Snapshot = { persistence: { stat(id: never): Promise<SnapshotRow | undefined>; open(id: never, access: 'read'): Promise<Handle> }; close(): Promise<void> }
export interface ActivationGenerationVerificationInput {
  root: string
  compression: Compression
  censusSha256: string
  generations: readonly ActivationGenerationDescriptor[]
  capture: () => string
  openSnapshot: (root: string, compression: Compression) => Promise<Snapshot>
  catalogs: { historical: Catalog; current: Catalog }
}
export interface ActivationGenerationVerificationResult {
  generations: Array<{ relativePath: string; contentSha256: string; version: number; sessionId: string; birthIdentitySha256: string }>
  selections: Array<{ projectSegment: string; sessionSegment: string; selectedRelativePath: string; selectedVersion: number }>
}
function fail(): never { throw new Error('activation_generation_unverified') }
function segment(value: string): boolean { return !!value && value !== '.' && value !== '..' && !/[\\/\0]/u.test(value) }
function encoded(id: string): string {
  if (id === '.' || id === '..') return [...id].map(() => '~002E').join('')
  let result = ''
  for (let i = 0; i < id.length; i++) result += /^[A-Za-z0-9._-]$/u.test(id[i]) ? id[i] : `~${id.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  return result
}
function sourceBytes(path: string, expected: Identity, digest: string): Buffer {
  const expectedString = activationCanonical(expected)
  if (!/^\d+$/u.test(expected.size) || BigInt(expected.size) > 256n * 1024n * 1024n) fail()
  const identity = (s: ReturnType<typeof fstatSync>) => {
    const x = s as unknown as { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint; nlink: bigint; isFile(): boolean; isSymbolicLink(): boolean }
    if (!x.isFile() || x.isSymbolicLink() || x.nlink !== 1n || x.ino === 0n) fail()
    return { dev: String(x.dev), ino: String(x.ino), size: String(x.size), mtimeNs: String(x.mtimeNs), ctimeNs: String(x.ctimeNs), mode: String(x.mode), nlink: String(x.nlink) }
  }
  const before = lstatSync(path, { bigint: true })
  if (activationCanonical(identity(before as never)) !== expectedString) fail()
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    if (activationCanonical(identity(fstatSync(fd, { bigint: true }) as never)) !== expectedString) fail()
    const bytes = readFileSync(fd)
    if (createHash('sha256').update(bytes).digest('hex') !== digest
      || activationCanonical(identity(fstatSync(fd, { bigint: true }) as never)) !== expectedString
      || activationCanonical(identity(lstatSync(path, { bigint: true }) as never)) !== expectedString) fail()
    return bytes
  } finally { closeSync(fd) }
}
/** Walk a Zstandard frame's physical blocks before giving exactly one whole frame to Node's decoder. */
function zstdFrames(input: Buffer): Buffer[] {
  const decompress = (zlib as unknown as { zstdDecompressSync?: (source: Buffer, options: { maxOutputLength: number }) => Buffer }).zstdDecompressSync
  if (!decompress) fail()
  let at = 0; const decoded: Buffer[] = []; let total = 0
  const need = (n: number) => { if (n < 0 || at + n > input.length) fail() }
  while (at < input.length) {
    const start = at; need(5); if (input.readUInt32LE(at) !== 0xfd2fb528) fail(); at += 4
    const desc = input[at++]; if ((desc & 0x18) !== 0) fail()
    const single = !!(desc & 32), sizeFlag = desc >>> 6, dict = desc & 3
    const contentSizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : (1 << sizeFlag)
    const header = (single ? 0 : 1) + (dict === 3 ? 4 : dict) + contentSizeBytes
    need(header); at += header
    let last = false
    while (!last) {
      need(3); const h = input.readUIntLE(at, 3); at += 3
      last = !!(h & 1); const kind = (h >>> 1) & 3, length = h >>> 3
      if (kind === 3) fail()
      const body = kind === 1 ? 1 : length; need(body); at += body
    }
    if (desc & 4) { need(4); at += 4 }
    const plain = decompress(input.subarray(start, at), { maxOutputLength: 256 * 1024 * 1024 })
    total += plain.length; if (total > 256 * 1024 * 1024) fail()
    decoded.push(plain)
  }
  if (!decoded.length) fail()
  return decoded
}
function strictPhysical(bytes: Buffer, version: number, compression: Compression, catalogs: ActivationGenerationVerificationInput['catalogs']): string {
  const frames = compression === 'none' ? [bytes] : zstdFrames(bytes)
  if (frames.some(frame => !frame.length || frame[frame.length - 1] !== 10)) fail()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const lines: string[] = []
  for (const frame of frames) for (const line of decoder.decode(frame).slice(0, -1).split('\n')) lines.push(line)
  if (compression === 'zstd' && frames[0].indexOf(10) !== frames[0].length - 1) fail()
  if (!lines.length || lines.some(line => !line)) fail()
  const header = JSON.parse(lines[0]) as {version?: unknown}
  if (header?.version !== version) fail()
  const parser = (version <= 3 ? catalogs.historical : catalogs.current).createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const line of lines.slice(1)) parser.decodeRow(JSON.parse(line))
  const result = parser.finish() as { header?: { id?: unknown } }
  if (typeof result?.header?.id !== 'string' || !result.header.id) fail()
  return result.header.id
}
/** Reject shared or redirected Windows scratch paths before any private data is copied. */
function assertWindowsScratch(path: string, requireCurrentOwner: boolean): void {
  if (process.platform !== 'win32') return
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !isAbsolute(systemRoot)) fail()
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('DSH_GENERATION_SCRATCH_PATH', 'Process')
$own = [Environment]::GetEnvironmentVariable('DSH_GENERATION_REQUIRE_OWNER', 'Process') -eq '1'
if (-not $path -or -not [IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\')) { throw 'invalid scratch path' }
$root = [IO.Path]::GetPathRoot($path)
if (([IO.DriveInfo]::new($root)).DriveType -ne [IO.DriveType]::Fixed) { throw 'scratch drive not fixed' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($me, 'S-1-5-18', 'S-1-5-32-544')
try { $installer = ([Security.Principal.NTAccount]::new('NT SERVICE', 'TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value; $trusted += $installer } catch { }
$ancestorDanger = [int64]([Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership) -bor 0x10000000
$parentDanger = $ancestorDanger -bor [int64][Security.AccessControl.FileSystemRights]::Write -bor 0x40000000
$dir = [IO.DirectoryInfo]::new($path)
$depth = 0
while ($null -ne $dir) {
  if (-not $dir.Exists -or (($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'redirected scratch' }
  $acl = $dir.GetAccessControl(([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner))
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner -or ($depth -eq 0 -and $own -and $owner -ne $me)) { throw 'untrusted owner' }
  foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    $sid = $ace.IdentityReference.Value
    if ($trusted -contains $sid -or $sid -eq 'S-1-3-0' -or $sid -eq 'S-1-3-4') { continue }
    if ($depth -gt 0 -and (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)) { continue }
    $effective = [int64]$ace.FileSystemRights
    if ($own -and $depth -eq 0) {
      if (($effective -band (-bnot [int64][Security.AccessControl.FileSystemRights]::Synchronize)) -ne 0) { throw 'scratch data accessible' }
    } elseif (($depth -eq 0 -and -not $own) -or ($depth -eq 1 -and $own)) {
      if (($effective -band $parentDanger) -ne 0) { throw 'shared scratch parent' }
    } elseif (($effective -band $ancestorDanger) -ne 0) { throw 'replaceable scratch ancestor' }
  }
  $depth += 1
  $dir = $dir.Parent
}
`
  const encoded = Buffer.from(source, 'utf16le').toString('base64')
  try {
    execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, DSH_GENERATION_SCRATCH_PATH: path, DSH_GENERATION_REQUIRE_OWNER: requireCurrentOwner ? '1' : '0' },
      stdio: 'ignore', timeout: 15_000, windowsHide: true,
    })
  } catch { fail() }
}
export async function verifyActivationGenerations(input: ActivationGenerationVerificationInput): Promise<ActivationGenerationVerificationResult> {
  if (!['none','zstd'].includes(input.compression) || !/^[a-f0-9]{64}$/u.test(input.censusSha256) || input.capture() !== input.censusSha256) fail()
  const sizes = new Map<string, number>(); let totalBytes = 0n
  for (const row of input.generations) {
    if (!/^\d+$/u.test(row.identity.size)) fail()
    totalBytes += BigInt(row.identity.size)
    const key = `${row.projectSegment}/${row.sessionSegment}`; sizes.set(key, (sizes.get(key) ?? 0) + 1)
  }
  if (![...sizes.values()].some(size => size > 1)) return { generations: [], selections: [] }
  if (totalBytes > 1024n * 1024n * 1024n) fail()
  const rawScratchBase = resolve(tmpdir())
  assertWindowsScratch(rawScratchBase, false)
  const sourceRoot = realpathSync(input.root), scratchBase = realpathSync(rawScratchBase)
  if (sourceRoot !== resolve(input.root)) fail()
  const isInside = (path: string, parent: string) => { const r = relative(parent, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) }
  // Check before creating even the first scratch file inside a source tree.
  if (isInside(scratchBase, sourceRoot)) fail()
  const temp = mkdtempSync(join(scratchBase, 'dsh-generation-check-'))
  try {
    const physicalTemp = realpathSync(temp), snapshot = join(physicalTemp, 'snapshot'), held = join(physicalTemp, 'held')
    if (isInside(physicalTemp, sourceRoot) || isInside(sourceRoot, physicalTemp)) fail()
    const tempStat = lstatSync(physicalTemp)
    if (!tempStat.isDirectory() || tempStat.isSymbolicLink() || (process.platform !== 'win32' && ((tempStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && tempStat.uid !== process.getuid())))) fail()
    assertWindowsScratch(physicalTemp, true)
    mkdirSync(snapshot, { mode: 0o700 }); mkdirSync(held, { mode: 0o700 })
    assertWindowsScratch(snapshot, true); assertWindowsScratch(held, true)
    const groups = new Map<string, ActivationGenerationDescriptor[]>(), seen = new Set<string>()
    for (const row of input.generations) {
      if (!segment(row.projectSegment) || !segment(row.sessionSegment) || !Number.isInteger(row.version) || row.version < 0 || row.version > 4 || row.compression !== input.compression || !/^[a-f0-9]{64}$/u.test(row.contentSha256)) fail()
      const filename = `session${row.version ? `.v${row.version}` : ''}.jsonl${row.compression === 'zstd' ? '.zstd' : ''}`
      if (row.relativePath !== `${row.projectSegment}/${row.sessionSegment}/${filename}` || seen.has(row.relativePath)) fail()
      seen.add(row.relativePath)
      const bytes = sourceBytes(join(input.root, row.relativePath), row.identity, row.contentSha256)
      const directory = join(snapshot, row.projectSegment, row.sessionSegment); mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(join(snapshot, row.relativePath), bytes, { mode: 0o600, flag: 'wx' })
      const key = `${row.projectSegment}/${row.sessionSegment}`; const group = groups.get(key) ?? []; group.push(row); groups.set(key, group)
    }
    if (input.capture() !== input.censusSha256) fail()
    assertWindowsScratch(physicalTemp, true); assertWindowsScratch(snapshot, true); assertWindowsScratch(held, true)
    const output: ActivationGenerationVerificationResult = { generations: [], selections: [] }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      group.sort((a, b) => b.version - a.version)
      const selected = group[0]; let birthCanonical: string | undefined
      const ids = new Map<string, string>()
      for (const row of group) {
        const id = strictPhysical(readFileSync(join(snapshot, row.relativePath)), row.version, row.compression, input.catalogs)
        if (encoded(id) !== row.sessionSegment) fail()
        ids.set(row.relativePath, id)
      }
      for (const target of group) {
        const moved: Array<{from: string; to: string}> = []
        try {
          for (const other of group) if (target !== selected && other !== target) {
            const from = join(snapshot, other.relativePath), to = join(held, String(moved.length)); renameSync(from, to); moved.push({from,to})
          }
          const s = await input.openSnapshot(snapshot, input.compression)
          try {
            const id = ids.get(target.relativePath)
            if (!id) fail()
            const targetPath = join(snapshot, target.relativePath)
            const before = lstatSync(targetPath, { bigint: true })
            if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail()
            const revision = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':')
            const matches = (row: SnapshotRow | undefined): row is SnapshotRow => {
              if (!row || row.sizeBytes !== Number(before.size) || typeof row.revision !== 'string') return false
              if (target.version === 4 ? row.revision !== revision : !new RegExp(`^${revision}:[a-f0-9]{64}$`, 'u').test(row.revision)) return false
              return row.formatStatus === (target.version === 4 ? 'current' : 'migration-required')
            }
            const row = await s.persistence.stat(id as never)
            if (!matches(row)) fail()
            const handle = await s.persistence.open(id as never, 'read')
            try {
              await handle.read()
              const birth = sessionBirthIdentity(handle.header, handle.inheritedEventCount)
              if (birth.id !== id || encoded(id) !== target.sessionSegment || activationCanonical(row.header) !== activationCanonical(handle.header)) fail()
              const after = await s.persistence.stat(id as never)
              const current = lstatSync(targetPath, { bigint: true })
              const currentRevision = [current.dev, current.ino, current.size, current.mtimeNs, current.ctimeNs].join(':')
              if (!matches(after) || after.revision !== row.revision || activationCanonical(after.header) !== activationCanonical(row.header)
                || currentRevision !== revision || !current.isFile() || current.nlink !== 1n
                || createHash('sha256').update(readFileSync(targetPath)).digest('hex') !== target.contentSha256) fail()
              const canonical = activationCanonical(birth)
              if (birthCanonical !== undefined && canonical !== birthCanonical) fail()
              birthCanonical = canonical
              output.generations.push({relativePath: target.relativePath, contentSha256: target.contentSha256, version: target.version, sessionId: id, birthIdentitySha256: activationDigest(birth)})
            } finally { await handle.close() }
          } finally { await s.close() }
        } finally { for (const item of moved.reverse()) renameSync(item.to, item.from) }
      }
      output.selections.push({ projectSegment: selected.projectSegment, sessionSegment: selected.sessionSegment, selectedRelativePath: selected.relativePath, selectedVersion: selected.version })
    }
    if (input.capture() !== input.censusSha256) fail()
    assertWindowsScratch(physicalTemp, true); assertWindowsScratch(snapshot, true); assertWindowsScratch(held, true)
    output.generations.sort((a,b) => a.relativePath.localeCompare(b.relativePath)); output.selections.sort((a,b) => `${a.projectSegment}/${a.sessionSegment}`.localeCompare(`${b.projectSegment}/${b.sessionSegment}`))
    return output
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
