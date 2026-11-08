#!/usr/bin/env node
/**
 * DSH 会话「加载层」校验器（官方代码版）
 *
 * 与「便携版 校验.mjs」的区别：
 *   便携版把我对官方规则的复刻打包在内，v2 物理层是替身；
 *   本版直接在 DSH 仓库里 import **真实编译产物**（packages/session/<包>/lib/index.js），
 *   零替身，跑的就是 DSH 自己加载会话时用的那套代码。
 *
 * 覆盖的完整加载链路（对应 DSH 打开一个 v3 会话文件时的真实路径）：
 *   L1 容器层   zstd 拼接帧扫描 + 首帧必须恰好一行 header + 完整帧内不得有撕裂记录
 *   L2 头部层   首行 JSON 解析 + 版本识别 + catalog.createRestore
 *   L3 行准入层 v3 codec：assertV3RowAdmission + assertV3EventAdmission + assertV3Event
 *   L4 迁移层   v3 -> v4 迁移（tool-role / system-message / references / sources ...）
 *   L5 还原层   restoreReleasedV4Artifact（含 assertReleasedV4Relationships 生命周期校验）
 *
 * 用法（在 DSH 仓库根目录，或任意位置配合 --repo）：
 *   node 官方校验.mjs <文件.zstd>
 *   node 官方校验.mjs <文件1> <文件2> ...
 *   node 官方校验.mjs <目录>                      # 递归校验目录下 session*.zstd
 *   node 官方校验.mjs <目录> --quiet              # 只打印汇总
 *   node 官方校验.mjs <目录> --fail-fast
 *   node 官方校验.mjs <目录> --repo "D:\DeepseekHarness\deepseek-harness"
 *   node 官方校验.mjs --preflight                 # 只检查官方依赖是否齐全
 *
 * 退出码：全部 PASS -> 0；有 FAIL 或依赖缺失 -> 1
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528

// ───────────────────────── 命令行 ─────────────────────────
const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const failFast = argv.includes('--fail-fast')
const preflightOnly = argv.includes('--preflight')
const repoFlagIndex = argv.indexOf('--repo')
const repoFlag = repoFlagIndex >= 0 ? argv[repoFlagIndex + 1] : undefined
const targets = argv.filter((a, i) => !a.startsWith('--') && i !== repoFlagIndex + 1)

function usage() {
  console.log('用法:')
  console.log('  node 官方校验.mjs <文件.zstd>')
  console.log('  node 官方校验.mjs <文件1> <文件2> ...')
  console.log('  node 官方校验.mjs <目录> [--quiet] [--fail-fast]')
  console.log('  node 官方校验.mjs <目录> --repo "D:\\DeepseekHarness\\deepseek-harness"')
  console.log('  node 官方校验.mjs --preflight')
}

// ───────────────────── L1 容器层：帧扫描（官方 scanZstdFrames 的忠实移植） ─────────────────────
/**
 * 定位拼接 zstd 流里的完整帧，不压缩解压块。
 * 完整结构非法 -> 抛错；EOF 落在末帧内部 -> 返回该帧起点。
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    // 逐块扫描，定位该帧的结束字节
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 0x01) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 首帧必须只含 header 一行（官方 assertIndependentHeaderFrame / assertZstdHeaderFrame）。 */
function assertIndependentHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

// ───────────────────── L2/L3/L4 头部与行：官方 MigratingJsonlRows 的忠实移植 ─────────────────────
function parseJson(text, subject) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`corrupt session log: ${subject} is not valid JSON`, { cause: error })
  }
}

function storedVersion(header) {
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new Error('corrupt session log: first line is not a JSON object')
  }
  const version = header.version
  if (!Number.isSafeInteger(version) || version < 0 || Object.is(version, -0)) {
    throw new Error('corrupt session log: header version is not a non-negative safe integer')
  }
  return version
}

