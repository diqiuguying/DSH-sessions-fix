# DSH 会话文件批量修复使用说明

配套脚本：`dsh-session-batch-repair.mjs`

适用报错（dsh 大版本升级后，打开历史会话时报）：

```
历史加载失败：failed to observe session "session-xxxx":
  Session migration from v3 to v4 refuses the transformed artifact:
    step/end leaves unresolved tool call call_xxxxxxxx
    或  turn/start N does not open expected turn M
  source v3 artifact remains unchanged
  (raw log: ...\.dsh\sessions\<工作区编码目录>\<会话ID>\session.v3.jsonl.zstd)
（gateway/internal）
```

---

## 一、先搞懂：为什么需要「批量」修

### 1. 这类坏文件不是个例

根因是**旧版 writer 的边界 bug**：在「assistant 尝试被中断 → 用户继续任务」这种场景下，
v3 writer 漏写了 `turn/end` 或 `tool/result`，让一条工具调用或一个回合没有闭环。

- 这不是文件损坏，**数据是完整的**，只是少了几个「关闭」事件；
- 但你一旦跨版本升级过、且历史上有过进程中断 / 强杀 / 断电，**很可能是多个会话同时中招**，
  一个一个手改不现实 —— 这就是批量修复的用武之地。

### 2. 迁移器是「保守拒绝」，不会帮你修

`v3 → v4` 迁移在**打开（observe）会话时**才触发，做两件事：格式转换 + 跨事件关系校验。
校验逐事件跑状态机，检查四类关系：

| 关系 | 规则 |
|---|---|
| **turn 配平** | `turn/start N` 时要求前一回合已 `turn/end` 关闭，且 N 严格递增 |
| **step 归属** | `step/start` / `step/end` 必须落在当前 open 的 turn 内，step 号连续 |
| **tool 生命周期** | 每个 `tool/call` 必须有先前广告（`assistant/message` 的 tool-call），并最终配对 `tool/result` |
| **surface 引用** | `compaction/summary` 的 `shadowedSeqs` 必须精确等于当前 surface 上的节点序列 |

任一不满足 → 抛 `SessionFormatError` → **拒绝落盘转换产物、源文件原样保留**。
这是刻意设计：猜错修补比打不开更糟。**所以修补只能靠外部工具做，而修的过程恰好可以复用官方校验规则当"测试"。**

---

## 二、三个必须知道的格式事实（脚本已内置处理）

### 事实 1：`.zstd` 是「拼接帧容器」，不是单个 zstd 文件

writer 每追加一批记录就压成一帧拼到文件尾（便于崩溃时丢弃尾部残帧）。
**Node 的 `zstdDecompressSync` 对含尾随数据的 buffer 会静默只解第一帧** ——
直接对整个文件解压，你只会得到一行 header，会误判成「文件正常」。

> 实测证据：对两帧拼接的 buffer 调用 `zstdDecompressSync`，不报错，但只返回第一帧内容。

脚本用**魔数扫描 + 贪婪解码**正确切帧：扫描 `28 B5 2F FD`，从每个候选起点向后扩到解码成功为止
（压缩数据里偶然出现的假魔数只会让切片变长，真帧边界一次就过）。

### 事实 2：seq 是全局稠密索引，且事件内部还存着「被引用事件的 seq」

- 校验器要求 `events[i].seq === i`（稠密）；
- 插入一个事件后，**插入点之后所有事件的 seq 都要 +1**，而且事件内部这些字段存的是
  「被引用事件的 seq 值」，必须**同步 +1**：
  `sourceEventSeqs`、`surfaceOp.start/end`、`data.messageSeqs`、
  `data.shadowedSeqs`、`data.shadowedRange.start/end`、`data.sourceEventSeq`。
- **只重排 seq 字段、漏同步内部引用，会得到一个"看着修好了"的假象**，校验器会报
  `compaction/summary shadowedSeqs do not name an exact current surface span`。
  这是最容易踩的隐藏坑，脚本已实现按「引用值 ≥ 插入点则 +1」精确同步，并打印每处改动。

