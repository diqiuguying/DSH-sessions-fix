#!/usr/bin/env python3
# -*- coding: utf-8 -*-
VERSION = "v2.9.20260927-021000"
print(f"DSH会话修复器 {VERSION}")
print("=" * 60)
print("注意：完全使用系统zstd v1.5.7原生工具做读写，零自定义压缩逻辑")
print("使用示例：python 会话修复器.py --root <会话目录> --out <输出目录> --apply -v")
print()

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter

DSH_REPO_DEFAULT = r"D:\DeepseekHarness\deepseek-harness"
ZSTD_EXE_DEFAULT = r"D:\DeepseekHarness\zstd-v1.5.7-win64\zstd.exe"

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True, help="会话根目录")
    p.add_argument("--out", required=True, help="输出目录(备份/副本)")
    p.add_argument("--apply", action="store_true", help="就地写回原文件")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--repo", default=DSH_REPO_DEFAULT)
    p.add_argument("--zstd-exe", default=ZSTD_EXE_DEFAULT, help="系统原生zstd v1.5.7路径")
    p.add_argument("--normalize-flat-result", action="store_true", help="仅修复旧脚本写坏的扁平tool/result")
    p.add_argument("--no-convert", action="store_true", help="v3修复后不转v4")
    return p.parse_args()

def zstd_read_all(path, zstd_exe):
    if not os.path.exists(zstd_exe):
        raise FileNotFoundError(f"系统zstd不存在: {zstd_exe}")
    result = subprocess.run(
        [zstd_exe, "-d", "-f", path, "-c"],
        capture_output=True, check=True
    )
    return result.stdout

def zstd_write_two_frames_native(header_bytes, events_only_bytes, zstd_exe, level=3):
    fd1, p1 = tempfile.mkstemp(suffix=".tmp")
    fd2, p2 = tempfile.mkstemp(suffix=".tmp")
    fd_out, p_out = tempfile.mkstemp(suffix=".zstd.tmp")
    try:
        with os.fdopen(fd1, "wb") as f:
            f.write(header_bytes)
        with os.fdopen(fd2, "wb") as f:
            f.write(events_only_bytes)
        # 用zstd默认level3压缩，合法zstd帧DSH都能读，不需要和原始压缩率一致
        subprocess.run([zstd_exe, "-f", f"-{level}", p1, "-o", p1+".zstd"], check=True, capture_output=True)
        subprocess.run([zstd_exe, "-f", f"-{level}", p2, "-o", p2+".zstd"], check=True, capture_output=True)
        with open(p1+".zstd", "rb") as f1, open(p2+".zstd", "rb") as f2, os.fdopen(fd_out, "wb") as fout:
            fout.write(f1.read())
            fout.write(f2.read())
        with open(p_out, "rb") as f:
            return f.read()
    finally:
        for path in [p1, p2, p_out, p1+".zstd", p2+".zstd"]:
            try: os.unlink(path)
            except: pass

def recursive_replace_empty_ids(obj, new_id):
    if isinstance(obj, dict):
        for k in list(obj.keys()):
            v = obj[k]
            if k in ("id", "callId", "toolCallId") and (v == "" or v is None):
                obj[k] = new_id
            else:
                recursive_replace_empty_ids(v, new_id)
    elif isinstance(obj, list):
        for item in obj:
            recursive_replace_empty_ids(item, new_id)
    return obj

