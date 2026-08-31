# -*- coding: utf-8 -*-
"""
墨墨爱K歌 - PC端可视化工具箱
================================
集成了项目开发中使用的所有工具：
1. GitHub管理 - 提交代码、触发构建、下载产物
2. 文件工具 - 查找替换、批量重命名、编码转换
3. SSH远程 - 连接NAS/PC、执行命令、部署Docker
4. Docker管理 - 容器管理、镜像管理、查看日志
5. AI工作站 - 环境检测、一键安装、启动Worker
6. 构建工具 - 触发构建、轮询状态、下载产物
7. 命令学习 - 所有命令原理和代码示例

作者：墨墨爱K歌团队
版本：1.0.0
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox, filedialog, simpledialog
import json
import os
import sys
import subprocess
import threading
import time
import queue
import base64
import requests
from pathlib import Path
from datetime import datetime

# 确保中文输出正常
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        pass

APP_TITLE = "墨墨爱K歌 - PC工具箱"
APP_VERSION = "1.0.0"
CONFIG_FILE = "toolbox_config.json"

# 默认配置
DEFAULT_CONFIG = {
    "github": {
        "token": "",
        "repo": "klzbw/momo-ktv",
        "branch": "main"
    },
    "nas": {
        "host": "192.168.3.16",
        "port": 22,
        "username": "klzbw",
        "password": ""
    },
    "ai_worker": {
        "server_url": "http://192.168.3.16:8083",
        "device": "cuda"
    },
    "ui": {
        "theme": "clam",
        "font_size": 10
    }
}


class MomoToolbox:
    """墨墨爱K歌工具箱主类"""

    def __init__(self, root):
        self.root = root
        self.root.title(f"{APP_TITLE} v{APP_VERSION}")
        self.root.geometry("1100x750")
        self.root.minsize(900, 600)

        # 状态变量
        self.config = self.load_config()
        self.log_queue = queue.Queue()
        self.worker_running = False
        self.worker_process = None

        # 设置字体
        self.font_normal = ("Microsoft YaHei", self.config['ui']['font_size'])
        self.font_bold = ("Microsoft YaHei", self.config['ui']['font_size'], "bold")
        self.font_title = ("Microsoft YaHei", self.config['ui']['font_size'] + 2, "bold")
        self.font_mono = ("Consolas", self.config['ui']['font_size'])

        # 构建界面
        self.build_ui()

        # 启动日志更新
        self.update_log()

        self.log(f"欢迎使用 {APP_TITLE} v{APP_VERSION}")
        self.log("选择上方标签页开始使用各项功能")

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
                        elif isinstance(v, dict):
                            for k2, v2 in v.items():
                                if k2 not in cfg[k]:
                                    cfg[k][k2] = v2
                    return cfg
        except Exception as e:
            print(f"加载配置失败: {e}")
        return json.loads(json.dumps(DEFAULT_CONFIG))

    def save_config(self):
        """保存配置"""
        try:
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            self.log(f"保存配置失败: {e}", "error")
            return False

    def build_ui(self):
        """构建主界面"""
        # 主容器
        main_frame = ttk.Frame(self.root, padding="5")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # 顶部标题栏
        top_frame = ttk.Frame(main_frame)
        top_frame.pack(fill=tk.X, pady=(0, 5))

        ttk.Label(top_frame, text="🎤 墨墨爱K歌 - PC工具箱", font=self.font_title).pack(side=tk.LEFT)
        ttk.Label(top_frame, text=f"v{APP_VERSION}", foreground="gray").pack(side=tk.LEFT, padx=(10, 0))

        # 标签页
        self.notebook = ttk.Notebook(main_frame)
        self.notebook.pack(fill=tk.BOTH, expand=True)

        # 创建各个标签页
        self.build_github_tab()
        self.build_file_tab()
        self.build_ssh_tab()
        self.build_docker_tab()
        self.build_ai_tab()
        self.build_build_tab()
        self.build_learn_tab()

        # 底部日志区域
        log_frame = ttk.LabelFrame(main_frame, text="📋 操作日志", padding="5")
        log_frame.pack(fill=tk.BOTH, pady=(5, 0))

        self.log_text = scrolledtext.ScrolledText(log_frame, height=8, font=self.font_mono, bg="#1e1e1e", fg="#ffffff")
        self.log_text.pack(fill=tk.BOTH, expand=True)
        self.log_text.tag_config("info", foreground="#87ceeb")
        self.log_text.tag_config("success", foreground="#00ff00")
        self.log_text.tag_config("error", foreground="#ff4444")
        self.log_text.tag_config("warning", foreground="#ffaa00")
        self.log_text.tag_config("command", foreground="#ff88ff")

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

    # ============================================================
    # 1. GitHub管理模块
    # ============================================================
    def build_github_tab(self):
        """GitHub管理标签页"""
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🐙 GitHub管理")

        # 配置区域
        config_frame = ttk.LabelFrame(frame, text="配置", padding="10")
        config_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(config_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="Token:", width=10).pack(side=tk.LEFT)
        self.github_token_var = tk.StringVar(value=self.config['github']['token'])
        ttk.Entry(row1, textvariable=self.github_token_var, width=50, show="*").pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row1, text="保存", command=self.save_github_config).pack(side=tk.LEFT)

        row2 = ttk.Frame(config_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Label(row2, text="仓库:", width=10).pack(side=tk.LEFT)
        self.github_repo_var = tk.StringVar(value=self.config['github']['repo'])
        ttk.Entry(row2, textvariable=self.github_repo_var, width=30).pack(side=tk.LEFT, padx=(0, 20))
        ttk.Label(row2, text="分支:", width=6).pack(side=tk.LEFT)
        self.github_branch_var = tk.StringVar(value=self.config['github']['branch'])
        ttk.Entry(row2, textvariable=self.github_branch_var, width=15).pack(side=tk.LEFT)

        # 操作区域
        action_frame = ttk.LabelFrame(frame, text="操作", padding="10")
        action_frame.pack(fill=tk.X, pady=(0, 10))

        btn_row1 = ttk.Frame(action_frame)
        btn_row1.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row1, text="📋 获取最新Commit", command=self.github_get_latest).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="📦 查看构建状态", command=self.github_check_builds).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🚀 触发Docker构建", command=lambda: self.github_trigger_build("docker.yml")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🍎 触发tvOS构建", command=lambda: self.github_trigger_build("build-tvos.yml")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🤖 触发Android构建", command=lambda: self.github_trigger_build("build-android.yml")).pack(side=tk.LEFT, padx=2)

        btn_row2 = ttk.Frame(action_frame)
        btn_row2.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row2, text="⬇️ 下载最新tvOS IPA", command=lambda: self.github_download_artifact("tvOS")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row2, text="⬇️ 下载最新Android APK", command=lambda: self.github_download_artifact("Android")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row2, text="📂 打开下载目录", command=self.open_download_dir).pack(side=tk.LEFT, padx=2)

        # 结果显示区域
        result_frame = ttk.LabelFrame(frame, text="结果", padding="10")
        result_frame.pack(fill=tk.BOTH, expand=True)

        self.github_result = scrolledtext.ScrolledText(result_frame, font=self.font_mono, height=15)
        self.github_result.pack(fill=tk.BOTH, expand=True)

    def save_github_config(self):
        """保存GitHub配置"""
        self.config['github']['token'] = self.github_token_var.get()
        self.config['github']['repo'] = self.github_repo_var.get()
        self.config['github']['branch'] = self.github_branch_var.get()
        if self.save_config():
            self.log("GitHub配置已保存", "success")
            messagebox.showinfo("成功", "GitHub配置已保存！")

    def github_headers(self):
        """获取GitHub请求头"""
        return {
            'Authorization': f'token {self.github_token_var.get()}',
            'Accept': 'application/vnd.github+json'
        }

    def github_base_url(self):
        """获取GitHub API基础URL"""
        return f"https://api.github.com/repos/{self.github_repo_var.get()}"

    def github_get_latest(self):
        """获取最新commit"""
        def _do():
            try:
                r = requests.get(f'{self.github_base_url()}/git/ref/heads/{self.github_branch_var.get()}',
                                 headers=self.github_headers(), timeout=10)
                if r.status_code == 200:
                    data = r.json()
                    sha = data['object']['sha']
                    # 获取commit详情
                    r2 = requests.get(f'{self.github_base_url()}/git/commits/{sha}',
                                      headers=self.github_headers(), timeout=10)
                    if r2.status_code == 200:
                        commit = r2.json()
                        msg = commit['message'].split('\n')[0]
                        date = commit['committer']['date']
                        result = f"""最新Commit信息：
