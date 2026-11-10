#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""启动 AE 执行 jsx，自动处理"崩溃修复选项"对话框，等待日志。
用法: python run_ae.py <script.jsx> <log.txt> [超时秒]
"""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes

AE = r"C:\Program Files\Adobe\Adobe After Effects 2024\Support Files\AfterFX.exe"
u = ctypes.windll.user32


def find_dialog():
    found = []

    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(h, l):
        b = ctypes.create_unicode_buffer(300)
        u.GetWindowTextW(h, b, 300)
        t = b.value
        if t and ("崩溃修复" in t or "Crash" in t or "安全模式" in t):
            found.append(h)
        return True

    u.EnumWindows(EnumProc(cb), 0)
    return found[0] if found else 0


def dismiss(hwnd):
    u.ShowWindow(hwnd, 5)
    time.sleep(0.4)
    try:
        u.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.6)
    u.keybd_event(0x1B, 0, 0, 0)
    time.sleep(0.12)
    u.keybd_event(0x1B, 0, 2, 0)


def kill_ae():
    subprocess.run(["taskkill", "/F", "/IM", "AfterFX.exe"],
                   capture_output=True, shell=False)
    time.sleep(2.5)


def main():
    jsx, logf = sys.argv[1], sys.argv[2]
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 900

    if os.path.exists(logf):
        os.remove(logf)

    kill_ae()
    t0 = time.time()
    proc = subprocess.Popen([AE, "-r", jsx], close_fds=True)

    dismissed = 0
    last_size = -1
    stable = 0
    while time.time() - t0 < timeout:
        time.sleep(2)
        if dismissed < 6:
            h = find_dialog()
            if h:
                dismiss(h)
                dismissed += 1
                print("[run_ae] 关闭崩溃对话框 #%d" % dismissed, flush=True)
                continue
        # 每章都会写日志，所以以"AE 进程退出"作为结束信号
        alive = subprocess.run(["tasklist", "/FI", "IMAGENAME eq AfterFX.exe"],
                               capture_output=True)
        if b"AfterFX.exe" not in (alive.stdout or b""):
            time.sleep(3)
            break

    dt = time.time() - t0
    print("[run_ae] 用时 %.1fs" % dt, flush=True)
    if os.path.exists(logf):
        with open(logf, "r", encoding="utf-8", errors="replace") as f:
            print("---- LOG ----")
            print(f.read())
    else:
        print("[run_ae] 没有生成日志文件（脚本可能没跑起来）")
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


if __name__ == "__main__":
    main()