/** 迁移路径的行解析器：保留跨帧碎片，坏行延迟到下一个 turn/end 才抛。 */
class MigratingJsonlRows {
  fragments = []
  fragmentBytes = 0
  rowIndex = 0
  issue = undefined
  constructor(restore) {
    this.restore = restore
  }
  write(chunk) {
    let lineStart = 0
    for (let nl = chunk.indexOf(0x0A); nl !== -1; nl = chunk.indexOf(0x0A, lineStart)) {
      const fragment = chunk.subarray(lineStart, nl)
      let line = fragment
      if (this.fragments.length > 0) {
        if (fragment.length > 0) this.fragments.push(fragment)
        line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length)
        this.fragments = []
        this.fragmentBytes = 0
      }
      this.consume(line)
      lineStart = nl + 1
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart))
      this.fragments.push(fragment)
      this.fragmentBytes += fragment.length
    }
  }
  /** 结构完整的帧内若残留记录碎片，即撕裂。 */
  assertCompleteFramesEndOnRecord() {
    if (this.fragments.length > 0) {
      throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
    }
  }
  finish() {
    return this.restore.finish()
  }
  consume(line) {
    const index = this.rowIndex
    this.rowIndex += 1
    let row
    try {
      row = parseJson(line.toString('utf8'), `row ${index + 1}`)
    } catch (error) {
      this.issue ??= error
      return
    }
    if (this.issue !== undefined) {
      if (typeof row === 'object' && row !== null && row.type === 'turn/end') throw this.issue
      return
    }
    this.restore.decodeRow(row)
  }
}

// ───────────────────── 官方依赖装载 ─────────────────────
function looksLikeRepo(dir) {
  try {
    return existsSync(join(dir, 'packages', 'session', 'session-format', 'package.json'))
  } catch {
    return false
  }
}