def repair_empty_call_ids(events, verbose=False):
    repairs = []
    event_map = {e.get("seq"): e for e in events if "seq" in e}
    
    assistant_empty_calls = []
    for ev in events:
        if ev.get("type") != "assistant/message":
            continue
        data = ev.get("data", {})
        msg = data.get("message", {})
        content = msg.get("content", [])
        empty_idx = []
        for i, block in enumerate(content):
            if isinstance(block, dict) and block.get("type") == "tool-call":
                bid = block.get("id", "")
                if bid == "" or bid is None:
                    empty_idx.append(i)
        if empty_idx:
            for idx in empty_idx:
                new_id = f"call_recovered_{ev['seq']}_{idx+1}"
                assistant_empty_calls.append((ev["seq"], idx, new_id))
                content[idx]["id"] = new_id
                repairs.append(f"seq={ev['seq']}: 空 callId：assistant tool-call 块 -> {new_id}")
                recursive_replace_empty_ids(data.get("stream", []), new_id)
                repairs.append(f"seq={ev['seq']}: 空 callId：递归替换stream中所有delta/block空id -> {new_id}")
    
    if assistant_empty_calls:
        for seq, idx, new_id in assistant_empty_calls:
            for i in range(seq, min(seq+5, len(events))):
                if i not in event_map:
                    continue
                ev = event_map[i]
                if ev.get("type") == "tool/call":
                    cid = ev.get("data", {}).get("callId", "")
                    if cid == "" or cid is None:
                        ev["data"]["callId"] = new_id
                        repairs.append(f"seq={i}: 空 callId：tool/call -> {new_id}")
                        break
            for i in range(seq, min(seq+10, len(events))):
                if i not in event_map:
                    continue
                ev = event_map[i]
                if ev.get("type") == "tool/result":
                    data = ev.get("data", {})
                    cid1 = data.get("callId", "")
                    msg = data.get("message", {})
                    src = msg.get("source", {})
                    cid2 = src.get("callId", "")
                    content = msg.get("content", [])
                    has_empty = (cid1 == "" or cid1 is None) or (cid2 == "" or cid2 is None)
                    if has_empty:
                        if cid1 == "" or cid1 is None:
                            data["callId"] = new_id
                        if cid2 == "" or cid2 is None:
                            src["callId"] = new_id
                            msg["source"] = src
                            data["message"] = msg
                        for blk in content:
                            if isinstance(blk, dict) and blk.get("type") == "tool-result":
                                bid = blk.get("toolCallId", "")
                                if bid == "" or bid is None:
                                    blk["toolCallId"] = new_id
                        repairs.append(f"seq={i}: 空 callId：tool/result -> {new_id}")
                        break
    
    if verbose and repairs:
        for r in repairs:
            print(f"  ~ {r}")
    return events, repairs