====================
SHA:      {sha[:7]}
完整SHA:  {sha}
信息:     {msg}
作者:     {commit['author']['name']}
日期:     {date}
分支:     {self.github_branch_var.get()}
"""
                        self.github_result.delete(1.0, tk.END)
                        self.github_result.insert(tk.END, result)
                        self.log(f"最新commit: {sha[:7]} - {msg}", "success")
                else:
                    self.log(f"获取失败: HTTP {r.status_code}", "error")
            except Exception as e:
                self.log(f"获取失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_check_builds(self):
        """查看构建状态"""
        def _do():
            try:
                r = requests.get(f'{self.github_base_url()}/actions/runs',
                                 headers=self.github_headers(), params={'per_page': 10}, timeout=10)
                if r.status_code == 200:
                    runs = r.json().get('workflow_runs', [])
                    result = "最近构建状态：\n" + "=" * 60 + "\n"
                    for run in runs[:10]:
                        status = run['status']
                        conclusion = run.get('conclusion', '-')
                        name = run['name']
                        sha = run.get('head_sha', '')[:7]
                        created = run['created_at']
                        status_icon = "✅" if conclusion == "success" else "❌" if conclusion == "failure" else "⏳" if status == "in_progress" else "⚪"
                        result += f"{status_icon} {name[:30]:30s} | {status:12s} | {conclusion or '-':8s} | {sha} | {created[:10]}\n"
                    self.github_result.delete(1.0, tk.END)
                    self.github_result.insert(tk.END, result)
                    self.log("构建状态已更新", "success")
                else:
                    self.log(f"获取失败: HTTP {r.status_code}", "error")
            except Exception as e:
                self.log(f"获取失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_trigger_build(self, workflow_file):
        """触发构建"""
        def _do():
            try:
                r = requests.post(f'{self.github_base_url()}/actions/workflows/{workflow_file}/dispatches',
                                  headers=self.github_headers(),
                                  json={'ref': self.github_branch_var.get()}, timeout=10)
                if r.status_code == 204:
                    self.log(f"已触发构建: {workflow_file}", "success")
                    messagebox.showinfo("成功", f"已触发构建: {workflow_file}\n\n构建通常需要5-15分钟，请点击「查看构建状态」查看进度。")
                else:
                    self.log(f"触发失败: HTTP {r.status_code} - {r.text[:200]}", "error")
            except Exception as e:
                self.log(f"触发失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_download_artifact(self, artifact_type):
        """下载构建产物"""
        def _do():
            try:
                # 获取最近成功的构建
                r = requests.get(f'{self.github_base_url()}/actions/runs',
                                 headers=self.github_headers(),
                                 params={'per_page': 20, 'status': 'completed'}, timeout=10)
                if r.status_code != 200:
                    self.log(f"获取构建列表失败", "error")
                    return

                runs = r.json().get('workflow_runs', [])
                target_run = None
                for run in runs:
                    if artifact_type.lower() in run['name'].lower() and run.get('conclusion') == 'success':
                        target_run = run
                        break

                if not target_run:
                    self.log(f"未找到成功的{artifact_type}构建", "warning")
                    messagebox.showwarning("未找到", f"未找到最近成功的{artifact_type}构建\n请先触发构建并等待完成。")
                    return

                self.log(f"找到构建: {target_run['name']} - {target_run['head_sha'][:7]}")

                # 获取artifact
                r2 = requests.get(f'{self.github_base_url()}/actions/runs/{target_run["id"]}/artifacts',
                                  headers=self.github_headers(), timeout=10)
                artifacts = r2.json().get('artifacts', [])

                if not artifacts:
                    self.log("未找到构建产物", "warning")
                    return

                # 下载第一个artifact
                artifact = artifacts[0]
                self.log(f"下载产物: {artifact['name']} ({artifact['size_in_bytes']} bytes)")

                r3 = requests.get(artifact['archive_download_url'], headers=self.github_headers(), timeout=120)
                if r3.status_code == 200:
                    import zipfile, io
                    z = zipfile.ZipFile(io.BytesIO(r3.content))
                    download_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
                    os.makedirs(download_dir, exist_ok=True)

                    saved_files = []
                    for name in z.namelist():
                        if name.endswith(('.ipa', '.apk')):
                            out_path = os.path.join(download_dir, os.path.basename(name))
                            with open(out_path, 'wb') as f:
                                f.write(z.read(name))
                            saved_files.append(out_path)
                            self.log(f"已保存: {out_path} ({os.path.getsize(out_path)} bytes)", "success")

                    if saved_files:
                        messagebox.showinfo("下载完成", f"已下载到:\n{saved_files[0]}\n\n点击「打开下载目录」查看文件。")
                    else:
                        self.log("ZIP中未找到IPA/APK文件", "warning")
                else:
                    self.log(f"下载失败: HTTP {r3.status_code}", "error")
            except Exception as e:
                self.log(f"下载失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def open_download_dir(self):
        """打开下载目录"""
        download_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
        os.makedirs(download_dir, exist_ok=True)
        if sys.platform == 'win32':
            os.startfile(download_dir)
        elif sys.platform == 'darwin':
            subprocess.run(['open', download_dir])
        else:
            subprocess.run(['xdg-open', download_dir])

    # ============================================================
    # 2. 文件工具模块
    # ============================================================
    def build_file_tab(self):
        """文件工具标签页"""
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="📁 文件工具")

        # 查找替换
        find_frame = ttk.LabelFrame(frame, text="🔍 查找替换", padding="10")
        find_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(find_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="目录:", width=8).pack(side=tk.LEFT)
        self.file_dir_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.file_dir_var, width=50).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row1, text="浏览", command=self.browse_dir).pack(side=tk.LEFT)

        row2 = ttk.Frame(find_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Label(row2, text="查找:", width=8).pack(side=tk.LEFT)
        self.file_find_var = tk.StringVar()
        ttk.Entry(row2, textvariable=self.file_find_var, width=30).pack(side=tk.LEFT, padx=(0, 20))
        ttk.Label(row2, text="替换为:", width=8).pack(side=tk.LEFT)
        self.file_replace_var = tk.StringVar()
        ttk.Entry(row2, textvariable=self.file_replace_var, width=30).pack(side=tk.LEFT)

        row3 = ttk.Frame(find_frame)
        row3.pack(fill=tk.X, pady=2)
        ttk.Label(row3, text="文件类型:", width=8).pack(side=tk.LEFT)
        self.file_ext_var = tk.StringVar(value=".swift,.js,.html,.css,.py,.kt,.xml,.yml,.md")
        ttk.Entry(row3, textvariable=self.file_ext_var, width=50).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row3, text="🔍 查找", command=self.file_find).pack(side=tk.LEFT, padx=2)
        ttk.Button(row3, text="🔄 替换", command=self.file_replace).pack(side=tk.LEFT, padx=2)

        # 批量重命名
        rename_frame = ttk.LabelFrame(frame, text="📝 批量重命名", padding="10")
        rename_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(rename_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="目录:", width=8).pack(side=tk.LEFT)
        self.rename_dir_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.rename_dir_var, width=50).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row1, text="浏览", command=lambda: self.browse_dir(self.rename_dir_var)).pack(side=tk.LEFT)

        row2 = ttk.Frame(rename_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Label(row2, text="查找:", width=8).pack(side=tk.LEFT)
        self.rename_find_var = tk.StringVar()
        ttk.Entry(row2, textvariable=self.rename_find_var, width=20).pack(side=tk.LEFT, padx=(0, 20))
        ttk.Label(row2, text="替换为:", width=8).pack(side=tk.LEFT)
        self.rename_replace_var = tk.StringVar()
        ttk.Entry(row2, textvariable=self.rename_replace_var, width=20).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Button(row2, text="预览", command=self.rename_preview).pack(side=tk.LEFT, padx=2)
        ttk.Button(row2, text="执行", command=self.rename_execute).pack(side=tk.LEFT, padx=2)

        # 结果显示
        result_frame = ttk.LabelFrame(frame, text="结果", padding="10")
        result_frame.pack(fill=tk.BOTH, expand=True)

        self.file_result = scrolledtext.ScrolledText(result_frame, font=self.font_mono, height=12)
        self.file_result.pack(fill=tk.BOTH, expand=True)

    def browse_dir(self, var=None):
        """浏览目录"""
        if var is None:
            var = self.file_dir_var
        dir_path = filedialog.askdirectory()
        if dir_path:
            var.set(dir_path)

    def file_find(self):
        """查找文件内容"""
        def _do():
            directory = self.file_dir_var.get()
            find_text = self.file_find_var.get()
            exts = [e.strip() for e in self.file_ext_var.get().split(',') if e.strip()]

            if not directory or not find_text:
                messagebox.showwarning("提示", "请填写目录和查找内容")
                return

            self.log(f"在 {directory} 中查找 '{find_text}'")
            count = 0
            results = []

            for root, dirs, files in os.walk(directory):
                for f in files:
                    if any(f.endswith(ext) for ext in exts):
                        filepath = os.path.join(root, f)
                        try:
                            with open(filepath, 'r', encoding='utf-8', errors='ignore') as fh:
                                for i, line in enumerate(fh, 1):
                                    if find_text in line:
                                        count += 1
                                        rel_path = os.path.relpath(filepath, directory)
                                        results.append(f"{rel_path}:{i}: {line.strip()[:100]}")
                        except:
                            pass

            result_text = f"找到 {count} 处匹配\n" + "=" * 60 + "\n" + "\n".join(results[:500])
            if len(results) > 500:
                result_text += f"\n... 还有 {len(results) - 500} 条结果未显示"

            self.file_result.delete(1.0, tk.END)
            self.file_result.insert(tk.END, result_text)
            self.log(f"查找完成，找到 {count} 处匹配", "success")
        threading.Thread(target=_do, daemon=True).start()

    def file_replace(self):
        """替换文件内容"""
        if not messagebox.askyesno("确认", "确定要执行替换吗？\n此操作不可撤销，建议先备份！"):
            return

        def _do():
            directory = self.file_dir_var.get()
            find_text = self.file_find_var.get()
            replace_text = self.file_replace_var.get()
            exts = [e.strip() for e in self.file_ext_var.get().split(',') if e.strip()]

            if not directory or not find_text:
                return

            self.log(f"在 {directory} 中替换 '{find_text}' -> '{replace_text}'")
            count = 0
            file_count = 0

            for root, dirs, files in os.walk(directory):
                for f in files:
                    if any(f.endswith(ext) for ext in exts):
                        filepath = os.path.join(root, f)
                        try:
                            with open(filepath, 'r', encoding='utf-8', errors='ignore') as fh:
                                content = fh.read()
                            if find_text in content:
                                new_content = content.replace(find_text, replace_text)
                                with open(filepath, 'w', encoding='utf-8') as fh:
                                    fh.write(new_content)
                                count += content.count(find_text)
                                file_count += 1
                                self.log(f"已替换: {os.path.relpath(filepath, directory)}")
                        except Exception as e:
                            self.log(f"替换失败 {filepath}: {e}", "error")

            self.file_result.delete(1.0, tk.END)
            self.file_result.insert(tk.END, f"替换完成！\n修改文件数: {file_count}\n替换次数: {count}")
            self.log(f"替换完成，修改 {file_count} 个文件，替换 {count} 处", "success")
        threading.Thread(target=_do, daemon=True).start()

    def rename_preview(self):
        """重命名预览"""
        directory = self.rename_dir_var.get()
        find_text = self.rename_find_var.get()
        replace_text = self.rename_replace_var.get()

        if not directory or not find_text:
            messagebox.showwarning("提示", "请填写目录和查找内容")
            return

        results = []
        for f in os.listdir(directory):
            if find_text in f:
                new_name = f.replace(find_text, replace_text)
                results.append(f"{f}  ->  {new_name}")

        self.file_result.delete(1.0, tk.END)
        self.file_result.insert(tk.END, f"预览（共 {len(results)} 个文件）：\n" + "=" * 60 + "\n" + "\n".join(results))

    def rename_execute(self):
        """执行重命名"""
        if not messagebox.askyesno("确认", "确定要执行重命名吗？"):
            return

        directory = self.rename_dir_var.get()
        find_text = self.rename_find_var.get()
        replace_text = self.rename_replace_var.get()

        count = 0
        for f in os.listdir(directory):
            if find_text in f:
                old_path = os.path.join(directory, f)
                new_path = os.path.join(directory, f.replace(find_text, replace_text))
                os.rename(old_path, new_path)
                count += 1
                self.log(f"重命名: {f} -> {f.replace(find_text, replace_text)}")

        self.log(f"重命名完成，共 {count} 个文件", "success")
        messagebox.showinfo("完成", f"已重命名 {count} 个文件")

    # ============================================================
    # 3. SSH远程模块
    # ============================================================
    def build_ssh_tab(self):
        """SSH远程标签页"""
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🔗 SSH远程")

        # 配置区域
        config_frame = ttk.LabelFrame(frame, text="连接配置", padding="10")
        config_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(config_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="主机:", width=8).pack(side=tk.LEFT)
        self.ssh_host_var = tk.StringVar(value=self.config['nas']['host'])
        ttk.Entry(row1, textvariable=self.ssh_host_var, width=20).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Label(row1, text="端口:", width=6).pack(side=tk.LEFT)
        self.ssh_port_var = tk.StringVar(value=str(self.config['nas']['port']))
        ttk.Entry(row1, textvariable=self.ssh_port_var, width=8).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Label(row1, text="用户:", width=6).pack(side=tk.LEFT)
        self.ssh_user_var = tk.StringVar(value=self.config['nas']['username'])
        ttk.Entry(row1, textvariable=self.ssh_user_var, width=15).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Label(row1, text="密码:", width=6).pack(side=tk.LEFT)
        self.ssh_pass_var = tk.StringVar(value=self.config['nas']['password'])
        ttk.Entry(row1, textvariable=self.ssh_pass_var, width=15, show="*").pack(side=tk.LEFT)

        row2 = ttk.Frame(config_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Button(row2, text="💾 保存配置", command=self.save_ssh_config).pack(side=tk.LEFT, padx=2)
        ttk.Button(row2, text="🔍 测试连接", command=self.ssh_test).pack(side=tk.LEFT, padx=2)

        # 快捷命令
        quick_frame = ttk.LabelFrame(frame, text="⚡ 快捷命令", padding="10")
        quick_frame.pack(fill=tk.X, pady=(0, 10))

        btn_row1 = ttk.Frame(quick_frame)
        btn_row1.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row1, text="📋 查看容器状态", command=lambda: self.ssh_exec("docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="📜 查看momo-ktv日志", command=lambda: self.ssh_exec("docker logs momo-ktv --tail 50")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🔄 重启momo-ktv", command=lambda: self.ssh_exec("docker restart momo-ktv")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="⬆️ 更新镜像并重启", command=self.ssh_docker_update).pack(side=tk.LEFT, padx=2)

        btn_row2 = ttk.Frame(quick_frame)
        btn_row2.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row2, text="💾 磁盘空间", command=lambda: self.ssh_exec("df -h")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row2, text="📊 系统资源", command=lambda: self.ssh_exec("free -h && uptime")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row2, text="📁 曲库文件数", command=lambda: self.ssh_exec("find /vol1/@appshare/momo-ktv/mv -type f | wc -l")).pack(side=tk.LEFT, padx=2)

        # 自定义命令
        custom_frame = ttk.LabelFrame(frame, text="⌨️ 自定义命令", padding="10")
        custom_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(custom_frame)
        row1.pack(fill=tk.X, pady=2)
        self.ssh_cmd_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.ssh_cmd_var, width=80).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row1, text="执行", command=lambda: self.ssh_exec(self.ssh_cmd_var.get())).pack(side=tk.LEFT)

        # 输出区域
        output_frame = ttk.LabelFrame(frame, text="📤 输出", padding="10")
        output_frame.pack(fill=tk.BOTH, expand=True)

        self.ssh_output = scrolledtext.ScrolledText(output_frame, font=self.font_mono, height=12, bg="#0d0d0d", fg="#00ff00")
        self.ssh_output.pack(fill=tk.BOTH, expand=True)

    def save_ssh_config(self):
        """保存SSH配置"""
        self.config['nas']['host'] = self.ssh_host_var.get()
        self.config['nas']['port'] = int(self.ssh_port_var.get())
        self.config['nas']['username'] = self.ssh_user_var.get()
        self.config['nas']['password'] = self.ssh_pass_var.get()
        if self.save_config():
            self.log("SSH配置已保存", "success")

    def ssh_get_client(self):
        """获取SSH客户端"""
        try:
            import paramiko
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                hostname=self.ssh_host_var.get(),
                port=int(self.ssh_port_var.get()),
                username=self.ssh_user_var.get(),
                password=self.ssh_pass_var.get(),
                timeout=10
            )
            return client
        except ImportError:
            messagebox.showerror("错误", "未安装paramiko库\n请运行: pip install paramiko")
            return None
        except Exception as e:
            self.log(f"SSH连接失败: {e}", "error")
            messagebox.showerror("连接失败", str(e))
            return None

    def ssh_test(self):
        """测试SSH连接"""
        def _do():
            client = self.ssh_get_client()
            if client:
                stdin, stdout, stderr = client.exec_command("echo '连接成功！' && hostname && uname -a")
                output = stdout.read().decode('utf-8', errors='replace')
                self.ssh_output.delete(1.0, tk.END)
                self.ssh_output.insert(tk.END, output)
                self.log("SSH连接测试成功", "success")
                client.close()
        threading.Thread(target=_do, daemon=True).start()

    def ssh_exec(self, command):
        """执行SSH命令"""
        def _do():
            client = self.ssh_get_client()
            if not client:
                return

            self.log(f"执行: {command}", "command")
            try:
                # 用sudo执行需要密码的命令
                if command.startswith('docker') or command.startswith('find /vol'):
                    full_cmd = f'echo "{self.ssh_pass_var.get()}" | sudo -S {command} 2>&1'
                else:
                    full_cmd = f'{command} 2>&1'

                stdin, stdout, stderr = client.exec_command(full_cmd, timeout=60)
                output = stdout.read().decode('utf-8', errors='replace')
                self.ssh_output.delete(1.0, tk.END)
                self.ssh_output.insert(tk.END, output)
                self.log("命令执行完成", "success")
            except Exception as e:
                self.log(f"执行失败: {e}", "error")
                self.ssh_output.delete(1.0, tk.END)
                self.ssh_output.insert(tk.END, f"错误: {e}")
            finally:
                client.close()
        threading.Thread(target=_do, daemon=True).start()

    def ssh_docker_update(self):
        """更新Docker镜像并重启"""
        def _do():
            client = self.ssh_get_client()
            if not client:
                return

            self.log("开始更新Docker镜像...", "command")
            commands = [
                "cd /vol1/@appshare/momo-ktv && echo '密码' | sudo -S docker compose pull",
                "cd /vol1/@appshare/momo-ktv && echo '密码' | sudo -S docker compose up -d",
                "echo '密码' | sudo -S docker ps --filter name=momo --format 'table {{.Names}}\\t{{.Status}}'"
            ]

            output_all = ""
            for cmd in commands:
                cmd = cmd.replace("echo '密码'", f'echo "{self.ssh_pass_var.get()}"')
                self.log(f"执行: {cmd[:60]}...", "command")
                stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
                output = stdout.read().decode('utf-8', errors='replace')
                output_all += output + "\n"

            self.ssh_output.delete(1.0, tk.END)
            self.ssh_output.insert(tk.END, output_all)
            self.log("Docker更新完成", "success")
            client.close()
        threading.Thread(target=_do, daemon=True).start()

    # ============================================================
    # 4. Docker管理模块
    # ============================================================
    def build_docker_tab(self):
        """Docker管理标签页"""
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🐳 Docker管理")

        # 本地Docker操作
        local_frame = ttk.LabelFrame(frame, text="🖥️ 本地Docker", padding="10")
        local_frame.pack(fill=tk.X, pady=(0, 10))

        btn_row1 = ttk.Frame(local_frame)
        btn_row1.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row1, text="📋 容器列表", command=lambda: self.docker_local("docker ps -a")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🖼️ 镜像列表", command=lambda: self.docker_local("docker images")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="📊 系统资源", command=lambda: self.docker_local("docker system df")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🧹 清理无用镜像", command=lambda: self.docker_local("docker image prune -f")).pack(side=tk.LEFT, padx=2)

        # 远程Docker（通过SSH）
        remote_frame = ttk.LabelFrame(frame, text="🔗 远程Docker（NAS）", padding="10")
        remote_frame.pack(fill=tk.X, pady=(0, 10))

        btn_row1 = ttk.Frame(remote_frame)
        btn_row1.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row1, text="📋 容器列表", command=lambda: self.ssh_exec("docker ps -a --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="📜 momo-ktv日志", command=lambda: self.ssh_exec("docker logs momo-ktv --tail 100")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🔄 重启momo-ktv", command=lambda: self.ssh_exec("docker restart momo-ktv")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="⏹️ 停止momo-ktv", command=lambda: self.ssh_exec("docker stop momo-ktv")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="▶️ 启动momo-ktv", command=lambda: self.ssh_exec("docker start momo-ktv")).pack(side=tk.LEFT, padx=2)

        btn_row2 = ttk.Frame(remote_frame)
        btn_row2.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row2, text="⬇️ 拉取最新镜像", command=lambda: self.ssh_exec("docker pull ghcr.io/klzbw/momo-ktv:latest")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row2, text="🔄 更新并重启", command=self.ssh_docker_update).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row2, text="🗑️ 删除旧容器", command=lambda: self.ssh_exec("docker rm -f momo-ktv")).pack(side=tk.LEFT, padx=2)

        # 自定义命令
        custom_frame = ttk.LabelFrame(frame, text="⌨️ Docker命令", padding="10")
        custom_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(custom_frame)
        row1.pack(fill=tk.X, pady=2)
        self.docker_cmd_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.docker_cmd_var, width=80).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row1, text="本地执行", command=lambda: self.docker_local(self.docker_cmd_var.get())).pack(side=tk.LEFT, padx=2)
        ttk.Button(row1, text="远程执行", command=lambda: self.ssh_exec(self.docker_cmd_var.get())).pack(side=tk.LEFT, padx=2)

        # 输出区域
        output_frame = ttk.LabelFrame(frame, text="📤 输出", padding="10")
        output_frame.pack(fill=tk.BOTH, expand=True)

        self.docker_output = scrolledtext.ScrolledText(output_frame, font=self.font_mono, height=15, bg="#0d0d0d", fg="#00ffff")
        self.docker_output.pack(fill=tk.BOTH, expand=True)

    def docker_local(self, command):
        """执行本地Docker命令"""
        def _do():
            self.log(f"本地执行: {command}", "command")
            try:
                result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60, encoding='utf-8', errors='replace')
                output = result.stdout + result.stderr
                self.docker_output.delete(1.0, tk.END)
                self.docker_output.insert(tk.END, output)
                self.log("命令执行完成", "success")
            except Exception as e:
                self.log(f"执行失败: {e}", "error")
                self.docker_output.delete(1.0, tk.END)
                self.docker_output.insert(tk.END, f"错误: {e}")
        threading.Thread(target=_do, daemon=True).start()

    # ============================================================
    # 5. AI工作站模块
    # ============================================================
    def build_ai_tab(self):
        """AI工作站标签页"""
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🤖 AI工作站")

        # 配置区域
        config_frame = ttk.LabelFrame(frame, text="配置", padding="10")
        config_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(config_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="服务器:", width=10).pack(side=tk.LEFT)
        self.ai_server_var = tk.StringVar(value=self.config['ai_worker']['server_url'])
        ttk.Entry(row1, textvariable=self.ai_server_var, width=30).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Label(row1, text="设备:", width=6).pack(side=tk.LEFT)
        self.ai_device_var = tk.StringVar(value=self.config['ai_worker']['device'])
        ttk.Combobox(row1, textvariable=self.ai_device_var, values=["cuda", "cpu"], width=8, state="readonly").pack(side=tk.LEFT)

        row2 = ttk.Frame(config_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Label(row2, text="Worker目录:", width=10).pack(side=tk.LEFT)
        self.ai_dir_var = tk.StringVar(value=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "ai-worker"))
        ttk.Entry(row2, textvariable=self.ai_dir_var, width=50).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row2, text="浏览", command=lambda: self.browse_dir(self.ai_dir_var)).pack(side=tk.LEFT)

        # 操作区域
        action_frame = ttk.LabelFrame(frame, text="操作", padding="10")
        action_frame.pack(fill=tk.X, pady=(0, 10))

        btn_row1 = ttk.Frame(action_frame)
        btn_row1.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row1, text="🔍 环境检测", command=self.ai_check_env).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="📦 一键安装环境", command=self.ai_install).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="⬇️ 下载AI模型", command=self.ai_download_models).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="▶️ 启动Worker", command=self.ai_start_worker).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="⏹️ 停止Worker", command=self.ai_stop_worker, state=tk.DISABLED).pack(side=tk.LEFT, padx=2)

        # 状态显示
        status_frame = ttk.LabelFrame(frame, text="🖥️ 系统状态", padding="10")
        status_frame.pack(fill=tk.X, pady=(0, 10))

        self.ai_status = tk.Text(status_frame, height=6, font=self.font_mono, bg="#1e1e1e", fg="#00ff00")
        self.ai_status.pack(fill=tk.X)
        self.ai_status.insert(tk.END, "点击「环境检测」查看系统状态...\n")
        self.ai_status.config(state=tk.DISABLED)

        # 日志区域
        log_frame = ttk.LabelFrame(frame, text="📋 Worker日志", padding="10")
        log_frame.pack(fill=tk.BOTH, expand=True)

        self.ai_log = scrolledtext.ScrolledText(log_frame, font=self.font_mono, height=10, bg="#0d0d0d", fg="#ffffff")
        self.ai_log.pack(fill=tk.BOTH, expand=True)

    def ai_check_env(self):
        """检测AI环境"""
        def _do():
            self.ai_status.config(state=tk.NORMAL)
            self.ai_status.delete(1.0, tk.END)

            lines = []
            lines.append(f"Python: {sys.version.split()[0]}")

            # 虚拟环境
            in_venv = sys.prefix != sys.base_prefix
            lines.append(f"虚拟环境: {'是' if in_venv else '否'}")

            # PyTorch
            try:
                import torch
                lines.append(f"PyTorch: {torch.__version__}")
                cuda_ok = torch.cuda.is_available()
                lines.append(f"CUDA可用: {'是 ✅' if cuda_ok else '否 ❌'}")
                if cuda_ok:
                    lines.append(f"显卡: {torch.cuda.get_device_name(0)}")
                    lines.append(f"显存: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB")
            except ImportError:
                lines.append("PyTorch: 未安装 ❌")

            # Demucs
            try:
                import demucs
                lines.append("Demucs: 已安装 ✅")
            except ImportError:
                lines.append("Demucs: 未安装 ❌")

            # WhisperX
            try:
                import whisperx
                lines.append("WhisperX: 已安装 ✅")
            except ImportError:
                lines.append("WhisperX: 未安装 ❌")

            self.ai_status.insert(tk.END, "\n".join(lines))
            self.ai_status.config(state=tk.DISABLED)
            self.log("环境检测完成", "success")
        threading.Thread(target=_do, daemon=True).start()

    def ai_install(self):
        """一键安装环境"""
        if not messagebox.askyesno("确认", "开始一键安装环境？\n\n这将：\n1. 创建Python虚拟环境\n2. 安装PyTorch + CUDA\n3. 安装Demucs + WhisperX\n4. 修复cuDNN兼容性\n\n预计需要10-20分钟，取决于网络速度。"):
            return

        def _do():
            ai_dir = self.ai_dir_var.get()
            venv_dir = os.path.join(ai_dir, '.venv')
            self.log("开始安装AI环境...", "warning")

            try:
                # 创建虚拟环境
                if not os.path.exists(venv_dir):
                    self.log("创建Python虚拟环境...")
                    subprocess.run([sys.executable, '-m', 'venv', venv_dir], check=True)
                    self.log("虚拟环境创建成功", "success")

                python_exe = os.path.join(venv_dir, 'Scripts', 'python.exe') if sys.platform == 'win32' else os.path.join(venv_dir, 'bin', 'python')

                # 升级pip
                self.log("升级pip...")
                subprocess.run([python_exe, '-m', 'pip', 'install', '--upgrade', 'pip'], check=True)

                # 安装PyTorch
                self.log("安装PyTorch (CUDA 12.4)...")
                subprocess.run([python_exe, '-m', 'pip', 'install', 'torch==2.6.0', 'torchaudio==2.6.0',
                                '--index-url', 'https://download.pytorch.org/whl/cu124'], check=True)
                self.log("PyTorch安装成功", "success")

                # 安装其他依赖
                self.log("安装Demucs + WhisperX...")
                requirements = os.path.join(ai_dir, 'requirements.txt')
                if os.path.exists(requirements):
                    subprocess.run([python_exe, '-m', 'pip', 'install', '-r', requirements], check=True)
                else:
                    subprocess.run([python_exe, '-m', 'pip', 'install', 'demucs', 'whisperx', 'requests'], check=True)
                self.log("依赖安装成功", "success")

                self.log("=" * 50)
                self.log("环境安装全部完成！", "success")
                self.log("请点击「环境检测」确认安装结果", "success")
                messagebox.showinfo("安装完成", "AI环境安装完成！\n\n请：\n1. 点击「环境检测」确认\n2. 点击「下载AI模型」下载模型\n3. 点击「启动Worker」开始工作")

            except Exception as e:
                self.log(f"安装失败: {e}", "error")
                messagebox.showerror("安装失败", str(e))

        threading.Thread(target=_do, daemon=True).start()

    def ai_download_models(self):
        """下载AI模型"""
        def _do():
            ai_dir = self.ai_dir_var.get()
            venv_dir = os.path.join(ai_dir, '.venv')
            python_exe = os.path.join(venv_dir, 'Scripts', 'python.exe') if sys.platform == 'win32' else os.path.join(venv_dir, 'bin', 'python')

            if not os.path.exists(python_exe):
                messagebox.showerror("错误", "请先「一键安装环境」")
                return

            self.log("开始下载AI模型...", "warning")
            env = os.environ.copy()
            env['HF_ENDPOINT'] = 'https://hf-mirror.com'

            try:
                # 下载Demucs模型
                self.log("下载Demucs模型...")
                subprocess.run([python_exe, '-c',
                                "from demucs.pretrained import get_model; get_model('htdemucs')"],
                               env=env, check=True)
                self.log("Demucs模型下载完成", "success")

                # 下载WhisperX模型
                self.log("下载WhisperX模型 (large-v2)...")
                subprocess.run([python_exe, '-c',
                                "import whisperx; whisperx.load_model('large-v2', device='cpu')"],
                               env=env, check=True)
                self.log("WhisperX模型下载完成", "success")

                self.log("所有模型下载完成！", "success")
                messagebox.showinfo("下载完成", "AI模型下载完成！\n\n可以点击「启动Worker」开始处理歌词了")

            except Exception as e:
                self.log(f"模型下载失败: {e}", "error")
                messagebox.showerror("下载失败", str(e))

        threading.Thread(target=_do, daemon=True).start()

    def ai_start_worker(self):
        """启动Worker"""
        ai_dir = self.ai_dir_var.get()
        venv_dir = os.path.join(ai_dir, '.venv')
        python_exe = os.path.join(venv_dir, 'Scripts', 'python.exe') if sys.platform == 'win32' else os.path.join(venv_dir, 'bin', 'python')
        worker_script = os.path.join(ai_dir, 'worker.py')

        if not os.path.exists(python_exe):
            messagebox.showerror("错误", "请先「一键安装环境」")
            return
        if not os.path.exists(worker_script):
            messagebox.showerror("错误", f"未找到worker.py: {worker_script}")
            return

        # 写入配置文件
        config = {
            'server_url': self.ai_server_var.get(),
            'device': self.ai_device_var.get(),
            'demucs_model': 'htdemucs',
            'whisper_model': 'large-v2',
            'batch_size': 1
        }
        with open(os.path.join(ai_dir, 'worker_config.json'), 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

        self.log("启动Worker...", "warning")
        try:
            self.worker_process = subprocess.Popen(
                [python_exe, worker_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=os.environ.copy(),
                cwd=ai_dir,
                bufsize=1,
                universal_newlines=True,
                encoding='utf-8',
                errors='replace'
            )
            self.worker_running = True
            self.log("Worker已启动", "success")
            messagebox.showinfo("启动成功", "Worker已启动！\n\n日志会实时显示在下方。")

            # 启动日志读取线程
            threading.Thread(target=self._ai_read_log, daemon=True).start()
        except Exception as e:
            self.log(f"启动失败: {e}", "error")
            messagebox.showerror("启动失败", str(e))

    def _ai_read_log(self):
        """读取Worker日志"""
        try:
            for line in self.worker_process.stdout:
                line = line.strip()
                if line:
                    self.ai_log.insert(tk.END, f"[{time.strftime('%H:%M:%S')}] {line}\n")
                    self.ai_log.see(tk.END)
        except:
            pass

    def ai_stop_worker(self):
        """停止Worker"""
        if self.worker_process:
            self.worker_process.terminate()
            self.worker_process = None
        self.worker_running = False
        self.log("Worker已停止", "success")

    # ============================================================
    # 6. 构建工具模块
    # ============================================================
    def build_build_tab(self):
        """构建工具标签页"""
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🔨 构建工具")

        # 本地构建
        local_frame = ttk.LabelFrame(frame, text="🖥️ 本地构建", padding="10")
        local_frame.pack(fill=tk.X, pady=(0, 10))

        btn_row1 = ttk.Frame(local_frame)
        btn_row1.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row1, text="🤖 构建Android APK", command=self.build_android).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🐳 构建Docker镜像", command=self.build_docker).pack(side=tk.LEFT, padx=2)

        # 远程构建（GitHub Actions）
        remote_frame = ttk.LabelFrame(frame, text="🐙 GitHub Actions 远程构建", padding="10")
        remote_frame.pack(fill=tk.X, pady=(0, 10))

        btn_row1 = ttk.Frame(remote_frame)
        btn_row1.pack(fill=tk.X, pady=2)
        ttk.Button(btn_row1, text="🚀 触发Docker构建", command=lambda: self.github_trigger_build("docker.yml")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🍎 触发tvOS构建", command=lambda: self.github_trigger_build("build-tvos.yml")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="🤖 触发Android构建", command=lambda: self.github_trigger_build("build-android.yml")).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_row1, text="📊 查看构建状态", command=self.github_check_builds).pack(side=tk.LEFT, padx=2)

        # 自动轮询
        poll_frame = ttk.Frame(remote_frame)
        poll_frame.pack(fill=tk.X, pady=2)
        self.poll_enabled = tk.BooleanVar(value=False)
        ttk.Checkbutton(poll_frame, text="自动轮询构建状态（每30秒）", variable=self.poll_enabled, command=self.toggle_poll).pack(side=tk.LEFT)

        # 输出区域
        output_frame = ttk.LabelFrame(frame, text="📤 构建输出", padding="10")
        output_frame.pack(fill=tk.BOTH, expand=True)

        self.build_output = scrolledtext.ScrolledText(output_frame, font=self.font_mono, height=15)
        self.build_output.pack(fill=tk.BOTH, expand=True)

    def build_android(self):
        """本地构建Android APK"""
        def _do():
            project_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "android-tv-client")
            self.log(f"构建Android APK: {project_dir}", "command")
            try:
                result = subprocess.run(
                    ["gradlew", "assembleRelease", "--no-daemon"],
                    cwd=project_dir, capture_output=True, text=True, timeout=300,
                    encoding='utf-8', errors='replace', shell=True
                )
                self.build_output.delete(1.0, tk.END)
                self.build_output.insert(tk.END, result.stdout + result.stderr)
                if result.returncode == 0:
                    self.log("Android APK构建成功！", "success")
                    apk_path = os.path.join(project_dir, "app", "build", "outputs", "apk", "release")
                    if os.path.exists(apk_path):
                        apks = [f for f in os.listdir(apk_path) if f.endswith('.apk')]
                        if apks:
                            self.log(f"APK位置: {os.path.join(apk_path, apks[0])}", "success")
                else:
                    self.log("Android APK构建失败", "error")
            except Exception as e:
                self.log(f"构建失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def build_docker(self):
        """本地构建Docker镜像"""
        def _do():
            project_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "app", "docker")
            self.log(f"构建Docker镜像: {project_dir}", "command")
            try:
                result = subprocess.run(
                    ["docker", "build", "-t", "momo-ktv:local", "."],
                    cwd=project_dir, capture_output=True, text=True, timeout=600,
                    encoding='utf-8', errors='replace'
                )
                self.build_output.delete(1.0, tk.END)
                self.build_output.insert(tk.END, result.stdout + result.stderr)
                if result.returncode == 0:
                    self.log("Docker镜像构建成功！", "success")
                else:
                    self.log("Docker镜像构建失败", "error")
            except Exception as e:
                self.log(f"构建失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def toggle_poll(self):
        """切换自动轮询"""
        if self.poll_enabled.get():
            self.log("已开启自动轮询", "success")
            self._poll_loop()
        else:
            self.log("已关闭自动轮询")

    def _poll_loop(self):
        """轮询循环"""
        if not self.poll_enabled.get():
            return
        self.github_check_builds()
        self.root.after(30000, self._poll_loop)

    # ============================================================
    # 7. 命令学习模块
    # ============================================================
    def build_learn_tab(self):
        """命令学习标签页"""
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="📚 命令学习")

        # 左侧分类列表
        left_frame = ttk.Frame(frame)
        left_frame.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 10))

        ttk.Label(left_frame, text="命令分类", font=self.font_bold).pack(pady=(0, 5))

        self.learn_listbox = tk.Listbox(left_frame, width=25, height=25, font=self.font_normal)
        self.learn_listbox.pack(fill=tk.Y, expand=True)
        self.learn_listbox.bind('<<ListboxSelect>>', self.on_learn_select)

        # 命令分类
        self.learn_categories = {
            "GitHub API": [
                ("获取最新Commit", "GET /repos/{repo}/git/ref/heads/{branch}", "获取指定分支最新的commit SHA"),
                ("创建Blob", "POST /repos/{repo}/git/blobs", "将文件内容编码为base64，创建blob对象"),
                ("创建Tree", "POST /repos/{repo}/git/trees", "基于base_tree创建新的目录树，包含多个blob"),
                ("创建Commit", "POST /repos/{repo}/git/commits", "创建新的commit，关联tree和父commit"),
                ("更新Ref", "PATCH /repos/{repo}/git/refs/heads/{branch}", "将分支指向新的commit"),
                ("触发构建", "POST /repos/{repo}/actions/workflows/{file}/dispatches", "触发GitHub Actions workflow运行"),
                ("查询构建", "GET /repos/{repo}/actions/runs", "获取最近的构建运行状态"),
                ("下载产物", "GET /repos/{repo}/actions/runs/{id}/artifacts", "获取构建产生的artifact列表"),
            ],
            "文件操作": [
                ("读取文件", "Read(file_path)", "读取文件全部内容，支持文本和图片"),
                ("写入文件", "Write(file_path, content)", "创建新文件或覆盖现有文件"),
                ("编辑文件", "Edit(file_path, old, new)", "精确替换文件中的字符串，old必须唯一"),
                ("查找文件", "Glob(pattern)", "按通配符模式查找文件，如**/*.py"),
                ("搜索内容", "Grep(pattern, path)", "在文件中搜索正则表达式，返回匹配行"),
            ],
            "SSH远程": [
                ("连接SSH", "paramiko.SSHClient()", "创建SSH客户端，设置自动添加主机密钥"),
                ("执行命令", "client.exec_command(cmd)", "在远程主机执行命令，返回stdin/stdout/stderr"),
                ("sudo执行", "echo password | sudo -S cmd", "通过管道传递密码执行sudo命令"),
                ("上传文件", "sftp.put(local, remote)", "通过SFTP上传文件到远程主机"),
                ("下载文件", "sftp.get(remote, local)", "通过SFTP从远程主机下载文件"),
            ],
            "Docker命令": [
                ("查看容器", "docker ps -a", "查看所有容器（包括停止的）"),
                ("查看镜像", "docker images", "查看本地所有镜像"),
                ("拉取镜像", "docker pull image:tag", "从仓库拉取镜像"),
                ("启动容器", "docker compose up -d", "使用docker-compose后台启动容器"),
                ("停止容器", "docker stop container", "停止运行中的容器"),
                ("重启容器", "docker restart container", "重启容器"),
                ("查看日志", "docker logs container --tail 50", "查看容器最近50行日志"),
                ("删除容器", "docker rm -f container", "强制删除容器"),
                ("清理镜像", "docker image prune -f", "清理无用的镜像"),
            ],
            "Python环境": [
                ("创建虚拟环境", "python -m venv .venv", "创建隔离的Python虚拟环境"),
                ("激活虚拟环境", ".venv\\Scripts\\activate", "Windows激活虚拟环境（Linux: source .venv/bin/activate）"),
                ("安装包", "pip install package", "安装Python包"),
                ("安装指定版本", "pip install torch==2.6.0", "安装指定版本的包"),
                ("从源安装", "pip install -r requirements.txt", "从requirements.txt安装所有依赖"),
                ("换源安装", "pip install package -i https://pypi.tuna.tsinghua.edu.cn/simple", "使用清华镜像源加速安装"),
            ],
            "AI模型": [
                ("Demucs人声分离", "demucs.separate.main(['-n', 'htdemucs', 'audio.wav'])", "使用Demucs模型分离人声和伴奏"),
                ("WhisperX识别", "whisperx.load_model('large-v2', device='cuda')", "加载WhisperX模型进行语音识别"),
                ("模型下载镜像", "HF_ENDPOINT=https://hf-mirror.com", "设置HuggingFace国内镜像加速模型下载"),
                ("GPU检测", "torch.cuda.is_available()", "检测CUDA是否可用"),
                ("显存清理", "torch.cuda.empty_cache()", "清理GPU显存缓存"),
            ],
        }

        for cat in self.learn_categories.keys():
            self.learn_listbox.insert(tk.END, cat)

        # 右侧内容显示
        right_frame = ttk.Frame(frame)
        right_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        ttk.Label(right_frame, text="命令详情", font=self.font_bold).pack(pady=(0, 5), anchor=tk.W)

        self.learn_text = scrolledtext.ScrolledText(right_frame, font=self.font_mono, height=25)
        self.learn_text.pack(fill=tk.BOTH, expand=True)

        # 默认显示第一个分类
        self.learn_listbox.selection_set(0)
        self.on_learn_select(None)

    def on_learn_select(self, event):
        """选择命令分类"""
        selection = self.learn_listbox.curselection()
        if not selection:
            return

        cat = self.learn_listbox.get(selection[0])
        commands = self.learn_categories.get(cat, [])

        content = f"{'='*60}\n{cat} - 共 {len(commands)} 个命令\n{'='*60}\n\n"

        for i, (name, cmd, desc) in enumerate(commands, 1):
            content += f"【{i}】{name}\n"
            content += f"  命令: {cmd}\n"
            content += f"  说明: {desc}\n\n"

        # 添加原理说明
        content += f"{'='*60}\n工作原理\n{'='*60}\n\n"

        if cat == "GitHub API":
            content += """Git提交的完整流程：