function findRepo(explicit) {
  const candidates = []
  if (explicit) candidates.push(resolve(explicit))
  let cur = process.cwd()
  for (;;) {
    candidates.push(cur)
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  candidates.push('D:\\DeepseekHarness\\deepseek-harness')
  candidates.push('/mnt/d/DeepseekHarness/deepseek-harness')
  for (const c of candidates) if (looksLikeRepo(c)) return c
  return undefined
}

async function loadOfficial(repo) {
  const sessionRoot = join(repo, 'packages', 'session')
  const modules = new Map()
  const failures = []
  if (!existsSync(sessionRoot)) {
    return { modules, failures: [`未找到 ${sessionRoot}`], sessionRoot }
  }
  for (const entry of readdirSync(sessionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgDir = join(sessionRoot, entry.name)
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    let name
    try {
      name = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name
    } catch {
      continue
    }
    const lib = join(pkgDir, 'lib', 'index.js')
    if (!existsSync(lib)) {
      failures.push(`${name}: 缺少编译产物 lib/index.js（该包未构建）`)
      continue
    }
    try {
      modules.set(name, await import(pathToFileURL(lib).href))
    } catch (error) {
      failures.push(`${name}: 导入失败 ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { modules, failures, sessionRoot }
}

/** 从真实模块里自动发现所有版本 codec 与相邻迁移。 */
function discover(modules) {
  const codecs = new Map()
  const migrations = new Map()
  for (const mod of modules.values()) {
    for (const [key, value] of Object.entries(mod)) {
      const codecMatch = /^releasedV(\d+)SessionFormatCodec$/.exec(key)
      if (codecMatch && value && typeof value === 'object' && Number(value.version) === Number(codecMatch[1])) {
        codecs.set(Number(codecMatch[1]), value)
      }
      const migrationMatch = /^sessionFormatV(\d+)ToV(\d+)$/.exec(key)
      if (migrationMatch && value && typeof value.createStage === 'function') {
        migrations.set(`${migrationMatch[1]}->${migrationMatch[2]}`, value)
      }
    }
  }
  return { codecs, migrations }
}

function buildCatalog(repo, modules) {
  const format = modules.get('@deepseek-ai/dsh-session-format')
  const v3to4 = modules.get('@deepseek-ai/dsh-session-format-v3-to-v4')
  const session = modules.get('@deepseek-ai/dsh-session')
  const catalogPkg = modules.get('@deepseek-ai/dsh-session-format-catalog')

  const missing = []
  if (!format?.createSessionFormatCatalog) missing.push('@deepseek-ai/dsh-session-format 缺少 createSessionFormatCatalog')
  if (!v3to4?.restoreReleasedV4Artifact) missing.push('@deepseek-ai/dsh-session-format-v3-to-v4 缺少 restoreReleasedV4Artifact')
  if (!v3to4?.createSessionFormatV3ToV4 && !v3to4?.sessionFormatV3ToV4) {
    missing.push('@deepseek-ai/dsh-session-format-v3-to-v4 缺少 createSessionFormatV3ToV4')
  }

  const { codecs, migrations } = discover(modules)
  const currentVersion = Number(session?.SESSION_FORMAT_VERSION ?? 4)

  for (let v = 0; v <= currentVersion; v += 1) {
    if (!codecs.has(v)) missing.push(`缺少 v${v} 的 codec（releasedV${v}SessionFormatCodec）`)
  }
  for (let v = 0; v < currentVersion; v += 1) {
    if (!migrations.has(`${v}->${v + 1}`)) missing.push(`缺少 v${v} -> v${v + 1} 的迁移（sessionFormatV${v}ToV${v + 1}）`)
  }

  const knownEventTypes = session?.KNOWN_SESSION_EVENT_TYPES
  if (!knownEventTypes) missing.push('@deepseek-ai/dsh-session 缺少 KNOWN_SESSION_EVENT_TYPES')

  if (missing.length > 0) return { missing, codecs, migrations, currentVersion }

  // v3 -> v4 必须带「显式子会话事实」：本工具按无子会话声明（[]）。
  const v3to4Migration = v3to4.createSessionFormatV3ToV4
    ? v3to4.createSessionFormatV3ToV4([])
    : v3to4.sessionFormatV3ToV4

  const orderedMigrations = []
  for (let v = 0; v < currentVersion; v += 1) {
    orderedMigrations.push(v === 3 && v3to4Migration ? v3to4Migration : migrations.get(`${v}->${v + 1}`))
  }

  const restoreArtifact = (artifact) => v3to4.restoreReleasedV4Artifact(artifact, knownEventTypes)

  const catalogOptions = {
    currentVersion,
    codecs: [...codecs.values()],
    migrations: orderedMigrations,
    restoreCurrentHeader: (header) => header,
    restoreCurrent: restoreArtifact,
    restoreTransformedCurrent: restoreArtifact,
    currentEncoder: codecs.get(currentVersion),
  }

  let catalog
  let catalogKind
  if (catalogPkg?.createSessionFormatCatalogWithChildren) {
    catalog = catalogPkg.createSessionFormatCatalogWithChildren([])
    catalogKind = '官方 createSessionFormatCatalogWithChildren([])（session-format-catalog 包）'
  } else {
    catalog = format.createSessionFormatCatalog(catalogOptions)
    catalogKind = '官方 createSessionFormatCatalog(...)（本工具按官方口径装配 catalog 选项）'
  }

  return { catalog, catalogKind, codecs, migrations, currentVersion, knownEventTypes, v3to4 }
}

// ───────────────────── 单文件校验（完整加载链路） ─────────────────────
class LayerError extends Error {
  constructor(layer, message) {
    super(message)
    this.layer = layer
  }
}

function sourceVersionFromName(path) {
  const m = /\.v(\d+)\.jsonl(\.zstd)?$/.exec(basename(path))
  return m ? Number(m[1]) : undefined
}

function validateFile(path, catalog, currentVersion) {
  const bytes = readFileSync(path)

  // ── L1 容器层 ──
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new LayerError('L1 容器层', 'empty or header-less Zstandard session log')
  const plaintexts = []
  for (const f of frames) {
    try {
      plaintexts.push(zstdDecompressSync(bytes.subarray(f.start, f.end)))
    } catch (error) {
      throw new LayerError('L1 容器层', `帧解压/校验失败（第 ${plaintexts.length + 1} 帧）: ${error.message}`)
    }
  }
  try {
    assertIndependentHeaderFrame(plaintexts[0])
  } catch (error) {
    throw new LayerError('L1 容器层', error.message)
  }
  const containerInfo = `帧数=${frames.length} 首帧行数=1${tornStart === undefined ? '' : ' 尾部撕裂帧=有'}`

  // ── L2 头部层 ──
  const headerRecord = plaintexts[0]
  const headerValue = parseJson(headerRecord.subarray(0, headerRecord.length - 1).toString('utf8'), 'header line')
  const headerVersion = storedVersion(headerValue)
  const namedVersion = sourceVersionFromName(path)
  if (namedVersion !== undefined && namedVersion !== headerVersion) {
    throw new LayerError(
      'L2 头部层',
      `resolved JSONL source filename identifies v${namedVersion}, but its header identifies v${headerVersion}`,
    )
  }
  if (headerVersion > currentVersion) {
    throw new LayerError('L2 头部层', `stored Session uses newer format v${headerVersion}; this build writes v${currentVersion}`)
  }

  let restore
  try {
    restore = catalog.createRestore(headerValue, { recovery: 'recoverable', validation: 'transformed' })
  } catch (error) {
    throw new LayerError('L2 头部层', error.message)
  }

  // ── L3 行准入层 + L4 迁移层 ──
  const rows = new MigratingJsonlRows(restore)
  try {
    for (const pt of plaintexts.slice(1)) rows.write(pt)
    rows.assertCompleteFramesEndOnRecord()
    if (tornStart !== undefined) {
      let recovered = Buffer.alloc(0)
      try {
        recovered = zstdDecompressSync(bytes.subarray(tornStart))
      } catch {
        /* 结构不完整的末帧可能解不出任何明文，已完整的帧仍然可恢复 */
      }
      const nl = recovered.lastIndexOf(0x0A)
      if (nl !== -1) rows.write(recovered.subarray(0, nl + 1))
    }
  } catch (error) {
    const message = error.message
    if (message.startsWith('corrupt Zstandard session log')) throw new LayerError('L1 容器层', message)
    if (message.startsWith('corrupt session log')) throw new LayerError('L2 头部层', message)
    const layer = message.includes('refuses this format') ? 'L4 迁移层' : 'L3 行准入层'
    throw new LayerError(layer, message)
  }

  // ── L5 还原层 ──
  let artifact
  try {
    artifact = rows.finish()
  } catch (error) {
    const message = error.message
    const layer = message.includes('refuses the transformed artifact') ? 'L5 还原层'
      : message.includes('refuses this format') ? 'L4 迁移层'
        : 'L3 行准入层'
    throw new LayerError(layer, message)
  }

  return {
    container: containerInfo,
    headerVersion,
    v4: artifact.events.length,
    inherited: artifact.inheritedEventCount,
  }
}

// ───────────────────── 批量 ─────────────────────
function findSessions(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walk(p)
      } else if (e.isFile() && e.name.startsWith('session') && e.name.endsWith('.zstd')) {
        out.push(p)
      }
    }
  }
  walk(root)
  return out.sort()
}

async function main() {
  const repo = findRepo(repoFlag)
  if (!repo) {
    console.log('FAIL  未能定位 DSH 仓库（找不到 packages/session/session-format/package.json）')
    console.log('      请用 --repo 指定仓库根目录，例如：')
    console.log('      node 官方校验.mjs <目标> --repo "D:\\DeepseekHarness\\deepseek-harness"')
    process.exit(1)
  }
  console.log(`DSH 仓库: ${repo}`)
  const { modules, failures } = await loadOfficial(repo)
  console.log(`已导入官方编译产物: ${modules.size} 个包`)
  if (failures.length > 0) {
    console.log('导入告警:')
    for (const f of failures) console.log(`  - ${f}`)
  }

  const built = buildCatalog(repo, modules)
  if (built.missing && built.missing.length > 0) {
    console.log('')
    console.log('FAIL  官方依赖不齐，无法构成完整加载链路：')
    for (const m of built.missing) console.log(`  - ${m}`)
    process.exit(1)
  }
  console.log(`加载层装配: ${built.catalogKind}`)
  console.log(`v3->v4 迁移器: 官方 createSessionFormatV3ToV4([])（按「无子会话」声明）`)
  console.log(`已知事件类型表: 官方 KNOWN_SESSION_EVENT_TYPES（${built.knownEventTypes.size} 项）`)
  console.log('✅ 零替身：容器/头部/行准入/迁移/还原 全部使用仓库内官方编译产物')
  if (preflightOnly) process.exit(0)

  if (targets.length === 0) {
    console.log('')
    usage()
    process.exit(1)
  }

  const files = []
  for (const t of targets) {
    let st
    try {
      st = statSync(t)
    } catch {
      console.log(`FAIL  ${t}  (路径不存在)`)
      process.exitCode = 1
      continue
    }
    if (st.isDirectory()) files.push(...findSessions(t))
    else files.push(t)
  }
  if (files.length === 0) {
    console.log('未找到任何会话文件（session*.zstd）')
    process.exit(1)
  }

  console.log('')
  const results = []
  for (const f of files) {
    let r
    try {
      r = validateFile(f, built.catalog, built.currentVersion)
      r = { path: f, ok: true, ...r }
    } catch (error) {
      r = {
        path: f,
        ok: false,
        layer: error instanceof LayerError ? error.layer : '未知',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    results.push(r)
    if (!quiet) {
      if (r.ok) {
        console.log(`PASS  [${r.container}] header=v${r.headerVersion} v4事件=${r.v4} 继承=${r.inherited}`)
        console.log(`      ${r.path}`)
      } else {
        console.log(`FAIL  ${r.layer}`)
        console.log(`      ${r.reason}`)
        console.log(`      ${r.path}`)
      }
    }
    if (!r.ok && failFast) break
  }

  const pass = results.filter((r) => r.ok).length
  const fail = results.length - pass
  console.log('')
  console.log(`汇总: 共 ${results.length} 个，PASS ${pass}，FAIL ${fail}`)
  if (fail > 0) {
    console.log('失败清单:')
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.path}`)
      console.log(`    层次: ${r.layer}`)
      console.log(`    原因: ${r.reason}`)
    }
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('校验器异常:', error)
  process.exit(1)
})