### 事实 3：回写必须是「两帧」，且第一帧恰好是 header 一行

持久化层有容器契约 `assertZstdHeaderFrame`：**第一帧解码后必须恰好是 header 一行**。
这是"读恢复"设计的一部分 —— 启动扫描会话列表时只需解第一帧拿 header，不必解整个大文件。

- 把整份文件压成单帧 → 启动即报 `corrupt Zstandard session log: first frame is not exactly one header line`；
- 正确做法：帧 1 = header 行，帧 2 = 全部事件行。

---

## 三、用法

### 0. 前置

- **先停掉 dsh**（`pnpm dsh web` / `pnpm run dev`），避免与 writer 抢文件；
- Node ≥ 22.15 / 24（需要 `node:zlib` 的 zstd 支持）。你环境是 Node 24，可直接用；
- 脚本放哪都行，不依赖项目源码（自带帧扫描与解码）。

### 1. 先自检（确认工具本身可用）

```powershell
node dsh-session-batch-repair.mjs --self-test
```

会用一个合成样本跑完整修补 + 容器往返，全部 PASS 才继续。

### 2. 体检（dry-run，不改任何文件）

```powershell
node dsh-session-batch-repair.mjs
```

默认扫描 `$DSH_HOME/sessions`（否则 `~\.dsh\sessions`）。输出：

- **异物文件报告**：会话目录里非 `session*.jsonl*` 的文件（`.bak` / `.orig` 等）——
  这类文件会让**整个工作区的会话列表加载失败**，务必先移出；
- 每个会话的体检结果与需修复项；
- 报告落盘 `~/dsh-session-repair-<时间戳>/repair-report.json`。

指定目录：

```powershell
node dsh-session-batch-repair.mjs --root "C:\Users\diqiu\.dsh\sessions"
```

### 3. 止血（把打不开的会话移出，立即恢复可用）

```powershell
node dsh-session-batch-repair.mjs --mode quarantine --apply
```

