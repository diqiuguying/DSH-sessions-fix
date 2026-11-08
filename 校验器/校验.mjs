#!/usr/bin/env node
/**
 * DSH 会话文件校验器（独立运行，无需安装依赖）
 *
 * 用法:
 *   node 校验.mjs <文件.zstd>                    # 校验单个文件
 *   node 校验.mjs <文件1> <文件2> ...            # 校验多个文件
 *   node 校验.mjs <目录>                          # 批量校验目录下所有会话（递归）
 *   node 校验.mjs <目录> --quiet                  # 批量校验，只打印汇总
 *   node 校验.mjs <目录> --fail-fast              # 遇到第一个 FAIL 就停止
 *
 * 输出:  PASS / FAIL + 原因（与 DSH 迁移器的判定一致）
 * 退出码: 全部 PASS -> 0；有 FAIL 或参数错误 -> 1
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createSessionFormatChain, SessionFormatEventCollector } from './session-format/src/index.js'
import { createSessionFormatV3ToV4, restoreReleasedV4Artifact } from './session-format-v3-to-v4/src/index.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function scanFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    if (buf.length - off < 4 || !buf.subarray(off, off + 4).equals(MAGIC)) break
    const start = off
    off += 4
    if (off >= buf.length) break
    const desc = buf[off++]
    const csf = desc >> 6
    const single = (desc & 0x20) !== 0
    const checksum = (desc & 0x04) !== 0
    const dictFlag = desc & 0x03
    off += (single ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + (csf === 0 ? (single ? 1 : 0) : 1 << csf)
    for (;;) {
      if (buf.length - off < 3) return frames
      const bh = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
      off += 3
      const last = bh & 1, btype = (bh >> 1) & 3, bsize = bh >> 3
      if (btype === 1) off += 1
      off += bsize
      if (last) break
    }
    if (checksum) off += 4
    frames.push(buf.subarray(start, off))
  }
  return frames
}

/** 首帧必须只含 header 一行（官方 assertIndependentHeaderFrame / assertZstdHeaderFrame）。 */
export function assertIndependentHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

export function decodeContainer(path) {
  const frames = scanFrames(readFileSync(path))
  if (!frames.length) throw new Error('empty or header-less Zstandard session log')
  const plaintexts = frames.map(f => zstdDecompressSync(f))
  // 容器层契约：第 1 帧恰好一行 header
  assertIndependentHeaderFrame(plaintexts[0])
  let text = ''
  for (const p of plaintexts) text += p.toString('utf8')
  return {
    frames: frames.length,
    headerFrameLines: 1,
    lines: text.split('\n').filter(l => l.trim().length > 0),
  }
}

const stub = (from) => ({
  name: `stub-v${from}`,
  fromVersion: from, toVersion: from + 1,
  migrateHeader: (h) => ({ ...h, version: from + 1 }),
  createStage: () => ({ transformEvent: () => {}, transformRun: () => {}, finish: () => 0 }),
})

export function validateLines(lines) {
  const raw = JSON.parse(lines[0])
  const { type: _t, ...header } = raw
  if (process.platform !== 'win32' && typeof header.cwd === 'string' && /^[A-Za-z]:[\\/]/.test(header.cwd)) {
    header.cwd = '/' + header.cwd.replace(/\\/g, '/').replace(':', '')
  }
  const events = lines.slice(1).map(l => JSON.parse(l))
  const chain = createSessionFormatChain({
    currentVersion: 4,
    migrations: [stub(0), stub(1), stub(2), createSessionFormatV3ToV4([])],
    restoreCurrentHeader: h => h,
  })
  const collector = new SessionFormatEventCollector()
  const stream = chain.createStream(header, undefined, collector)
  for (const ev of events) stream.emitEvent(ev)
  const cut = stream.finish()
  const artifact = { header: stream.header, inheritedEventCount: cut, events: collector.values }
  restoreReleasedV4Artifact(artifact, new Set(artifact.events.map(e => e.type)))
  return { v3: events.length, v4: artifact.events.length }
}

/** 与修复器一致的扫描规则：递归找 session*.zstd */
export function findSessions(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
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

function validateOne(path) {
  try {
    const { frames, headerFrameLines, lines } = decodeContainer(path)
    const r = validateLines(lines)
    return { path, ok: true, frames, headerFrameLines, v3: r.v3, v4: r.v4 }
  } catch (e) {
    return { path, ok: false, reason: e.message }
  }
}

function main() {
  const argv = process.argv.slice(2)
  const quiet = argv.includes('--quiet')
  const failFast = argv.includes('--fail-fast')
  const targets = argv.filter(a => !a.startsWith('--'))

  if (!targets.length) {
    console.log('用法:')
    console.log('  node 校验.mjs <文件.zstd>                # 校验单个文件')
    console.log('  node 校验.mjs <文件1> <文件2> ...        # 校验多个文件')
    console.log('  node 校验.mjs <目录>                      # 批量校验目录下所有会话（递归）')
    console.log('  node 校验.mjs <目录> --quiet              # 只打印汇总')
    console.log('  node 校验.mjs <目录> --fail-fast          # 遇错即停')
    process.exit(2)
  }

  // 展开目标：目录 -> 其下所有 session*.zstd；文件 -> 原样
  const files = []
  for (const t of targets) {
    let st
    try { st = statSync(t) } catch { console.log(`FAIL  ${t}  (路径不存在)`); process.exitCode = 1; continue }
    if (st.isDirectory()) files.push(...findSessions(t))
    else files.push(t)
  }

  if (!files.length) { console.log('未找到任何会话文件（session*.zstd）'); process.exit(1) }

  const results = []
  for (const f of files) {
    const r = validateOne(f)
    results.push(r)
    if (!quiet) {
      if (r.ok) console.log(`PASS  帧数=${r.frames} 首帧行数=${r.headerFrameLines}  v3事件=${r.v3}  v4事件=${r.v4}  ${r.path}`)
      else console.log(`FAIL  ${r.reason}  ${r.path}`)
    }
    if (!r.ok && failFast) break
  }

  const pass = results.filter(r => r.ok).length
  const fail = results.length - pass
  console.log('')
  console.log(`汇总: 共 ${results.length} 个，PASS ${pass}，FAIL ${fail}`)
  if (fail) {
    console.log('失败清单:')
    for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.path}\n    原因: ${r.reason}`)
  }
  process.exit(fail ? 1 : 0)
}

if (process.argv[1] && process.argv[1].endsWith('校验.mjs')) main()
