# -*- coding: utf-8 -*-
"""
墨墨爱K歌 AI 工作站 - 环境自检脚本
检查 Python、NVIDIA 驱动、ffmpeg、虚拟环境、torch/CUDA、demucs、whisperx、requests
"""
import subprocess
import sys
import os

# 切换到脚本所在目录
os.chdir(os.path.dirname(os.path.abspath(__file__)))

PASS = "[OK]"
FAIL = "[!!]"
WARN = "[--]"

results = []


def check(title, cmd, success_text=None, fail_hint=None, timeout=30):
    """运行命令并判断是否成功"""
    print(f"\n{title}:")
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace"
        )
        output = (r.stdout + r.stderr).strip()
        if r.returncode == 0:
            if success_text:
                print(f"  {PASS} {success_text}")
            if output:
                # 只打印第一行关键信息
                first_line = output.split("\n")[0].strip()
                if first_line:
                    print(f"  {first_line}")
            results.append((title, True, ""))
            return True
        else:
            print(f"  {FAIL} 检测失败")
            if fail_hint:
                print(f"  {fail_hint}")
            results.append((title, False, fail_hint or ""))
            return False
    except FileNotFoundError:
        print(f"  {FAIL} 命令未找到")
        if fail_hint:
            print(f"  {fail_hint}")
        results.append((title, False, fail_hint or ""))
        return False
    except subprocess.TimeoutExpired:
        print(f"  {FAIL} 检测超时")
        results.append((title, False, "超时"))
        return False


def check_python_import(import_name, display_name, version_expr=None):
    """检查虚拟环境中 Python 包是否可导入"""
    print(f"\n{display_name}:")
    venv_py = os.path.join(".venv", "Scripts", "python.exe")
    if not os.path.exists(venv_py):
        print(f"  {FAIL} 虚拟环境不存在，跳过")
        results.append((display_name, False, "虚拟环境不存在"))
        return False

    if version_expr:
        code = f"import {import_name}; print({version_expr})"
    else:
        code = f"import {import_name}; print('已就绪')"

    try:
        r = subprocess.run(
            [venv_py, "-c", code],
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace"
        )
        output = (r.stdout + r.stderr).strip()
        if r.returncode == 0:
            first_line = output.split("\n")[0].strip()
            print(f"  {PASS} {first_line}")
            results.append((display_name, True, ""))
            return True
        else:
            print(f"  {FAIL} 导入失败")
            # 打印错误的最后几行
            err_lines = [l for l in output.split("\n") if l.strip()]
            if err_lines:
                print(f"  {err_lines[-1][:120]}")
            results.append((display_name, False, "导入失败"))
            return False
    except subprocess.TimeoutExpired:
        print(f"  {FAIL} 导入超时")
        results.append((display_name, False, "超时"))
        return False


print("=" * 50)
print("  墨墨爱K歌 AI 工作站 - 环境自检")
print("=" * 50)

# [1] 系统 Python
check(
    "[1] Python（需要 3.10 或 3.11）",
    ["python", "--version"],
    fail_hint="未检测到 Python，请到 https://www.python.org/downloads/ 安装 3.10 或 3.11，安装时勾选 Add to PATH"
)

# [2] NVIDIA 显卡
check(
    "[2] NVIDIA 显卡驱动",
    ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
    fail_hint="未检测到 N 卡或驱动，4070TiS 请安装最新 Game Ready/Studio 驱动"
)

# [3] ffmpeg
check(
    "[3] ffmpeg",
    ["ffmpeg", "-version"],
    fail_hint="未检测到 ffmpeg，管理员 PowerShell 执行：winget install Gyan.FFmpeg，装完重开窗口"
)

# [4] 虚拟环境
print("\n[4] 虚拟环境:")
venv_py = os.path.join(".venv", "Scripts", "python.exe")
if os.path.exists(venv_py):
    print(f"  {PASS} 已安装")
    results.append(("[4] 虚拟环境", True, ""))
    venv_exists = True
else:
    print(f"  {FAIL} 尚未安装")
    print("  请先运行 setup_windows.ps1 安装环境")
    print("  方法：在本文件夹空白处按住 Shift + 右键 -> 在此处打开 PowerShell，")
    print("  然后执行：powershell -ExecutionPolicy Bypass -File .\\setup_windows.ps1")
    results.append(("[4] 虚拟环境", False, "尚未安装"))
    venv_exists = False

if venv_exists:
    # [5] 虚拟环境 Python 版本
    check(
        "[5] 虚拟环境 Python",
        [venv_py, "--version"],
        fail_hint="虚拟环境 Python 无法执行，建议删除 .venv 后重跑 setup_windows.ps1"
    )

    # [6] PyTorch + CUDA
    print("\n[6] PyTorch 与 CUDA（关键，CUDA 必须为 True）:")
    torch_code = (
        "import torch, sys; "
        "sys.stdout.reconfigure(encoding='utf-8'); "
        "_cuda = torch.cuda.is_available(); "
        "print('torch 版本:', torch.__version__); "
        "print('CUDA可用:', _cuda); "
        "print('CUDA_ENABLED=' + ('1' if _cuda else '0')); "
        "print('显卡:', torch.cuda.get_device_name(0) if _cuda else '无')"
    )
    try:
        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        r = subprocess.run(
            [venv_py, "-c", torch_code],
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace", env=env
        )
        output = (r.stdout + r.stderr).strip()
        if r.returncode == 0:
            cuda_ok = "CUDA_ENABLED=1" in output
            for line in output.split("\n"):
                line = line.strip()
                if line and not line.startswith("CUDA_ENABLED="):
                    prefix = PASS if (cuda_ok and ("CUDA可用" in line or "torch" in line or "显卡" in line)) else ""
                    print(f"  {prefix} {line}" if prefix else f"  {line}")
            if cuda_ok:
                results.append(("[6] PyTorch/CUDA", True, ""))
            else:
                print(f"  {FAIL} CUDA 不可用！装成了 CPU 版 torch，需要重装 CUDA 版")
                print("  执行：.venv\\Scripts\\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124 --force-reinstall")
                results.append(("[6] PyTorch/CUDA", False, "CUDA不可用"))
        else:
            print(f"  {FAIL} torch 未安装或导入失败")
            err_lines = [l for l in output.split("\n") if l.strip()]
            if err_lines:
                print(f"  {err_lines[-1][:150]}")
            results.append(("[6] PyTorch/CUDA", False, "导入失败"))
    except subprocess.TimeoutExpired:
        print(f"  {FAIL} torch 导入超时")
        results.append(("[6] PyTorch/CUDA", False, "超时"))

    # [7] Demucs
    check_python_import("demucs", "[7] Demucs（人声分离）")

    # [8] WhisperX
    check_python_import("whisperx", "[8] WhisperX（逐字歌词对齐）")

    # [9] requests
    check_python_import("requests", "[9] requests（网络通信）", version_expr="'requests ' + requests.__version__")

# 汇总
print("\n" + "=" * 50)
print("  自检结果汇总")
print("=" * 50)
passed = sum(1 for _, ok, _ in results if ok)
failed = sum(1 for _, ok, _ in results if not ok)
for title, ok, hint in results:
    status = PASS if ok else FAIL
    print(f"  {status} {title}")
    if not ok and hint:
        print(f"       -> {hint[:80]}")

print(f"\n  通过: {passed} / {len(results)}")
if failed == 0:
    print("  全部通过！可以双击 启动AI工作站.bat 开始工作。")
else:
    print(f"  有 {failed} 项未通过，请根据上面的提示修复后重新自检。")
print("=" * 50)