把**解码失败或结构有问题**的会话整体移到 `.dsh` 之外（默认 `~\dsh-session-repair-<时间戳>\quarantine\`），
历史列表立刻干净、其余会话不受影响。**这是最保险的第一步。**

### 4. 修复（真正改写会话文件）

```powershell
node dsh-session-batch-repair.mjs --mode repair --apply -v
```

流程：解码 → 体检 → 迭代修补（补 `turn/end`、补 `tool/result`、同步引用、重排 seq）→
两帧回写（带校验和）→ **回读验证**。任一环节失败自动从备份回滚。

- 原文件先备份到 `<out>\original\<相同相对路径>`（在 `.dsh` 之外）；
- 临时文件写在系统临时目录，**不在会话目录留任何异物**；
- 加 `-v` 可看到每一处插入与引用同步的明细。

### 5. 重启验证

```powershell
pnpm dsh web
curl http://127.0.0.1:3080/    # 期望 401（正常，浏览器信任围栏）
```

浏览器打开工作区 → 点开原坏会话 → 迁移成功、历史完整加载。

---

## 四、参数速查

| 参数 | 说明 |
|---|---|
| `--root <dir>` | 会话根目录，默认 `$DSH_HOME/sessions` 或 `~\.dsh\sessions` |
| `--out <dir>` | 备份/产物目录，默认 `~\dsh-session-repair-<时间戳>`（**务必在 `.dsh` 之外**） |
| `--mode scan\|repair\|quarantine` | 体检 / 修复 / 止血，默认 `scan` |
| `--apply` | 真正落盘；不加则一律 dry-run |
| `--include <正则>` | 只处理路径匹配的会话 |
| `--limit <n>` | 最多处理 n 个（先拿几个试水） |
| `--no-checksum` | 回写不启用 zstd 校验和 |
| `-v, --verbose` | 打印修补明细 |
| `--self-test` | 自检 |

---

## 五、脚本的修补规则（与官方校验器对齐）

| 体检项 | 判定 | 是否自动修 | 修法 |
|---|---|---|---|
| `seq-not-dense` | `events[i].seq !== i` | ✅ | 重排 `seq = 下标` |
| `turn-not-closed` | `turn/start` 时上一回合未关闭 | ✅ | 在下个 `turn/start` 前的 `agent/inbox/spliced` 块之前插入 `turn/end` |
| `tool-unresolved` | 有 `tool/call` 无 `tool/result` | ✅ | **克隆同文件内已有的 `tool/result` 作模板**，改 call id、置错误态，插到 `tool/call` 之后 |
| `turn-number` | turn 号不连续 | ❌ 人工 | 只在报告里标出，不猜 |
| `turn-end-mismatch` | `turn/end` 的 turn 与 open 不符 | ❌ 人工 | 同上 |
| `tool-result-orphan` | 有 `tool/result` 无 `tool/call` | ❌ 人工 | 同上 |
| 容器首帧 ≠ 1 行 | 违反 `assertZstdHeaderFrame` | ✅ | 重切为「帧1 = header，帧2 = 事件」 |
| 打包块记录 | 一行内含多事件 | ❌ 跳过 | 报告为 `manual`，不自动改写 |
| 目录异物文件 | 非 `session*.jsonl*` | 报告 | 提示你移出 `.dsh` |

> **遇到无法自动修补的问题，脚本会明确跳过并标注 `MANUAL`，绝不猜测性改写** ——
> 与官方迁移器同一取向：宁可让你看见，也不静默改错。

---

## 六、进阶：直接用官方校验器当"测试"

脚本用的是与官方校验规则对齐的**独立实现**（因为不同版本包路径会变）。
如果你希望**用项目里那份真正的校验器**跑绿灯，可以在修复后用项目自带模块再验一遍
（在仓库根目录、用项目自己的 tsx 运行）：

```powershell
pnpm exec tsx -e "
import { assertReleasedArtifactRelationships } from './packages/session/session-format-v0-to-v1/src/relationships.ts';
// 读入解压后的 { header, events } 再断言，报什么错补什么
"
```

对应路径（以你的版本为准，先确认存在）：

| 内容 | 路径 |
|---|---|
| 帧扫描/解码/压缩 | `packages/session/session-persistence-jsonl/src/zstd.ts`（`scanZstdFrames` / `decompressZstdFrame` / `compressZstdFrame`） |
| 关系校验器 | `packages/session/session-format-v0-to-v1/src/relationships.ts`（`assertReleasedArtifactRelationships`） |
| 迁移器 | `packages/session/session-format-v3-to-v4/src/`（migration / validation / payload） |

---

## 七、风险与注意事项

1. **先止血、后深修**：`--mode quarantine --apply` 是最低风险的第一步，能立刻让 dsh 可用。
2. **修前必停 dsh**，且脚本已把原文件备份到 `.dsh` 之外；确认稳定后再清理备份。
3. **绝不在会话目录内留临时文件**：`.bak` / `.orig` 这类文件会导致整个工作区加载失败
   （这正是之前"重启后会话全不见"的原因）。备份一律放 `.dsh` 之外。
4. **大文件注意**：Windows 上曾出现「加载多个 >1MB 会话导致进程卡死」的已知问题
   （官方 issue 有记录）。批量修复不触发该问题，但修复后一次性打开大量大会话仍可能卡，
   建议先 `--limit` 小批量试。
5. **兜底结构需复核**：当同文件内**一个 `tool/result` 都没有**时，脚本用兜底结构补写，
   会在日志里打 `[警告]`。这种会话极少见，出现时请人工核对补写内容。

---

## 八、一句话总结

> 升级后打不开的历史会话，是旧版 writer 漏写 `turn/end` / `tool/result` 留下的**格式缺口**（数据没丢）。
> 用本工具「先止血（quarantine）→ 再批量补事件并同步引用 seq → 两帧回写」，
> 就能在不猜、不改错的前提下把一批会话救回来。