1. 获取最新commit的SHA（作为父commit）
2. 将每个文件内容base64编码，创建blob（文件对象）
3. 创建tree（目录树），关联所有blob，基于父commit的tree
4. 创建commit，关联新的tree和父commit
5. 更新分支ref，指向新的commit

这就是Git的对象模型：blob（文件）→ tree（目录）→ commit（提交）→ ref（分支）
"""
        elif cat == "文件操作":
            content += """文件操作原理：
- Read: 以只读模式打开文件，读取全部内容到内存
- Write: 以写入模式打开文件（不存在则创建，存在则覆盖）
- Edit: 读取文件→字符串替换→写回文件，要求old字符串唯一
- Glob: 使用fnmatch模块进行通配符匹配
- Grep: 使用ripgrep工具进行快速正则搜索
"""
        elif cat == "SSH远程":
            content += """SSH远程执行原理：
1. SSHClient创建TCP连接到远程主机22端口
2. 进行密钥交换和身份验证（密码/密钥）
3. 建立加密通道
4. exec_command在远程创建shell进程执行命令
5. 通过标准输入/输出/错误流通信
6. sudo -S从标准输入读取密码，避免交互式输入
"""
        elif cat == "Docker命令":
            content += """Docker工作原理：
- Docker是容器化技术，将应用和依赖打包成镜像
- 镜像（Image）是只读模板，容器（Container）是镜像的运行实例
- docker compose通过yaml文件定义多容器应用
- 容器之间通过网络通信，数据通过卷（Volume）持久化
- 日志通过docker logs查看，默认存储在/var/lib/docker/containers/
"""
        elif cat == "Python环境":
            content += """虚拟环境原理：
- venv创建隔离的Python环境，避免包版本冲突
- 激活后，pip install会安装到虚拟环境目录
- 不同项目可以使用不同版本的包
- requirements.txt记录所有依赖和版本
- 国内镜像源（清华、阿里）加速包下载
"""
        elif cat == "AI模型":
            content += """AI模型工作原理：
- Demucs: 基于深度学习的音源分离模型，将音频分成人声/鼓/贝斯/其他
- WhisperX: OpenAI Whisper的增强版，支持逐字时间轴（forced alignment）
- CUDA: NVIDIA的并行计算平台，GPU加速深度学习推理
- HuggingFace: 模型托管平台，国内镜像hf-mirror.com加速下载
- 显存管理: 每处理完一首歌释放显存，避免OOM（内存溢出）
"""

        self.learn_text.delete(1.0, tk.END)
        self.learn_text.insert(tk.END, content)


def main():
    root = tk.Tk()

    # 设置主题
    style = ttk.Style()
    try:
        style.theme_use('clam')
    except:
        pass

    app = MomoToolbox(root)
    root.mainloop()


if __name__ == '__main__':
    main()
