# -*- coding: utf-8 -*-
"""
墨墨爱K歌 - AI工作站图形化界面
一键安装环境、启动Worker、实时日志、防闪退
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox, filedialog
import json
import os
import sys
import subprocess
import threading
import time
import queue
from pathlib import Path

# 确保中文输出正常
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

APP_TITLE = "墨墨爱K歌 - AI工作站"
APP_VERSION = "1.0.0"
CONFIG_FILE = "config.json"

# 默认配置
DEFAULT_CONFIG = {
    "server_url": "http://192.168.3.16:8083",
    "admin_password": "admin888",
    "device": "cuda",
    "demucs_model": "htdemucs",
    "whisper_model": "large-v2",
    "batch_size": 1,
    "auto_restart": True,
    "hf_mirror": True
}


class AIWorkstationGUI:
    def __init__(self, root):
        self.root = root
        self.root.title(f"{APP_TITLE} v{APP_VERSION}")
        self.root.geometry("900x700")
        self.root.minsize(800, 600)

        # 设置中文字体
        self.font_normal = ("Microsoft YaHei", 10)
        self.font_bold = ("Microsoft YaHei", 10, "bold")
        self.font_title = ("Microsoft YaHei", 12, "bold")

        # 状态变量
        self.config = self.load_config()
        self.worker_process = None
        self.worker_running = False
        self.log_queue = queue.Queue()
        self.installing = False

        # 构建界面
        self.build_ui()

        # 启动日志更新线程
        self.update_log()

        # 启动时检测环境
        self.root.after(500, self.check_environment)

    def load_config(self):
        """加载配置"""
        try:
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                    # 合并默认配置
                    for k, v in DEFAULT_CONFIG.items():
                        if k not in cfg:
                            cfg[k] = v
                    return cfg
        except Exception as e:
            print(f"加载配置失败: {e}")
        return DEFAULT_CONFIG.copy()

    def save_config(self):
        """保存配置"""
        try:
            self.config['server_url'] = self.server_url_var.get()
            self.config['admin_password'] = self.admin_pass_var.get()
            self.config['device'] = self.device_var.get()
            self.config['demucs_model'] = self.demucs_var.get()
            self.config['whisper_model'] = self.whisper_var.get()
            self.config['batch_size'] = int(self.batch_var.get())
            self.config['auto_restart'] = self.auto_restart_var.get()
            self.config['hf_mirror'] = self.hf_mirror_var.get()

            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, indent=2, ensure_ascii=False)
            self.log("配置已保存")
            return True
        except Exception as e:
            self.log(f"保存配置失败: {e}")
            return False

    def build_ui(self):
        """构建界面"""
        # 主容器
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # ===== 顶部：标题 + 状态 =====
        top_frame = ttk.Frame(main_frame)
        top_frame.pack(fill=tk.X, pady=(0, 10))

        title_label = ttk.Label(top_frame, text="🎤 墨墨爱K歌 - AI工作站", font=self.font_title)
        title_label.pack(side=tk.LEFT)

        self.status_label = ttk.Label(top_frame, text="● 未启动", foreground="gray", font=self.font_bold)
        self.status_label.pack(side=tk.RIGHT)

        # ===== 配置区域 =====
        config_frame = ttk.LabelFrame(main_frame, text="⚙️ 配置", padding="10")
        config_frame.pack(fill=tk.X, pady=(0, 10))

        # 第一行：服务器地址 + 密码
        row1 = ttk.Frame(config_frame)
        row1.pack(fill=tk.X, pady=2)

        ttk.Label(row1, text="服务器地址:", width=12).pack(side=tk.LEFT)
        self.server_url_var = tk.StringVar(value=self.config.get('server_url', ''))
        ttk.Entry(row1, textvariable=self.server_url_var, width=30).pack(side=tk.LEFT, padx=(0, 10))

        ttk.Label(row1, text="管理员密码:", width=10).pack(side=tk.LEFT)
        self.admin_pass_var = tk.StringVar(value=self.config.get('admin_password', ''))
        ttk.Entry(row1, textvariable=self.admin_pass_var, width=15, show="*").pack(side=tk.LEFT)

        # 第二行：设备 + 模型
        row2 = ttk.Frame(config_frame)
        row2.pack(fill=tk.X, pady=2)

        ttk.Label(row2, text="计算设备:", width=12).pack(side=tk.LEFT)
        self.device_var = tk.StringVar(value=self.config.get('device', 'cuda'))
        ttk.Combobox(row2, textvariable=self.device_var, values=["cuda", "cpu"], width=8, state="readonly").pack(side=tk.LEFT, padx=(0, 10))

        ttk.Label(row2, text="Demucs模型:", width=10).pack(side=tk.LEFT)
        self.demucs_var = tk.StringVar(value=self.config.get('demucs_model', 'htdemucs'))
        ttk.Combobox(row2, textvariable=self.demucs_var, values=["htdemucs", "htdemucs_ft", "mdx"], width=12, state="readonly").pack(side=tk.LEFT, padx=(0, 10))

        ttk.Label(row2, text="Whisper模型:", width=10).pack(side=tk.LEFT)
        self.whisper_var = tk.StringVar(value=self.config.get('whisper_model', 'large-v2'))
        ttk.Combobox(row2, textvariable=self.whisper_var, values=["large-v2", "medium", "small", "base"], width=10, state="readonly").pack(side=tk.LEFT)

        # 第三行：批量大小 + 选项
        row3 = ttk.Frame(config_frame)
        row3.pack(fill=tk.X, pady=2)

        ttk.Label(row3, text="批量大小:", width=12).pack(side=tk.LEFT)
        self.batch_var = tk.StringVar(value=str(self.config.get('batch_size', 1)))
        ttk.Spinbox(row3, from_=1, to=4, textvariable=self.batch_var, width=5).pack(side=tk.LEFT, padx=(0, 20))

        self.auto_restart_var = tk.BooleanVar(value=self.config.get('auto_restart', True))
        ttk.Checkbutton(row3, text="崩溃自动重启", variable=self.auto_restart_var).pack(side=tk.LEFT, padx=(0, 20))

        self.hf_mirror_var = tk.BooleanVar(value=self.config.get('hf_mirror', True))
        ttk.Checkbutton(row3, text="使用国内镜像下载模型", variable=self.hf_mirror_var).pack(side=tk.LEFT)

        # 配置按钮
        btn_row = ttk.Frame(config_frame)
        btn_row.pack(fill=tk.X, pady=(8, 0))

        ttk.Button(btn_row, text="💾 保存配置", command=self.save_config).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(btn_row, text="🔗 测试连接", command=self.test_connection).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_row, text="🔄 检测环境", command=self.check_environment).pack(side=tk.LEFT, padx=5)

        # ===== 环境状态 =====
        env_frame = ttk.LabelFrame(main_frame, text="🖥️ 系统状态", padding="10")
        env_frame.pack(fill=tk.X, pady=(0, 10))

        self.env_text = tk.Text(env_frame, height=5, font=self.font_normal, bg="#1e1e1e", fg="#00ff00")
        self.env_text.pack(fill=tk.X)
        self.env_text.insert(tk.END, "正在检测环境...\n")
        self.env_text.config(state=tk.DISABLED)

        # ===== 操作按钮 =====
        action_frame = ttk.Frame(main_frame)
        action_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_btn = ttk.Button(action_frame, text="▶️ 启动Worker", command=self.start_worker)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.stop_btn = ttk.Button(action_frame, text="⏹️ 停止Worker", command=self.stop_worker, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT, padx=5)

        ttk.Button(action_frame, text="📦 一键安装环境", command=self.install_environment).pack(side=tk.LEFT, padx=5)
        ttk.Button(action_frame, text="⬇️ 下载AI模型", command=self.download_models).pack(side=tk.LEFT, padx=5)
        ttk.Button(action_frame, text="🧹 清空日志", command=self.clear_log).pack(side=tk.LEFT, padx=5)

        # ===== 任务统计 =====
        stats_frame = ttk.Frame(main_frame)
        stats_frame.pack(fill=tk.X, pady=(0, 5))

        self.stats_label = ttk.Label(stats_frame, text="待处理: - | 处理中: - | 已完成: - | 失败: -", font=self.font_normal)
        self.stats_label.pack(side=tk.LEFT)

        # ===== 日志区域 =====
        log_frame = ttk.LabelFrame(main_frame, text="📋 实时日志", padding="5")
        log_frame.pack(fill=tk.BOTH, expand=True)

        self.log_text = scrolledtext.ScrolledText(log_frame, font=("Consolas", 9), bg="#0d0d0d", fg="#ffffff")
        self.log_text.pack(fill=tk.BOTH, expand=True)
        self.log_text.tag_config("info", foreground="#87ceeb")
        self.log_text.tag_config("success", foreground="#00ff00")
        self.log_text.tag_config("error", foreground="#ff4444")
        self.log_text.tag_config("warning", foreground="#ffaa00")

        self.log(f"欢迎使用 {APP_TITLE} v{APP_VERSION}")
        self.log("点击「检测环境」查看系统状态，首次使用请先「一键安装环境」")

    def log(self, message, level="info"):
        """添加日志"""
        timestamp = time.strftime("%H:%M:%S")
        self.log_queue.put((timestamp, message, level))

    def update_log(self):
        """更新日志显示"""
        try:
            while not self.log_queue.empty():
                timestamp, message, level = self.log_queue.get_nowait()
                self.log_text.insert(tk.END, f"[{timestamp}] {message}\n", level)
                self.log_text.see(tk.END)
        except queue.Empty:
            pass
        self.root.after(100, self.update_log)

    def clear_log(self):
        """清空日志"""
        self.log_text.delete(1.0, tk.END)

    def check_environment(self):
        """检测环境"""
        def _check():
            self.env_text.config(state=tk.NORMAL)
            self.env_text.delete(1.0, tk.END)

            lines = []

            # Python版本
            lines.append(f"Python: {sys.version.split()[0]}")

            # PyTorch
            try:
                import torch
                lines.append(f"PyTorch: {torch.__version__}")
                cuda_available = torch.cuda.is_available()
                lines.append(f"CUDA可用: {'是 ✅' if cuda_available else '否 ❌'}")
                if cuda_available:
                    lines.append(f"显卡: {torch.cuda.get_device_name(0)}")
                    lines.append(f"显存: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB")
            except ImportError:
                lines.append("PyTorch: 未安装 ❌")

            # Demucs
            try:
                import demucs
                lines.append(f"Demucs: 已安装 ✅")
            except ImportError:
                lines.append("Demucs: 未安装 ❌")

            # WhisperX
            try:
                import whisperx
                lines.append(f"WhisperX: 已安装 ✅")
            except ImportError:
                lines.append("WhisperX: 未安装 ❌")

            # 虚拟环境
            in_venv = sys.prefix != sys.base_prefix
            lines.append(f"虚拟环境: {'是' if in_venv else '否（建议使用虚拟环境）'}")

            self.env_text.insert(tk.END, "\n".join(lines))
            self.env_text.config(state=tk.DISABLED)
            self.log("环境检测完成", "success")

        threading.Thread(target=_check, daemon=True).start()

    def test_connection(self):
        """测试服务器连接"""
        def _test():
            try:
                import urllib.request
                url = self.server_url_var.get().rstrip('/') + '/api/stats'
                self.log(f"测试连接: {url}")
                req = urllib.request.Request(url, method='GET')
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode('utf-8'))
                        self.log(f"连接成功！歌曲总数: {data.get('songCount', '未知')}", "success")
                        messagebox.showinfo("连接成功", f"服务器连接成功！\n歌曲总数: {data.get('songCount', '未知')}")
                    else:
                        self.log(f"连接失败: HTTP {resp.status}", "error")
            except Exception as e:
                self.log(f"连接失败: {e}", "error")
                messagebox.showerror("连接失败", f"无法连接到服务器:\n{e}\n\n请检查：\n1. 服务器地址是否正确\n2. 服务器是否在运行\n3. 是否在同一个局域网")

        threading.Thread(target=_test, daemon=True).start()

    def install_environment(self):
        """一键安装环境"""
        if self.installing:
            messagebox.showwarning("提示", "正在安装中，请稍候...")
            return

        self.installing = True
        self.log("开始一键安装环境...", "warning")

        def _install():
            try:
                script_dir = Path(__file__).parent
                venv_dir = script_dir / '.venv'

                # 1. 创建虚拟环境
                if not venv_dir.exists():
                    self.log("创建Python虚拟环境...")
                    subprocess.run([sys.executable, '-m', 'venv', str(venv_dir)], check=True)
                    self.log("虚拟环境创建成功", "success")
                else:
                    self.log("虚拟环境已存在，跳过创建")

                python_exe = venv_dir / 'Scripts' / 'python.exe' if sys.platform == 'win32' else venv_dir / 'bin' / 'python'

                # 2. 升级pip
                self.log("升级pip...")
                subprocess.run([str(python_exe), '-m', 'pip', 'install', '--upgrade', 'pip'], check=True)

                # 3. 安装PyTorch
                self.log("安装PyTorch (CUDA 12.4)...")
                subprocess.run([
                    str(python_exe), '-m', 'pip', 'install',
                    'torch==2.6.0', 'torchaudio==2.6.0',
                    '--index-url', 'https://download.pytorch.org/whl/cu124'
                ], check=True)
                self.log("PyTorch安装成功", "success")

                # 4. 安装其他依赖
                self.log("安装其他依赖 (Demucs, WhisperX)...")
                requirements = script_dir / 'requirements.txt'
                if requirements.exists():
                    subprocess.run([str(python_exe), '-m', 'pip', 'install', '-r', str(requirements)], check=True)
                else:
                    subprocess.run([
                        str(python_exe), '-m', 'pip', 'install',
                        'demucs', 'whisperx', 'requests', 'numpy', 'scipy'
                    ], check=True)
                self.log("依赖安装成功", "success")

                # 5. 修复cuDNN兼容
                self.log("修复cuDNN兼容性...")
                try:
                    torch_lib = venv_dir / 'Lib' / 'site-packages' / 'torch' / 'lib'
                    if torch_lib.exists():
                        import shutil
                        dll_pairs = [
                            ('cudnn_ops_infer64_9.dll', 'cudnn_ops_infer64_8.dll'),
                            ('cudnn_cnn_infer64_9.dll', 'cudnn_cnn_infer64_8.dll'),
                            ('cudnn_adv_infer64_9.dll', 'cudnn_adv_infer64_8.dll'),
                            ('cudnn_ops_train64_9.dll', 'cudnn_ops_train64_8.dll'),
                            ('cudnn_cnn_train64_9.dll', 'cudnn_cnn_train64_8.dll'),
                            ('cudnn_adv_train64_9.dll', 'cudnn_adv_train64_8.dll'),
                            ('cudnn64_9.dll', 'cudnn64_8.dll'),
                        ]
                        for src, dst in dll_pairs:
                            src_path = torch_lib / src
                            dst_path = torch_lib / dst
                            if src_path.exists() and not dst_path.exists():
                                shutil.copy2(src_path, dst_path)
                        self.log("cuDNN兼容性修复完成", "success")
                except Exception as e:
                    self.log(f"cuDNN修复跳过: {e}", "warning")

                self.log("=" * 50)
                self.log("环境安装全部完成！", "success")
                self.log("请点击「检测环境」确认安装结果", "success")
                self.log("然后点击「下载AI模型」下载模型文件", "success")
                messagebox.showinfo("安装完成", "环境安装全部完成！\n\n请：\n1. 点击「检测环境」确认\n2. 点击「下载AI模型」下载模型\n3. 点击「启动Worker」开始工作")

            except subprocess.CalledProcessError as e:
                self.log(f"安装失败: {e}", "error")
                messagebox.showerror("安装失败", f"安装过程中出错:\n{e}\n\n请查看日志了解详情")
            except Exception as e:
                self.log(f"安装出错: {e}", "error")
                messagebox.showerror("出错", f"安装过程中出错:\n{e}")
            finally:
                self.installing = False

        threading.Thread(target=_install, daemon=True).start()

    def download_models(self):
        """下载AI模型"""
        def _download():
            try:
                script_dir = Path(__file__).parent
                venv_dir = script_dir / '.venv'
                python_exe = venv_dir / 'Scripts' / 'python.exe' if sys.platform == 'win32' else venv_dir / 'bin' / 'python'

                if not python_exe.exists():
                    messagebox.showerror("错误", "请先「一键安装环境」")
                    return

                self.log("开始下载AI模型...", "warning")

                # 设置镜像
                env = os.environ.copy()
                if self.hf_mirror_var.get():
                    env['HF_ENDPOINT'] = 'https://hf-mirror.com'
                    self.log("使用国内镜像下载")

                # 下载Demucs模型
                self.log(f"下载Demucs模型: {self.demucs_var.get()}...")
                subprocess.run([
                    str(python_exe), '-c',
                    f"import demucs.separate; from demucs.pretrained import get_model; get_model('{self.demucs_var.get()}')"
                ], env=env, check=True)
                self.log("Demucs模型下载完成", "success")

                # 下载WhisperX模型
                self.log(f"下载WhisperX模型: {self.whisper_var.get()}...")
                subprocess.run([
                    str(python_exe), '-c',
                    f"import whisperx; whisperx.load_model('{self.whisper_var.get()}', device='cpu')"
                ], env=env, check=True)
                self.log("WhisperX模型下载完成", "success")

                self.log("所有模型下载完成！", "success")
                messagebox.showinfo("下载完成", "AI模型下载完成！\n\n可以点击「启动Worker」开始处理歌词了")

            except Exception as e:
                self.log(f"模型下载失败: {e}", "error")
                messagebox.showerror("下载失败", f"模型下载失败:\n{e}\n\n请检查网络连接，或开启「国内镜像」选项")

        threading.Thread(target=_download, daemon=True).start()

    def start_worker(self):
        """启动Worker"""
        if self.worker_running:
            return

        # 保存配置
        self.save_config()

        script_dir = Path(__file__).parent
        venv_dir = script_dir / '.venv'
        python_exe = venv_dir / 'Scripts' / 'python.exe' if sys.platform == 'win32' else venv_dir / 'bin' / 'python'

        if not python_exe.exists():
            messagebox.showerror("错误", "未找到虚拟环境，请先「一键安装环境」")
            return

        worker_script = script_dir / 'worker.py'
        if not worker_script.exists():
            messagebox.showerror("错误", f"未找到worker.py: {worker_script}")
            return

        self.log("启动Worker...", "warning")

        # 设置环境变量
        env = os.environ.copy()
        if self.hf_mirror_var.get():
            env['HF_ENDPOINT'] = 'https://hf-mirror.com'

        # 写入配置文件供worker读取
        worker_config = {
            'server_url': self.config['server_url'],
            'admin_password': self.config['admin_password'],
            'device': self.config['device'],
            'demucs_model': self.config['demucs_model'],
            'whisper_model': self.config['whisper_model'],
            'batch_size': self.config['batch_size'],
            'capability': 'gpu' if self.config.get('device') == 'cuda' else 'cpu'
        }
        with open(script_dir / 'worker_config.json', 'w', encoding='utf-8') as f:
            json.dump(worker_config, f, indent=2, ensure_ascii=False)

        try:
            self.worker_process = subprocess.Popen(
                [str(python_exe), str(worker_script)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                cwd=str(script_dir),
                bufsize=1,
                universal_newlines=True,
                encoding='utf-8',
                errors='replace'
            )
            self.worker_running = True
            self.start_btn.config(state=tk.DISABLED)
            self.stop_btn.config(state=tk.NORMAL)
            self.status_label.config(text="● 运行中", foreground="green")
            self.log("Worker已启动", "success")

            # 启动输出读取线程
            threading.Thread(target=self._read_worker_output, daemon=True).start()
            # 启动监控线程
            threading.Thread(target=self._monitor_worker, daemon=True).start()

        except Exception as e:
            self.log(f"启动失败: {e}", "error")
            messagebox.showerror("启动失败", f"Worker启动失败:\n{e}")

    def _read_worker_output(self):
        """读取Worker输出"""
        try:
            for line in self.worker_process.stdout:
                line = line.strip()
                if line:
                    level = "info"
                    if "错误" in line or "error" in line.lower() or "失败" in line:
                        level = "error"
                    elif "完成" in line or "成功" in line or "done" in line.lower():
                        level = "success"
                    elif "警告" in line or "warning" in line.lower():
                        level = "warning"
                    self.log(f"[Worker] {line}", level)
        except Exception as e:
            if self.worker_running:
                self.log(f"读取输出出错: {e}", "error")

    def _monitor_worker(self):
        """监控Worker状态，崩溃自动重启"""
        while self.worker_running:
            time.sleep(2)
            if self.worker_process and self.worker_process.poll() is not None:
                # Worker退出了
                exit_code = self.worker_process.returncode
                self.log(f"Worker已退出，退出码: {exit_code}", "error")

                if self.auto_restart_var.get() and self.worker_running:
                    self.log("5秒后自动重启Worker...", "warning")
                    time.sleep(5)
                    if self.worker_running:
                        self.log("自动重启Worker...", "warning")
                        self.root.after(0, self._restart_worker)
                break

    def _restart_worker(self):
        """重启Worker"""
        self.worker_running = False
        self.worker_process = None
        self.start_worker()

    def stop_worker(self):
        """停止Worker"""
        if not self.worker_running:
            return

        self.log("停止Worker...", "warning")
        self.worker_running = False

        try:
            if self.worker_process:
                self.worker_process.terminate()
                self.worker_process.wait(timeout=10)
        except Exception as e:
            self.log(f"停止时出错: {e}", "error")
            try:
                self.worker_process.kill()
            except:
                pass

        self.worker_process = None
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.status_label.config(text="● 已停止", foreground="gray")
        self.log("Worker已停止", "success")

    def on_closing(self):
        """关闭窗口"""
        if self.worker_running:
            if messagebox.askyesno("确认退出", "Worker正在运行，确定要退出吗？\n\n退出后Worker将停止处理任务。"):
                self.stop_worker()
                self.root.destroy()
        else:
            self.root.destroy()


def main():
    root = tk.Tk()

    # 设置主题
    style = ttk.Style()
    try:
        style.theme_use('clam')
    except:
        pass

    app = AIWorkstationGUI(root)
    root.protocol("WM_DELETE_WINDOW", app.on_closing)
    root.mainloop()


if __name__ == '__main__':
    main()