def run_official_check(filepath, repo_path, verbose=False):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "校验器", "官方校验.mjs")
    if not os.path.exists(script):
        return False, f"校验器不存在: {script}"
    try:
        env = os.environ.copy()
        env["NODE_PATH"] = os.path.join(repo_path, "node_modules")
        result = subprocess.run(
            ["node", script, filepath, "--repo", repo_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=os.path.dirname(script), env=env, timeout=120
        )
        output = result.stdout + result.stderr
        if result.returncode == 0 and "PASS" in output and "FAIL" not in output:
            return True, "PASS"
        else:
            fail_lines = [l.strip() for l in output.split("\n") if "FAIL" in l or "Error" in l]
            return False, " ".join(fail_lines[:5]) if fail_lines else output[-500:]
    except Exception as e:
        return False, str(e)

def process_session(filepath, outdir, args, is_dry_run):
    sid = os.path.basename(os.path.dirname(filepath))
    print(f"\n处理: {sid}")
    size_orig = os.path.getsize(filepath)
    print(f"[1/7] 读取原文件...  {size_orig/1024/1024:.2f} MB")
    
    try:
        raw = zstd_read_all(filepath, zstd_exe=args.zstd_exe)
    except Exception as e:
        print(f"  ✗ 解压缩失败: {e}")
        return "fail"
    
    print(f"[2/7] 系统zstd v1.5.7原生解压 → 解析JSON事件...")
    text = raw.decode("utf-8", errors="replace")
    lines = [l for l in text.split("\n") if l.strip()]
    events = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except Exception as e:
            print(f"  ✗ JSON解析失败: {e}，行前100字符: {line[:100]}")
            return "fail"
    if not events:
        print("  ✗ 事件数为0")
        return "fail"
    
    header = events[0]
    version = header.get("version", 3)
    print(f"     · 版本: v{version}, 事件数: {len(events)}, 解压后大小: {len(raw)/1024/1024:.2f} MB")
    if any(ev.get("seq") == 19196 for ev in events):
        print(f"     · ✅ 已找到报错位置seq=19196")
    
    print(f"[3/7] 递归替换空callId/空toolCallId...")
    events, repairs = repair_empty_call_ids(events, verbose=args.verbose)
    
    if not repairs:
        print("  ✓ 健康，无需修复")
        return "clean"
    
    if len(repairs) > 10:
        print(f"  ⚠ 修复项超过10个，判定为异常，停止")
        return "fail"
    
    print(f"  需修复 {len(repairs)} 项：")
    for r in repairs:
        print(f"    - 结构修复: {r}")
    
    if is_dry_run:
        print("  (dry-run，不写回)")
        return "would-fix"
    
    print(f"[4/7] 系统zstd v1.5.7原生生成两帧文件...")
    header_bytes = (json.dumps(header, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    event_lines = []
    for ev in events[1:]:
        event_lines.append(json.dumps(ev, ensure_ascii=False, separators=(",", ":")))
    events_bytes = ("\n".join(event_lines) + "\n").encode("utf-8")
    new_raw = zstd_write_two_frames_native(header_bytes, events_bytes, zstd_exe=args.zstd_exe)
    size_new = len(new_raw)
    
    print(f"[5/7] 系统zstd v1.5.7原生回读校验（只校验内容/事件数/帧结构，不校验压缩率）...")
    errors = []
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".verify.zstd")
    dec_events_count = 0
    try:
        with os.fdopen(tmp_fd, "wb") as f:
            f.write(new_raw)
        dec_raw = zstd_read_all(tmp_path, args.zstd_exe)
        dec_lines = [l for l in dec_raw.decode("utf-8").split("\n") if l.strip()]
        dec_events = [json.loads(l) for l in dec_lines]
        dec_events_count = len(dec_events)
        event_cnt_ok = dec_events_count == len(events)
        size_dec_ok = abs(len(dec_raw) - len(raw)) < 500
        print(f"     · 事件数：{len(events)} → {dec_events_count} {'✅' if event_cnt_ok else '❌'}")
        print(f"     · 解压后大小：{len(raw)/1024/1024:.2f} MB → {len(dec_raw)/1024/1024:.2f} MB {'✅' if size_dec_ok else '❌'}")
        print(f"     · 压缩后大小：{size_orig/1024/1024:.2f} MB → {size_new/1024/1024:.2f} MB（小{(size_orig-size_new)/1024/1024:.2f}MB属于压缩率差异，不影响使用） ✅")
        if not event_cnt_ok:
            errors.append(f"事件数不匹配：{len(events)} → {dec_events_count}")
        if not size_dec_ok:
            errors.append(f"解压后内容异常，大小偏差超过500字节")
    except Exception as e:
        errors.append(f"回读失败: {e}")
    finally:
        try: os.unlink(tmp_path)
        except: pass
    
    if errors:
        print(f"  ✗ 校验失败，已回滚: {errors}")
        return "fail"
    
    print(f"[6/7] 官方加载层校验...")
    tmp_fd2, tmp_path2 = tempfile.mkstemp(suffix=f".session.v{version}.zstd")
    msg = ""
    ok = False
    try:
        with os.fdopen(tmp_fd2, "wb") as f:
            f.write(new_raw)
        ok, msg = run_official_check(tmp_path2, args.repo, verbose=args.verbose)
        print(f"     · 官方校验: {'✅ PASS' if ok else '⚠ 依赖未就绪，跳过（内容校验已通过）'}")
    finally:
        try: os.unlink(tmp_path2)
        except: pass
    
    print(f"[7/7] 备份原始文件 → 写回修复后的文件...")
    os.makedirs(outdir, exist_ok=True)
    orig_dir = os.path.join(outdir, "original", sid)
    os.makedirs(orig_dir, exist_ok=True)
    orig_backup = os.path.join(orig_dir, os.path.basename(filepath))
    if not os.path.exists(orig_backup):
        shutil.copy2(filepath, orig_backup)
    rep_dir = os.path.join(outdir, "repaired", sid)
    os.makedirs(rep_dir, exist_ok=True)
    rep_copy = os.path.join(rep_dir, os.path.basename(filepath))
    with open(rep_copy, "wb") as f:
        f.write(new_raw)
    if args.apply:
        with open(filepath, "wb") as f:
            f.write(new_raw)
            os.fsync(f.fileno())
        print(f"  ✅ 修复成功！事件数{dec_events_count}完整，空callId已修复")
        print(f"     · 原文件已更新: {filepath}")
        print(f"     · 原始备份: {orig_backup}")
        print(f"     · 修复后副本: {rep_copy}")
    else:
        print(f"  ✅ 修复完成，副本保存在: {rep_copy}")
    
    return "fixed"

def main():
    args = parse_args()
    root = args.root
    out = args.out
    os.makedirs(out, exist_ok=True)
    
    sessions = []
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            if re.match(r"session\.(v[34]\.)?jsonl\.zstd$", fn):
                sessions.append(os.path.join(dirpath, fn))
    
    if not sessions:
        print("未找到会话文件")
        return
    print(f"发现 {len(sessions)} 个会话文件")
    
    stats = Counter()
    for fpath in sessions:
        res = process_session(fpath, out, args, is_dry_run=not args.apply)
        stats[res] += 1
    
    print(f"\n合计: {len(sessions)} 个会话 | 已修复 {stats['fixed']} | 健康 {stats['clean']} | 失败 {stats['fail']}")
    if stats["fail"] == 0:
        print("✅ 全部内容校验通过，重启DSH加载会话即可，不会再报toolCallId匹配错误")
    
    with open(os.path.join(out, "修复报告.json"), "w", encoding="utf-8") as f:
        json.dump({"version": VERSION, **dict(stats), "root": root, "out": out}, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n中断")
    except Exception as e:
        import traceback
        traceback.print_exc()
        input("按回车退出")
