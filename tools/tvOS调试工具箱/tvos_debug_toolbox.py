# -*- coding: utf-8 -*-
"""
墨墨爱K歌 - tvOS IPA调试工具箱
================================
专门用于tvOS客户端的调试和修改工具：
1. IPA管理 - 下载、查看信息、安装指引
2. GitHub互通 - commit历史、对比、源码下载、触发构建
3. 控件调试 - 搜索控件、修改参数、批量调整
4. 参数调整 - 字体、颜色、布局、焦点、动画等全局参数
5. 代码编辑 - 搜索、查找替换、文件浏览
6. 快速修改 - 常用修改一键应用模板
7. 构建提交 - 修改后一键提交并触发构建
8. 调试日志 - 操作记录和修改历史

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
import zipfile
import re
import shutil
from pathlib import Path
from datetime import datetime

# 确保中文输出正常
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        pass

APP_TITLE = "墨墨爱K歌 - tvOS调试工具箱"
APP_VERSION = "1.0.0"
CONFIG_FILE = "tvos_debug_config.json"

# tvOS项目Swift文件列表（相对于仓库根目录）
TVOS_FILES = [
    "tvos-client/JunyaoKtvTV/ContentView.swift",
    "tvos-client/JunyaoKtvTV/FullPages.swift",
    "tvos-client/JunyaoKtvTV/Panels.swift",
    "tvos-client/JunyaoKtvTV/Components.swift",
    "tvos-client/JunyaoKtvTV/PlayerView.swift",
    "tvos-client/JunyaoKtvTV/FullPlayerView.swift",
    "tvos-client/JunyaoKtvTV/Theme.swift",
    "tvos-client/JunyaoKtvTV/Models.swift",
    "tvos-client/JunyaoKtvTV/APIClient.swift",
    "tvos-client/JunyaoKtvTV/PlayerManager.swift",
    "tvos-client/JunyaoKtvTV/JunyaoKtvTVApp.swift",
    "tvos-client/JunyaoKtvTV/LoginView.swift",
    "tvos-client/JunyaoKtvTV/SetupView.swift",
    "tvos-client/JunyaoKtvTV/SharedVideoView.swift",
]

# 默认配置
DEFAULT_CONFIG = {
    "github": {
        "token": "",
        "repo": "klzbw/momo-ktv",
        "branch": "main"
    },
    "project": {
        "local_path": "",
        "tvos_path": "tvos-client/JunyaoKtvTV"
    },
    "ipa": {
        "download_dir": "downloads",
        "last_download": ""
    },
    "ui": {
        "theme": "clam",
        "font_size": 10
    }
}

# 常用快速修改模板
QUICK_MODS = {
    "全局字体放大": {
        "desc": "将所有.font(.system(size: X))放大1.5倍",
        "pattern": r"\.font\(\.system\(size:\s*(\d+)",
        "replace": lambda m: f".font(.system(size: {int(int(m.group(1)) * 1.5)}",
        "files": TVOS_FILES
    },
    "焦点框缩小": {
        "desc": "将所有.padding(X)中的焦点相关padding缩小",
        "pattern": r"focused.*?\.padding\((\d+)\)",
        "replace": lambda m: m.group(0).replace(f".padding({m.group(1)})", f".padding({max(1, int(m.group(1))-2)})"),
        "files": TVOS_FILES
    },
    "键盘按键加大": {
        "desc": "将键盘按键frame尺寸放大1.2倍",
        "pattern": r"frame\(width:\s*(\d+),\s*height:\s*(\d+)\)",
        "replace": lambda m: f"frame(width: {int(int(m.group(1))*1.2)}, height: {int(int(m.group(2))*1.2)})",
        "files": ["tvos-client/JunyaoKtvTV/FullPages.swift"]
    },
}


class TvOSToolbox:
    """tvOS调试工具箱主类"""

    def __init__(self, root):
        self.root = root
        self.root.title(f"{APP_TITLE} v{APP_VERSION}")
        self.root.geometry("1200x800")
        self.root.minsize(1000, 650)

        # 状态变量
        self.config = self.load_config()
        self.log_queue = queue.Queue()
        self.local_files = {}  # 本地缓存的Swift文件内容
        self.mod_history = []  # 修改历史

        # 设置字体
        self.font_normal = ("Microsoft YaHei", self.config['ui']['font_size'])
        self.font_bold = ("Microsoft YaHei", self.config['ui']['font_size'], "bold")
        self.font_title = ("Microsoft YaHei", self.config['ui']['font_size'] + 2, "bold")
        self.font_mono = ("Consolas", self.config['ui']['font_size'])

        # 构建界面
        self.build_ui()
        self.update_log()

        self.log(f"欢迎使用 {APP_TITLE} v{APP_VERSION}")
        self.log("请先配置GitHub Token，然后下载源码开始调试")

    def load_config(self):
        try:
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
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
        try:
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            self.log(f"保存配置失败: {e}", "error")
            return False

    def build_ui(self):
        main_frame = ttk.Frame(self.root, padding="5")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # 顶部标题栏
        top_frame = ttk.Frame(main_frame)
        top_frame.pack(fill=tk.X, pady=(0, 5))
        ttk.Label(top_frame, text="📺 墨墨爱K歌 - tvOS IPA调试工具箱", font=self.font_title).pack(side=tk.LEFT)
        ttk.Label(top_frame, text=f"v{APP_VERSION}", foreground="gray").pack(side=tk.LEFT, padx=(10, 0))

        # 标签页
        self.notebook = ttk.Notebook(main_frame)
        self.notebook.pack(fill=tk.BOTH, expand=True)

        self.build_config_tab()
        self.build_github_tab()
        self.build_ipa_tab()
        self.build_control_tab()
        self.build_param_tab()
        self.build_code_tab()
        self.build_quick_tab()
        self.build_build_tab()

        # 底部日志
        log_frame = ttk.LabelFrame(main_frame, text="📋 调试日志", padding="5")
        log_frame.pack(fill=tk.BOTH, pady=(5, 0))
        self.log_text = scrolledtext.ScrolledText(log_frame, height=7, font=self.font_mono, bg="#1e1e1e", fg="#ffffff")
        self.log_text.pack(fill=tk.BOTH, expand=True)
        self.log_text.tag_config("info", foreground="#87ceeb")
        self.log_text.tag_config("success", foreground="#00ff00")
        self.log_text.tag_config("error", foreground="#ff4444")
        self.log_text.tag_config("warning", foreground="#ffaa00")
        self.log_text.tag_config("modify", foreground="#ff88ff")
        self.log_text.tag_config("command", foreground="#ffff00")

    def log(self, message, level="info"):
        timestamp = time.strftime("%H:%M:%S")
        self.log_queue.put((timestamp, message, level))

    def update_log(self):
        try:
            while not self.log_queue.empty():
                timestamp, message, level = self.log_queue.get_nowait()
                self.log_text.insert(tk.END, f"[{timestamp}] {message}\n", level)
                self.log_text.see(tk.END)
        except queue.Empty:
            pass
        self.root.after(100, self.update_log)

    def github_headers(self):
        return {
            'Authorization': f'token {self.config["github"]["token"]}',
            'Accept': 'application/vnd.github+json'
        }

    def github_base(self):
        return f"https://api.github.com/repos/{self.config['github']['repo']}"

    # ============================================================
    # 1. 配置标签页
    # ============================================================
    def build_config_tab(self):
        frame = ttk.Frame(self.notebook, padding="15")
        self.notebook.add(frame, text="⚙️ 配置")

        # GitHub配置
        gh_frame = ttk.LabelFrame(frame, text="🐙 GitHub配置", padding="15")
        gh_frame.pack(fill=tk.X, pady=(0, 15))

        row = ttk.Frame(gh_frame)
        row.pack(fill=tk.X, pady=5)
        ttk.Label(row, text="Token:", width=12).pack(side=tk.LEFT)
        self.cfg_token_var = tk.StringVar(value=self.config['github']['token'])
        ttk.Entry(row, textvariable=self.cfg_token_var, width=55, show="*").pack(side=tk.LEFT, padx=(0, 10))
        ttk.Label(row, text="获取: github.com/settings/tokens", foreground="gray").pack(side=tk.LEFT)

        row = ttk.Frame(gh_frame)
        row.pack(fill=tk.X, pady=5)
        ttk.Label(row, text="仓库:", width=12).pack(side=tk.LEFT)
        self.cfg_repo_var = tk.StringVar(value=self.config['github']['repo'])
        ttk.Entry(row, textvariable=self.cfg_repo_var, width=30).pack(side=tk.LEFT, padx=(0, 20))
        ttk.Label(row, text="分支:", width=6).pack(side=tk.LEFT)
        self.cfg_branch_var = tk.StringVar(value=self.config['github']['branch'])
        ttk.Entry(row, textvariable=self.cfg_branch_var, width=15).pack(side=tk.LEFT)

        # 项目配置
        proj_frame = ttk.LabelFrame(frame, text="📁 项目配置", padding="15")
        proj_frame.pack(fill=tk.X, pady=(0, 15))

        row = ttk.Frame(proj_frame)
        row.pack(fill=tk.X, pady=5)
        ttk.Label(row, text="本地源码目录:", width=12).pack(side=tk.LEFT)
        self.cfg_local_var = tk.StringVar(value=self.config['project']['local_path'])
        ttk.Entry(row, textvariable=self.cfg_local_var, width=55).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Button(row, text="浏览", command=self.browse_local_dir).pack(side=tk.LEFT)

        row = ttk.Frame(proj_frame)
        row.pack(fill=tk.X, pady=5)
        ttk.Label(row, text="tvOS源码路径:", width=12).pack(side=tk.LEFT)
        self.cfg_tvos_var = tk.StringVar(value=self.config['project']['tvos_path'])
        ttk.Entry(row, textvariable=self.cfg_tvos_var, width=55).pack(side=tk.LEFT)

        # 保存按钮
        btn_frame = ttk.Frame(frame)
        btn_frame.pack(fill=tk.X, pady=10)
        ttk.Button(btn_frame, text="💾 保存配置", command=self.save_all_config, width=20).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="🔍 测试GitHub连接", command=self.test_github, width=20).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="📂 加载本地源码", command=self.load_local_files, width=20).pack(side=tk.LEFT, padx=5)

        # 状态显示
        status_frame = ttk.LabelFrame(frame, text="📊 当前状态", padding="15")
        status_frame.pack(fill=tk.BOTH, expand=True)
        self.config_status = tk.Text(status_frame, height=10, font=self.font_mono, bg="#0d0d0d", fg="#00ff00")
        self.config_status.pack(fill=tk.BOTH, expand=True)
        self.update_config_status()

    def browse_local_dir(self):
        d = filedialog.askdirectory()
        if d:
            self.cfg_local_var.set(d)

    def save_all_config(self):
        self.config['github']['token'] = self.cfg_token_var.get()
        self.config['github']['repo'] = self.cfg_repo_var.get()
        self.config['github']['branch'] = self.cfg_branch_var.get()
        self.config['project']['local_path'] = self.cfg_local_var.get()
        self.config['project']['tvos_path'] = self.cfg_tvos_var.get()
        if self.save_config():
            self.log("配置已保存", "success")
            self.update_config_status()
            messagebox.showinfo("成功", "配置已保存！")

    def test_github(self):
        def _do():
            try:
                r = requests.get(f'{self.github_base()}', headers=self.github_headers(), timeout=10)
                if r.status_code == 200:
                    data = r.json()
                    self.log(f"GitHub连接成功: {data['full_name']} (⭐{data['stargazers_count']})", "success")
                    messagebox.showinfo("成功", f"连接成功！\n仓库: {data['full_name']}\n描述: {data.get('description','无')}")
                else:
                    self.log(f"连接失败: HTTP {r.status_code}", "error")
                    messagebox.showerror("失败", f"HTTP {r.status_code}\n{r.text[:200]}")
            except Exception as e:
                self.log(f"连接失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def load_local_files(self):
        local_path = self.cfg_local_var.get()
        if not local_path or not os.path.exists(local_path):
            messagebox.showwarning("提示", "请先配置本地源码目录")
            return

        tvos_path = os.path.join(local_path, self.cfg_tvos_var.get().replace('/', os.sep))
        if not os.path.exists(tvos_path):
            messagebox.showerror("错误", f"未找到tvOS源码目录:\n{tvos_path}")
            return

        count = 0
        for f in os.listdir(tvos_path):
            if f.endswith('.swift'):
                filepath = os.path.join(tvos_path, f)
                with open(filepath, 'r', encoding='utf-8') as fh:
                    self.local_files[f] = fh.read()
                count += 1

        self.log(f"已加载 {count} 个Swift文件到内存", "success")
        self.update_config_status()
        messagebox.showinfo("成功", f"已加载 {count} 个Swift文件！\n\n可以在「控件调试」「参数调整」「代码编辑」中使用。")

    def update_config_status(self):
        lines = []
        lines.append(f"GitHub Token: {'已配置 ✅' if self.config['github']['token'] else '未配置 ❌'}")
        lines.append(f"GitHub 仓库: {self.config['github']['repo']}")
        lines.append(f"GitHub 分支: {self.config['github']['branch']}")
        lines.append(f"本地源码目录: {self.config['project']['local_path'] or '未配置'}")
        lines.append(f"tvOS源码路径: {self.config['project']['tvos_path']}")
        lines.append(f"已加载文件数: {len(self.local_files)}")
        lines.append(f"修改历史记录: {len(self.mod_history)} 条")
        self.config_status.delete(1.0, tk.END)
        self.config_status.insert(tk.END, "\n".join(lines))

    # ============================================================
    # 2. GitHub互通标签页
    # ============================================================
    def build_github_tab(self):
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🐙 GitHub互通")

        # 操作按钮
        btn_frame = ttk.LabelFrame(frame, text="操作", padding="10")
        btn_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(btn_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Button(row1, text="📋 获取Commit历史", command=self.github_get_commits).pack(side=tk.LEFT, padx=2)
        ttk.Button(row1, text="📥 下载最新源码", command=self.github_download_source).pack(side=tk.LEFT, padx=2)
        ttk.Button(row1, text="📥 下载指定commit源码", command=self.github_download_commit).pack(side=tk.LEFT, padx=2)
        ttk.Button(row1, text="🔍 对比两个commit", command=self.github_compare).pack(side=tk.LEFT, padx=2)

        row2 = ttk.Frame(btn_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Button(row2, text="🚀 触发tvOS构建", command=lambda: self.github_trigger_build("build-tvos.yml")).pack(side=tk.LEFT, padx=2)
        ttk.Button(row2, text="📊 查看构建状态", command=self.github_check_builds).pack(side=tk.LEFT, padx=2)
        ttk.Button(row2, text="⬇️ 下载最新IPA", command=self.github_download_ipa).pack(side=tk.LEFT, padx=2)

        # Commit列表
        list_frame = ttk.LabelFrame(frame, text="📜 Commit历史（最近20条）", padding="10")
        list_frame.pack(fill=tk.BOTH, expand=True)

        self.commit_tree = ttk.Treeview(list_frame, columns=("sha", "message", "author", "date"), show="headings", height=10)
        self.commit_tree.heading("sha", text="SHA")
        self.commit_tree.heading("message", text="信息")
        self.commit_tree.heading("author", text="作者")
        self.commit_tree.heading("date", text="日期")
        self.commit_tree.column("sha", width=80)
        self.commit_tree.column("message", width=400)
        self.commit_tree.column("author", width=100)
        self.commit_tree.column("date", width=150)
        self.commit_tree.pack(fill=tk.BOTH, expand=True)

        # 结果显示
        result_frame = ttk.LabelFrame(frame, text="📄 结果", padding="10")
        result_frame.pack(fill=tk.BOTH, pady=(10, 0))
        self.github_result = scrolledtext.ScrolledText(result_frame, font=self.font_mono, height=8)
        self.github_result.pack(fill=tk.BOTH, expand=True)

    def github_get_commits(self):
        def _do():
            try:
                r = requests.get(f'{self.github_base()}/commits', headers=self.github_headers(),
                                 params={'per_page': 20, 'sha': self.config['github']['branch']}, timeout=15)
                if r.status_code == 200:
                    commits = r.json()
                    for item in self.commit_tree.get_children():
                        self.commit_tree.delete(item)
                    for c in commits:
                        sha = c['sha'][:7]
                        msg = c['commit']['message'].split('\n')[0][:80]
                        author = c['commit']['author']['name']
                        date = c['commit']['author']['date'][:10]
                        self.commit_tree.insert("", tk.END, values=(sha, msg, author, date))
                    self.log(f"获取到 {len(commits)} 条commit", "success")
                else:
                    self.log(f"获取失败: HTTP {r.status_code}", "error")
            except Exception as e:
                self.log(f"获取失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_download_source(self):
        def _do():
            try:
                self.log("正在下载最新源码...")
                r = requests.get(f'{self.github_base()}/zipball/{self.config["github"]["branch"]}',
                                 headers=self.github_headers(), timeout=120, stream=True)
                if r.status_code == 200:
                    download_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
                    os.makedirs(download_dir, exist_ok=True)
                    zip_path = os.path.join(download_dir, f"source_{self.config['github']['branch']}_{time.strftime('%Y%m%d_%H%M%S')}.zip")
                    with open(zip_path, 'wb') as f:
                        for chunk in r.iter_content(chunk_size=8192):
                            f.write(chunk)
                    self.log(f"源码已下载: {zip_path} ({os.path.getsize(zip_path)//1024}KB)", "success")
                    messagebox.showinfo("下载完成", f"源码已下载到:\n{zip_path}")
                else:
                    self.log(f"下载失败: HTTP {r.status_code}", "error")
            except Exception as e:
                self.log(f"下载失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_download_commit(self):
        sha = simpledialog.askstring("下载指定commit", "请输入commit SHA（7位或完整）:")
        if not sha:
            return

        def _do():
            try:
                self.log(f"正在下载commit {sha} 源码...")
                r = requests.get(f'{self.github_base()}/zipball/{sha}', headers=self.github_headers(),
                                 timeout=120, stream=True)
                if r.status_code == 200:
                    download_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
                    os.makedirs(download_dir, exist_ok=True)
                    zip_path = os.path.join(download_dir, f"source_{sha[:7]}.zip")
                    with open(zip_path, 'wb') as f:
                        for chunk in r.iter_content(chunk_size=8192):
                            f.write(chunk)
                    self.log(f"commit {sha[:7]} 源码已下载: {zip_path}", "success")
                    messagebox.showinfo("下载完成", f"源码已下载到:\n{zip_path}")
                else:
                    self.log(f"下载失败: HTTP {r.status_code}", "error")
            except Exception as e:
                self.log(f"下载失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_compare(self):
        base = simpledialog.askstring("对比commit", "请输入基础commit SHA（旧）:")
        if not base:
            return
        head = simpledialog.askstring("对比commit", "请输入对比commit SHA（新）:")
        if not head:
            return

        def _do():
            try:
                r = requests.get(f'{self.github_base()}/compare/{base}...{head}',
                                 headers=self.github_headers(), timeout=30)
                if r.status_code == 200:
                    data = r.json()
                    files = data.get('files', [])
                    result = f"对比 {base[:7]} → {head[:7]}\n"
                    result += f"{'='*60}\n"
                    result += f"总变更文件: {data.get('total_files', 0)}\n"
                    result += f"新增行数: +{data.get('additions', 0)}\n"
                    result += f"删除行数: -{data.get('deletions', 0)}\n\n"
                    result += "变更文件列表:\n"
                    result += f"{'='*60}\n"
                    for f in files:
                        status = f.get('status', '')
                        additions = f.get('additions', 0)
                        deletions = f.get('deletions', 0)
                        result += f"  [{status:10s}] +{additions:4d} -{deletions:4d}  {f['filename']}\n"
                    self.github_result.delete(1.0, tk.END)
                    self.github_result.insert(tk.END, result)
                    self.log(f"对比完成: {len(files)} 个文件变更", "success")
                else:
                    self.log(f"对比失败: HTTP {r.status_code}", "error")
            except Exception as e:
                self.log(f"对比失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_trigger_build(self, workflow):
        def _do():
            try:
                r = requests.post(f'{self.github_base()}/actions/workflows/{workflow}/dispatches',
                                  headers=self.github_headers(), json={'ref': self.config['github']['branch']}, timeout=10)
                if r.status_code == 204:
                    self.log(f"已触发构建: {workflow}", "success")
                    messagebox.showinfo("成功", f"已触发构建: {workflow}\n\n构建通常需要10-20分钟。")
                else:
                    self.log(f"触发失败: HTTP {r.status_code}", "error")
            except Exception as e:
                self.log(f"触发失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_check_builds(self):
        def _do():
            try:
                r = requests.get(f'{self.github_base()}/actions/runs', headers=self.github_headers(),
                                 params={'per_page': 10}, timeout=15)
                if r.status_code == 200:
                    runs = r.json().get('workflow_runs', [])
                    result = "最近构建状态:\n" + "="*60 + "\n"
                    for run in runs[:10]:
                        icon = "✅" if run.get('conclusion') == "success" else "❌" if run.get('conclusion') == "failure" else "⏳" if run['status'] == "in_progress" else "⚪"
                        result += f"{icon} {run['name'][:35]:35s} | {run['status']:12s} | {run.get('conclusion') or '-':8s} | {run['head_sha'][:7]} | {run['created_at'][:10]}\n"
                    self.github_result.delete(1.0, tk.END)
                    self.github_result.insert(tk.END, result)
                    self.log("构建状态已更新", "success")
            except Exception as e:
                self.log(f"获取失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def github_download_ipa(self):
        def _do():
            try:
                r = requests.get(f'{self.github_base()}/actions/runs', headers=self.github_headers(),
                                 params={'per_page': 20, 'status': 'completed'}, timeout=15)
                runs = r.json().get('workflow_runs', [])
                target = None
                for run in runs:
                    if 'tvos' in run['name'].lower() and run.get('conclusion') == 'success':
                        target = run
                        break
                if not target:
                    messagebox.showwarning("未找到", "未找到成功的tvOS构建")
                    return

                r2 = requests.get(f'{self.github_base()}/actions/runs/{target["id"]}/artifacts',
                                  headers=self.github_headers(), timeout=15)
                artifacts = r2.json().get('artifacts', [])
                if not artifacts:
                    messagebox.showwarning("未找到", "构建没有产物")
                    return

                self.log(f"下载IPA: {artifacts[0]['name']}")
                r3 = requests.get(artifacts[0]['archive_download_url'], headers=self.github_headers(), timeout=180)
                if r3.status_code == 200:
                    import io
                    z = zipfile.ZipFile(io.BytesIO(r3.content))
                    download_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
                    os.makedirs(download_dir, exist_ok=True)
                    saved = []
                    for name in z.namelist():
                        if name.endswith('.ipa'):
                            out = os.path.join(download_dir, os.path.basename(name))
                            with open(out, 'wb') as f:
                                f.write(z.read(name))
                            saved.append(out)
                            self.log(f"已保存: {out}", "success")
                    if saved:
                        messagebox.showinfo("下载完成", f"IPA已下载到:\n{saved[0]}")
                else:
                    self.log(f"下载失败: HTTP {r3.status_code}", "error")
            except Exception as e:
                self.log(f"下载失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    # ============================================================
    # 3. IPA管理标签页
    # ============================================================
    def build_ipa_tab(self):
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="📦 IPA管理")

        # IPA文件选择
        file_frame = ttk.LabelFrame(frame, text="📁 IPA文件", padding="10")
        file_frame.pack(fill=tk.X, pady=(0, 10))

        row = ttk.Frame(file_frame)
        row.pack(fill=tk.X, pady=2)
        self.ipa_path_var = tk.StringVar()
        ttk.Entry(row, textvariable=self.ipa_path_var, width=70).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Button(row, text="浏览", command=self.browse_ipa).pack(side=tk.LEFT, padx=2)
        ttk.Button(row, text="📥 从GitHub下载", command=self.github_download_ipa).pack(side=tk.LEFT, padx=2)

        # IPA信息
        info_frame = ttk.LabelFrame(frame, text="📊 IPA信息", padding="10")
        info_frame.pack(fill=tk.X, pady=(0, 10))

        self.ipa_info = tk.Text(info_frame, height=8, font=self.font_mono, bg="#0d0d0d", fg="#00ffff")
        self.ipa_info.pack(fill=tk.X)

        # 操作按钮
        btn_frame = ttk.LabelFrame(frame, text="⚡ 操作", padding="10")
        btn_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(btn_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Button(row1, text="🔍 解析IPA信息", command=self.analyze_ipa).pack(side=tk.LEFT, padx=2)
        ttk.Button(row1, text="📂 解压IPA", command=self.extract_ipa).pack(side=tk.LEFT, padx=2)
        ttk.Button(row1, text="📋 查看Info.plist", command=self.view_info_plist).pack(side=tk.LEFT, padx=2)
        ttk.Button(row1, text="🖼️ 提取图标", command=self.extract_icons).pack(side=tk.LEFT, padx=2)

        # 安装指引
        guide_frame = ttk.LabelFrame(frame, text="📖 tvOS IPA安装指引（Windows）", padding="10")
        guide_frame.pack(fill=tk.BOTH, expand=True)

        guide_text = """Windows安装tvOS IPA的几种方法：

【方法1】Apple Configurator（推荐）
1. 下载安装 Apple Configurator 2（Mac App Store）
   注意：Windows没有官方Apple Configurator，需要Mac
2. Apple TV通过USB-C连接Mac
3. 打开Apple Configurator，识别设备
4. 拖拽IPA文件到设备图标上
5. 等待安装完成

【方法2】Xcode（需要Mac）
1. 打开Xcode → Window → Devices and Simulators
2. Apple TV连接Mac（同一WiFi或USB）
3. 点击"+"添加IPA
4. 等待安装

【方法3】第三方工具（Windows可用）
- 爱思助手（支持tvOS应用安装）
- 3uTools
1. 下载安装对应工具
2. Apple TV通过USB连接电脑
3. 选择"安装应用"，选择IPA文件
4. 等待安装完成

【方法4】命令行（需要Mac + Xcode）
  xcrun devicectl device install app --device <设备ID> <IPA路径>

【注意事项】
- IPA必须是开发证书签名（不能是App Store版本）
- Apple TV必须开启开发者模式
- 设置 → 隐私与安全性 → 开发者模式 → 开启
- 首次安装需要在Apple TV上信任开发者证书
"""
        self.ipa_guide = scrolledtext.ScrolledText(guide_frame, font=self.font_mono, height=12)
        self.ipa_guide.pack(fill=tk.BOTH, expand=True)
        self.ipa_guide.insert(tk.END, guide_text)
        self.ipa_guide.config(state=tk.DISABLED)

    def browse_ipa(self):
        f = filedialog.askopenfilename(filetypes=[("IPA文件", "*.ipa"), ("所有文件", "*.*")])
        if f:
            self.ipa_path_var.set(f)

    def analyze_ipa(self):
        ipa_path = self.ipa_path_var.get()
        if not ipa_path or not os.path.exists(ipa_path):
            messagebox.showwarning("提示", "请先选择IPA文件")
            return

        def _do():
            try:
                self.log(f"解析IPA: {ipa_path}")
                file_size = os.path.getsize(ipa_path)
                with zipfile.ZipFile(ipa_path, 'r') as z:
                    names = z.namelist()
                    app_dir = [n for n in names if n.endswith('.app/') or '.app/' in n][0] if any('.app/' in n for n in names) else ""

                    # 查找Info.plist
                    info_plist = None
                    for n in names:
                        if n.endswith('Info.plist') and '.app/' in n:
                            info_plist = n
                            break

                    info = {}
                    if info_plist:
                        import plistlib
                        with z.open(info_plist) as f:
                            try:
                                info = plistlib.load(f)
                            except:
                                pass

                    # 统计文件
                    swift_files = [n for n in names if n.endswith('.swift')]
                    storyboards = [n for n in names if n.endswith('.storyboard') or n.endswith('.nib')]
                    assets = [n for n in names if 'Assets.car' in n or n.endswith('.png') or n.endswith('.jpg')]

                    result = f"""IPA文件信息：
{'='*50}
文件名: {os.path.basename(ipa_path)}
文件大小: {file_size/1024/1024:.2f} MB
文件总数: {len(names)}

应用信息:
  Bundle ID: {info.get('CFBundleIdentifier', '未知')}
  应用名称: {info.get('CFBundleDisplayName', info.get('CFBundleName', '未知'))}
  版本号: {info.get('CFBundleShortVersionString', '未知')}
  构建号: {info.get('CFBundleVersion', '未知')}
  最低系统: {info.get('MinimumOSVersion', '未知')}
  支持设备: {info.get('UIDeviceFamily', '未知')}

内容统计:
  Swift源文件: {len(swift_files)}
  Storyboard/XIB: {len(storyboards)}
  图片/资源: {len(assets)}
  总文件数: {len(names)}
"""
                    self.ipa_info.delete(1.0, tk.END)
                    self.ipa_info.insert(tk.END, result)
                    self.log("IPA解析完成", "success")
            except Exception as e:
                self.log(f"解析失败: {e}", "error")
                messagebox.showerror("错误", str(e))
        threading.Thread(target=_do, daemon=True).start()

    def extract_ipa(self):
        ipa_path = self.ipa_path_var.get()
        if not ipa_path or not os.path.exists(ipa_path):
            messagebox.showwarning("提示", "请先选择IPA文件")
            return

        out_dir = os.path.join(os.path.dirname(ipa_path), os.path.basename(ipa_path).replace('.ipa', '_extracted'))
        os.makedirs(out_dir, exist_ok=True)

        def _do():
            try:
                self.log(f"解压IPA到: {out_dir}")
                with zipfile.ZipFile(ipa_path, 'r') as z:
                    z.extractall(out_dir)
                self.log(f"解压完成，共 {len(os.listdir(out_dir))} 个项目", "success")
                messagebox.showinfo("完成", f"IPA已解压到:\n{out_dir}")
            except Exception as e:
                self.log(f"解压失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    def view_info_plist(self):
        ipa_path = self.ipa_path_var.get()
        if not ipa_path or not os.path.exists(ipa_path):
            messagebox.showwarning("提示", "请先选择IPA文件")
            return

        try:
            with zipfile.ZipFile(ipa_path, 'r') as z:
                info_plist = None
                for n in z.namelist():
                    if n.endswith('Info.plist') and '.app/' in n:
                        info_plist = n
                        break
                if info_plist:
                    import plistlib
                    with z.open(info_plist) as f:
                        info = plistlib.load(f)
                    result = json.dumps(info, indent=2, ensure_ascii=False, default=str)
                    self.ipa_info.delete(1.0, tk.END)
                    self.ipa_info.insert(tk.END, f"Info.plist 内容:\n\n{result}")
                    self.log("Info.plist已读取", "success")
        except Exception as e:
            self.log(f"读取失败: {e}", "error")

    def extract_icons(self):
        ipa_path = self.ipa_path_var.get()
        if not ipa_path or not os.path.exists(ipa_path):
            messagebox.showwarning("提示", "请先选择IPA文件")
            return

        out_dir = os.path.join(os.path.dirname(ipa_path), "icons_extracted")
        os.makedirs(out_dir, exist_ok=True)

        def _do():
            try:
                count = 0
                with zipfile.ZipFile(ipa_path, 'r') as z:
                    for n in z.namelist():
                        if n.endswith(('.png', '.jpg', '.jpeg')) and ('icon' in n.lower() or 'AppIcon' in n or 'Assets' in n):
                            out = os.path.join(out_dir, os.path.basename(n))
                            with open(out, 'wb') as f:
                                f.write(z.read(n))
                            count += 1
                self.log(f"已提取 {count} 个图标到: {out_dir}", "success")
                messagebox.showinfo("完成", f"已提取 {count} 个图标到:\n{out_dir}")
            except Exception as e:
                self.log(f"提取失败: {e}", "error")
        threading.Thread(target=_do, daemon=True).start()

    # ============================================================
    # 4. 控件调试标签页
    # ============================================================
    def build_control_tab(self):
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🎛️ 控件调试")

        # 文件选择
        file_frame = ttk.LabelFrame(frame, text="📁 选择文件", padding="10")
        file_frame.pack(fill=tk.X, pady=(0, 10))

        row = ttk.Frame(file_frame)
        row.pack(fill=tk.X, pady=2)
        ttk.Label(row, text="Swift文件:").pack(side=tk.LEFT)
        self.control_file_var = tk.StringVar()
        self.control_file_combo = ttk.Combobox(row, textvariable=self.control_file_var, width=50, state="readonly")
        self.control_file_combo.pack(side=tk.LEFT, padx=(10, 10))
        ttk.Button(row, text="🔄 刷新文件列表", command=self.refresh_file_list).pack(side=tk.LEFT)

        # 控件搜索
        search_frame = ttk.LabelFrame(frame, text="🔍 搜索控件", padding="10")
        search_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(search_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="控件类型:").pack(side=tk.LEFT)
        self.control_type_var = tk.StringVar(value="Button")
        ttk.Combobox(row1, textvariable=self.control_type_var, width=15, state="readonly",
                     values=["Button", "Text", "Image", "TextField", "ScrollView", "List", "VStack", "HStack", "ZStack", "Spacer", "Divider", "所有"]).pack(side=tk.LEFT, padx=(10, 20))
        ttk.Label(row1, text="包含文字:").pack(side=tk.LEFT)
        self.control_text_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.control_text_var, width=25).pack(side=tk.LEFT, padx=(10, 10))
        ttk.Button(row1, text="🔍 搜索", command=self.search_controls).pack(side=tk.LEFT)

        # 控件列表
        list_frame = ttk.LabelFrame(frame, text="📋 找到的控件（双击查看位置）", padding="10")
        list_frame.pack(fill=tk.BOTH, expand=True)

        self.control_tree = ttk.Treeview(list_frame, columns=("line", "type", "content"), show="headings", height=10)
        self.control_tree.heading("line", text="行号")
        self.control_tree.heading("type", text="类型")
        self.control_tree.heading("content", text="内容")
        self.control_tree.column("line", width=60)
        self.control_tree.column("type", width=100)
        self.control_tree.column("content", width=500)
        self.control_tree.pack(fill=tk.BOTH, expand=True)
        self.control_tree.bind("<Double-1>", self.on_control_double_click)

        # 快速修改
        mod_frame = ttk.LabelFrame(frame, text="✏️ 快速修改选中控件", padding="10")
        mod_frame.pack(fill=tk.X, pady=(10, 0))

        row1 = ttk.Frame(mod_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="字体大小:").pack(side=tk.LEFT)
        self.mod_font_size_var = tk.StringVar(value="20")
        ttk.Entry(row1, textvariable=self.mod_font_size_var, width=8).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="字体粗细:").pack(side=tk.LEFT)
        self.mod_font_weight_var = tk.StringVar(value="bold")
        ttk.Combobox(row1, textvariable=self.mod_font_weight_var, width=10, state="readonly",
                     values=["regular", "bold", "semibold", "heavy", "light"]).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="前景色:").pack(side=tk.LEFT)
        self.mod_color_var = tk.StringVar(value=".white")
        ttk.Entry(row1, textvariable=self.mod_color_var, width=15).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(row1, text="应用修改", command=self.apply_control_mod).pack(side=tk.LEFT)

    def refresh_file_list(self):
        files = list(self.local_files.keys())
        if not files:
            # 如果没有加载本地文件，尝试从配置目录加载
            local_path = self.config['project']['local_path']
            tvos_path = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep))
            if os.path.exists(tvos_path):
                files = [f for f in os.listdir(tvos_path) if f.endswith('.swift')]
        self.control_file_combo['values'] = files
        if files:
            self.control_file_combo.current(0)
        self.log(f"文件列表已刷新，共 {len(files)} 个文件")

    def get_file_content(self, filename):
        if filename in self.local_files:
            return self.local_files[filename]
        local_path = self.config['project']['local_path']
        filepath = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep), filename)
        if os.path.exists(filepath):
            with open(filepath, 'r', encoding='utf-8') as f:
                return f.read()
        return ""

    def search_controls(self):
        filename = self.control_file_var.get()
        if not filename:
            messagebox.showwarning("提示", "请先选择文件")
            return

        content = self.get_file_content(filename)
        if not content:
            messagebox.showerror("错误", "文件内容为空，请先加载本地源码")
            return

        ctrl_type = self.control_type_var.get()
        search_text = self.control_text_var.get()

        for item in self.control_tree.get_children():
            self.control_tree.delete(item)

        lines = content.split('\n')
        count = 0
        for i, line in enumerate(lines, 1):
            # 匹配控件类型
            type_match = False
            if ctrl_type == "所有":
                type_match = any(kw in line for kw in ['Button(', 'Text(', 'Image(', 'TextField(', 'ScrollView', 'List(', 'VStack', 'HStack', 'ZStack'])
            else:
                type_match = f"{ctrl_type}(" in line or ctrl_type in line

            # 匹配文字
            text_match = True
            if search_text:
                text_match = search_text in line

            if type_match and text_match:
                # 提取类型
                found_type = ctrl_type
                for t in ['Button', 'Text', 'Image', 'TextField', 'ScrollView', 'List', 'VStack', 'HStack', 'ZStack']:
                    if f"{t}(" in line:
                        found_type = t
                        break
                self.control_tree.insert("", tk.END, values=(i, found_type, line.strip()[:100]))
                count += 1

        self.log(f"在 {filename} 中找到 {count} 个控件", "success")

    def on_control_double_click(self, event):
        selection = self.control_tree.selection()
        if not selection:
            return
        item = self.control_tree.item(selection[0])
        line_num = item['values'][0]
        filename = self.control_file_var.get()
        content = self.get_file_content(filename)
        lines = content.split('\n')

        # 显示上下文
        start = max(0, line_num - 3)
        end = min(len(lines), line_num + 3)
        context = ""
        for i in range(start, end):
            marker = "👉 " if i == line_num - 1 else "   "
            context += f"{marker}{i+1}: {lines[i]}\n"

        self.log(f"定位到 {filename} 第 {line_num} 行", "info")
        messagebox.showinfo("控件位置", f"文件: {filename}\n行号: {line_num}\n\n上下文:\n{context}")

    def apply_control_mod(self):
        filename = self.control_file_var.get()
        if not filename:
            messagebox.showwarning("提示", "请先选择文件")
            return

        selection = self.control_tree.selection()
        if not selection:
            messagebox.showwarning("提示", "请先在列表中选择一个控件")
            return

        item = self.control_tree.item(selection[0])
        line_num = int(item['values'][0])
        font_size = self.mod_font_size_var.get()
        font_weight = self.mod_font_weight_var.get()
        color = self.mod_color_var.get()

        content = self.get_file_content(filename)
        lines = content.split('\n')

        if line_num > len(lines):
            messagebox.showerror("错误", "行号超出范围")
            return

        old_line = lines[line_num - 1]
        # 在控件后添加修饰符
        new_modifiers = f".font(.system(size: {font_size}, weight: .{font_weight}))\n.foregroundColor({color})"

        # 简单替换：在该行末尾添加
        # 实际项目中需要更智能的修改，这里做演示
        self.log(f"准备修改 {filename} 第 {line_num} 行", "modify")
        self.log(f"原内容: {old_line.strip()[:80]}", "modify")
        self.log(f"添加: {new_modifiers}", "modify")

        # 记录修改历史
        self.mod_history.append({
            'time': time.strftime('%Y-%m-%d %H:%M:%S'),
            'file': filename,
            'line': line_num,
            'old': old_line,
            'modifiers': new_modifiers
        })

        messagebox.showinfo("修改已记录", f"修改已记录到历史！\n\n文件: {filename}\n行号: {line_num}\n\n注意：这是演示模式。\n实际修改请使用「代码编辑」标签页手动修改，\n或使用「快速修改」标签页的批量模板。")

    # ============================================================
    # 5. 参数调整标签页
    # ============================================================
    def build_param_tab(self):
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🎨 参数调整")

        # 全局字体
        font_frame = ttk.LabelFrame(frame, text="🔤 全局字体调整", padding="10")
        font_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(font_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="字体放大倍数:").pack(side=tk.LEFT)
        self.param_font_scale_var = tk.DoubleVar(value=1.2)
        ttk.Scale(row1, from_=0.5, to=3.0, variable=self.param_font_scale_var, orient=tk.HORIZONTAL, length=200).pack(side=tk.LEFT, padx=(10, 10))
        self.param_font_scale_label = ttk.Label(row1, text="1.2x")
        self.param_font_scale_label.pack(side=tk.LEFT)
        self.param_font_scale_var.trace_add('write', lambda *a: self.param_font_scale_label.config(text=f"{self.param_font_scale_var.get():.1f}x"))

        row2 = ttk.Frame(font_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Button(row2, text="🔍 预览所有字体大小", command=self.preview_font_sizes).pack(side=tk.LEFT, padx=2)
        ttk.Button(row2, text="✏️ 应用全局字体放大", command=self.apply_global_font).pack(side=tk.LEFT, padx=2)

        # 颜色主题
        color_frame = ttk.LabelFrame(frame, text="🎨 颜色主题调整", padding="10")
        color_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(color_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="背景色:").pack(side=tk.LEFT)
        self.param_bg_var = tk.StringVar(value="0x1a1a2e")
        ttk.Entry(row1, textvariable=self.param_bg_var, width=12).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="文字色:").pack(side=tk.LEFT)
        self.param_fg_var = tk.StringVar(value="0xffffff")
        ttk.Entry(row1, textvariable=self.param_fg_var, width=12).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="强调色:").pack(side=tk.LEFT)
        self.param_accent_var = tk.StringVar(value="0x007aff")
        ttk.Entry(row1, textvariable=self.param_accent_var, width=12).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(row1, text="应用颜色主题", command=self.apply_color_theme).pack(side=tk.LEFT)

        # 焦点效果
        focus_frame = ttk.LabelFrame(frame, text="🎯 焦点效果调整", padding="10")
        focus_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(focus_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="焦点框padding:").pack(side=tk.LEFT)
        self.param_focus_pad_var = tk.IntVar(value=2)
        ttk.Spinbox(row1, from_=0, to=10, textvariable=self.param_focus_pad_var, width=8).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="缩放比例:").pack(side=tk.LEFT)
        self.param_focus_scale_var = tk.DoubleVar(value=1.05)
        ttk.Spinbox(row1, from_=1.0, to=1.5, increment=0.01, textvariable=self.param_focus_scale_var, width=8).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="禁用系统焦点效果:").pack(side=tk.LEFT)
        self.param_focus_disable_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(row1, variable=self.param_focus_disable_var).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(row1, text="应用焦点设置", command=self.apply_focus_settings).pack(side=tk.LEFT)

        # 布局参数
        layout_frame = ttk.LabelFrame(frame, text="📐 布局参数调整", padding="10")
        layout_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(layout_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="键盘按键宽度:").pack(side=tk.LEFT)
        self.param_key_w_var = tk.IntVar(value=60)
        ttk.Spinbox(row1, from_=30, to=150, textvariable=self.param_key_w_var, width=8).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="键盘按键高度:").pack(side=tk.LEFT)
        self.param_key_h_var = tk.IntVar(value=60)
        ttk.Spinbox(row1, from_=30, to=150, textvariable=self.param_key_h_var, width=8).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="行高:").pack(side=tk.LEFT)
        self.param_row_h_var = tk.IntVar(value=50)
        ttk.Spinbox(row1, from_=20, to=200, textvariable=self.param_row_h_var, width=8).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(row1, text="应用布局参数", command=self.apply_layout_params).pack(side=tk.LEFT)

        # 动画参数
        anim_frame = ttk.LabelFrame(frame, text="✨ 动画参数调整", padding="10")
        anim_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(anim_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="动画时长(秒):").pack(side=tk.LEFT)
        self.param_anim_dur_var = tk.DoubleVar(value=0.3)
        ttk.Spinbox(row1, from_=0.0, to=2.0, increment=0.1, textvariable=self.param_anim_dur_var, width=8).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="控件隐藏延迟(秒):").pack(side=tk.LEFT)
        self.param_hide_delay_var = tk.DoubleVar(value=3.0)
        ttk.Spinbox(row1, from_=0.0, to=30.0, increment=0.5, textvariable=self.param_hide_delay_var, width=8).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(row1, text="应用动画参数", command=self.apply_anim_params).pack(side=tk.LEFT)

        # 结果显示
        result_frame = ttk.LabelFrame(frame, text="📄 调整结果", padding="10")
        result_frame.pack(fill=tk.BOTH, expand=True)
        self.param_result = scrolledtext.ScrolledText(result_frame, font=self.font_mono, height=6)
        self.param_result.pack(fill=tk.BOTH, expand=True)

    def preview_font_sizes(self):
        if not self.local_files:
            messagebox.showwarning("提示", "请先加载本地源码")
            return

        all_sizes = set()
        for filename, content in self.local_files.items():
            matches = re.findall(r'\.system\(size:\s*(\d+)', content)
            for m in matches:
                all_sizes.add(int(m))

        sizes = sorted(all_sizes)
        result = f"当前项目中使用的字体大小:\n{'='*50}\n"
        for s in sizes:
            count = sum(1 for c in self.local_files.values() if f'size: {s}' in c)
            scaled = int(s * self.param_font_scale_var.get())
            result += f"  {s:3d}pt (出现 {count:3d} 次)  →  放大后 {scaled:3d}pt\n"
        result += f"\n共 {len(sizes)} 种字体大小，{sum(1 for c in self.local_files.values() for _ in re.findall(r'size:', c))} 处使用"
        self.param_result.delete(1.0, tk.END)
        self.param_result.insert(tk.END, result)
        self.log(f"预览完成，共 {len(sizes)} 种字体大小", "success")

    def apply_global_font(self):
        if not self.local_files:
            messagebox.showwarning("提示", "请先加载本地源码")
            return
        if not messagebox.askyesno("确认", f"将所有字体放大 {self.param_font_scale_var.get():.1f} 倍？\n\n此操作会修改所有Swift文件，建议先备份！"):
            return

        scale = self.param_font_scale_var.get()
        total_changes = 0

        for filename, content in list(self.local_files.items()):
            def replace_font(m):
                nonlocal total_changes
                old_size = int(m.group(1))
                new_size = max(8, int(old_size * scale))
                total_changes += 1
                return f'.system(size: {new_size}'

            new_content = re.sub(r'\.system\(size:\s*(\d+)', replace_font, content)
            if new_content != content:
                self.local_files[filename] = new_content
                # 同时写入本地文件
                local_path = self.config['project']['local_path']
                filepath = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep), filename)
                if os.path.exists(filepath):
                    with open(filepath, 'w', encoding='utf-8') as f:
                        f.write(new_content)

        self.log(f"全局字体放大完成，共修改 {total_changes} 处", "modify")
        self.param_result.delete(1.0, tk.END)
        self.param_result.insert(tk.END, f"全局字体放大 {scale:.1f}x 完成！\n共修改 {total_changes} 处字体大小。\n\n修改已保存到本地文件。\n请在「构建提交」标签页提交并触发构建。")

    def apply_color_theme(self):
        self.log("颜色主题调整（演示模式）", "modify")
        self.param_result.delete(1.0, tk.END)
        self.param_result.insert(tk.END, f"""颜色主题设置：
背景色: {self.param_bg_var.get()}
文字色: {self.param_fg_var.get()}
强调色: {self.param_accent_var.get()}

注意：颜色主题需要修改Theme.swift文件。
请在「代码编辑」标签页中手动修改，
或使用「快速修改」标签页的颜色模板。
""")

    def apply_focus_settings(self):
        self.log("焦点设置调整（演示模式）", "modify")
        self.param_result.delete(1.0, tk.END)
        self.param_result.insert(tk.END, f"""焦点效果设置：
焦点框padding: {self.param_focus_pad_var.get()}px
缩放比例: {self.param_focus_scale_var.get()}
禁用系统焦点效果: {'是' if self.param_focus_disable_var.get() else '否'}

注意：焦点效果需要修改所有Button的修饰符。
推荐使用 TVTightButton 组件统一管理。
请在「代码编辑」标签页中修改 FullPages.swift。
""")

    def apply_layout_params(self):
        self.log("布局参数调整（演示模式）", "modify")
        self.param_result.delete(1.0, tk.END)
        self.param_result.insert(tk.END, f"""布局参数设置：
键盘按键宽度: {self.param_key_w_var.get()}
键盘按键高度: {self.param_key_h_var.get()}
行高: {self.param_row_h_var.get()}

注意：布局参数需要修改对应控件的frame。
请在「代码编辑」标签页中搜索并修改。
""")

    def apply_anim_params(self):
        self.log("动画参数调整（演示模式）", "modify")
        self.param_result.delete(1.0, tk.END)
        self.param_result.insert(tk.END, f"""动画参数设置：
动画时长: {self.param_anim_dur_var.get()}秒
控件隐藏延迟: {self.param_hide_delay_var.get()}秒

注意：动画参数需要修改withAnimation和Timer。
请在「代码编辑」标签页中搜索并修改。
""")

    # ============================================================
    # 6. 代码编辑标签页
    # ============================================================
    def build_code_tab(self):
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="📝 代码编辑")

        # 顶部工具栏
        toolbar = ttk.Frame(frame)
        toolbar.pack(fill=tk.X, pady=(0, 5))

        ttk.Label(toolbar, text="文件:").pack(side=tk.LEFT)
        self.code_file_var = tk.StringVar()
        self.code_file_combo = ttk.Combobox(toolbar, textvariable=self.code_file_var, width=45, state="readonly")
        self.code_file_combo.pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(toolbar, text="🔄 刷新", command=self.refresh_code_files).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="💾 保存", command=self.save_code_file).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="↩️ 撤销", command=self.undo_code).pack(side=tk.LEFT, padx=2)

        # 搜索替换
        search_frame = ttk.Frame(frame)
        search_frame.pack(fill=tk.X, pady=(0, 5))

        ttk.Label(search_frame, text="查找:").pack(side=tk.LEFT)
        self.code_find_var = tk.StringVar()
        ttk.Entry(search_frame, textvariable=self.code_find_var, width=25).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(search_frame, text="查找下一个", command=self.code_find_next).pack(side=tk.LEFT, padx=2)

        ttk.Label(search_frame, text="替换:").pack(side=tk.LEFT, padx=(20, 0))
        self.code_replace_var = tk.StringVar()
        ttk.Entry(search_frame, textvariable=self.code_replace_var, width=25).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(search_frame, text="替换", command=self.code_replace_one).pack(side=tk.LEFT, padx=2)
        ttk.Button(search_frame, text="全部替换", command=self.code_replace_all).pack(side=tk.LEFT, padx=2)

        # 行号显示
        editor_frame = ttk.Frame(frame)
        editor_frame.pack(fill=tk.BOTH, expand=True)

        self.code_linenumbers = tk.Text(editor_frame, width=5, bg="#2d2d2d", fg="#888888", font=self.font_mono, state=tk.DISABLED)
        self.code_linenumbers.pack(side=tk.LEFT, fill=tk.Y)

        self.code_editor = scrolledtext.ScrolledText(editor_frame, font=self.font_mono, bg="#1e1e1e", fg="#d4d4d4", insertbackground="white")
        self.code_editor.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.code_editor.bind('<KeyRelease>', self.update_line_numbers)
        self.code_editor.bind('<MouseWheel>', self.update_line_numbers)

        # 底部状态栏
        status_frame = ttk.Frame(frame)
        status_frame.pack(fill=tk.X, pady=(5, 0))
        self.code_status_var = tk.StringVar(value="就绪")
        ttk.Label(status_frame, textvariable=self.code_status_var).pack(side=tk.LEFT)

        self.code_undo_stack = []

    def refresh_code_files(self):
        files = list(self.local_files.keys())
        if not files:
            local_path = self.config['project']['local_path']
            tvos_path = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep))
            if os.path.exists(tvos_path):
                files = [f for f in os.listdir(tvos_path) if f.endswith('.swift')]
        self.code_file_combo['values'] = files
        if files:
            self.code_file_combo.current(0)
            self.load_code_file()
        self.log(f"代码文件列表已刷新，共 {len(files)} 个文件")

    def load_code_file(self):
        filename = self.code_file_var.get()
        if not filename:
            return
        content = self.get_file_content(filename)
        self.code_editor.delete(1.0, tk.END)
        self.code_editor.insert(tk.END, content)
        self.update_line_numbers()
        self.code_status_var.set(f"已加载: {filename} ({len(content)} 字符)")
        self.log(f"加载代码文件: {filename}", "success")

    def save_code_file(self):
        filename = self.code_file_var.get()
        if not filename:
            messagebox.showwarning("提示", "请先选择文件")
            return
        content = self.code_editor.get(1.0, tk.END)
        self.local_files[filename] = content

        local_path = self.config['project']['local_path']
        filepath = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep), filename)
        if os.path.exists(os.path.dirname(filepath)):
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            self.log(f"代码文件已保存: {filename}", "success")
            self.code_status_var.set(f"已保存: {filename} ({time.strftime('%H:%M:%S')})")
            messagebox.showinfo("保存成功", f"文件已保存:\n{filepath}")
        else:
            self.log(f"保存路径不存在: {filepath}", "warning")
            messagebox.showwarning("路径不存在", f"本地路径不存在:\n{filepath}\n\n请先在「配置」中设置正确的本地源码目录。")

    def undo_code(self):
        if self.code_undo_stack:
            content = self.code_undo_stack.pop()
            self.code_editor.delete(1.0, tk.END)
            self.code_editor.insert(tk.END, content)
            self.update_line_numbers()
            self.log("已撤销", "info")
        else:
            self.log("没有可撤销的操作", "warning")

    def update_line_numbers(self, event=None):
        line_count = self.code_editor.get(1.0, tk.END).count('\n')
        numbers = '\n'.join(str(i) for i in range(1, line_count + 1))
        self.code_linenumbers.config(state=tk.NORMAL)
        self.code_linenumbers.delete(1.0, tk.END)
        self.code_linenumbers.insert(tk.END, numbers)
        self.code_linenumbers.config(state=tk.DISABLED)

    def code_find_next(self):
        find_text = self.code_find_var.get()
        if not find_text:
            return
        # 保存当前内容到撤销栈
        self.code_undo_stack.append(self.code_editor.get(1.0, tk.END))
        pos = self.code_editor.search(find_text, self.code_editor.index(tk.INSERT), stopindex=tk.END)
        if not pos:
            pos = self.code_editor.search(find_text, "1.0", stopindex=tk.END)
        if pos:
            end = f"{pos}+{len(find_text)}c"
            self.code_editor.tag_remove('sel', '1.0', tk.END)
            self.code_editor.tag_add('sel', pos, end)
            self.code_editor.mark_set(tk.INSERT, end)
            self.code_editor.see(pos)
            self.code_status_var.set(f"找到: {find_text} @ {pos}")
        else:
            self.code_status_var.set(f"未找到: {find_text}")

    def code_replace_one(self):
        find_text = self.code_find_var.get()
        replace_text = self.code_replace_var.get()
        if not find_text:
            return
        self.code_undo_stack.append(self.code_editor.get(1.0, tk.END))
        content = self.code_editor.get(1.0, tk.END)
        if find_text in content:
            new_content = content.replace(find_text, replace_text, 1)
            self.code_editor.delete(1.0, tk.END)
            self.code_editor.insert(tk.END, new_content)
            self.update_line_numbers()
            self.log(f"已替换1处: {find_text} → {replace_text}", "modify")
            self.code_status_var.set(f"已替换1处")
        else:
            self.code_status_var.set("未找到匹配内容")

    def code_replace_all(self):
        find_text = self.code_find_var.get()
        replace_text = self.code_replace_var.get()
        if not find_text:
            return
        count = self.code_editor.get(1.0, tk.END).count(find_text)
        if count == 0:
            self.code_status_var.set("未找到匹配内容")
            return
        if not messagebox.askyesno("确认", f"将替换 {count} 处:\n{find_text}\n→\n{replace_text}"):
            return
        self.code_undo_stack.append(self.code_editor.get(1.0, tk.END))
        content = self.code_editor.get(1.0, tk.END)
        new_content = content.replace(find_text, replace_text)
        self.code_editor.delete(1.0, tk.END)
        self.code_editor.insert(tk.END, new_content)
        self.update_line_numbers()
        self.log(f"已全部替换 {count} 处", "modify")
        self.code_status_var.set(f"已替换 {count} 处")

    # ============================================================
    # 7. 快速修改标签页
    # ============================================================
    def build_quick_tab(self):
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="⚡ 快速修改")

        # 模板列表
        list_frame = ttk.LabelFrame(frame, text="📋 常用修改模板", padding="10")
        list_frame.pack(fill=tk.BOTH, expand=True)

        self.quick_tree = ttk.Treeview(list_frame, columns=("name", "desc", "files"), show="headings", height=12)
        self.quick_tree.heading("name", text="模板名称")
        self.quick_tree.heading("desc", text="说明")
        self.quick_tree.heading("files", text="影响文件")
        self.quick_tree.column("name", width=150)
        self.quick_tree.column("desc", width=350)
        self.quick_tree.column("files", width=200)
        self.quick_tree.pack(fill=tk.BOTH, expand=True)

        # 添加模板
        templates = [
            ("全局字体放大1.5倍", "将所有.system(size: X)中的X放大1.5倍", "所有Swift文件"),
            ("键盘按键加大1.2倍", "将FullPages.swift中键盘按键frame放大1.2倍", "FullPages.swift"),
            ("禁用所有系统焦点效果", "给所有Button添加.focusEffectDisabled()", "所有Swift文件"),
            ("歌曲行高加大到80", "将所有SongRow的行高从默认改为80", "Components.swift"),
            ("歌词字体加大到40", "将歌词显示的字体大小改为40", "FullPlayerView.swift"),
            ("控件隐藏延迟改为5秒", "将控件自动隐藏的Timer改为5秒", "FullPlayerView.swift"),
            ("背景色改为深色", "将所有Color(hex: 0x1a1a2e)统一为深色主题", "所有Swift文件"),
            ("添加TVTightButton组件", "在FullPages.swift中添加统一焦点按钮组件", "FullPages.swift"),
        ]
        for t in templates:
            self.quick_tree.insert("", tk.END, values=t)

        # 操作按钮
        btn_frame = ttk.Frame(frame)
        btn_frame.pack(fill=tk.X, pady=(10, 0))
        ttk.Button(btn_frame, text="▶️ 应用选中模板", command=self.apply_quick_mod, width=20).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="📝 查看模板代码", command=self.view_quick_code, width=20).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="➕ 添加自定义模板", command=self.add_custom_template, width=20).pack(side=tk.LEFT, padx=5)

        # 自定义模板
        custom_frame = ttk.LabelFrame(frame, text="✏️ 自定义修改（正则表达式）", padding="10")
        custom_frame.pack(fill=tk.BOTH, pady=(10, 0))

        row1 = ttk.Frame(custom_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="查找(正则):").pack(side=tk.LEFT)
        self.custom_find_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.custom_find_var, width=40).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Label(row1, text="替换为:").pack(side=tk.LEFT)
        self.custom_replace_var = tk.StringVar()
        ttk.Entry(row1, textvariable=self.custom_replace_var, width=40).pack(side=tk.LEFT, padx=(5, 10))

        row2 = ttk.Frame(custom_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Label(row2, text="目标文件:").pack(side=tk.LEFT)
        self.custom_files_var = tk.StringVar(value="所有Swift文件")
        ttk.Combobox(row2, textvariable=self.custom_files_var, width=30, state="readonly",
                     values=["所有Swift文件", "FullPages.swift", "ContentView.swift", "Panels.swift", "Components.swift", "PlayerView.swift", "FullPlayerView.swift", "Theme.swift"]).pack(side=tk.LEFT, padx=(5, 20))
        ttk.Button(row2, text="🔍 预览匹配数", command=self.preview_custom_mod).pack(side=tk.LEFT, padx=2)
        ttk.Button(row2, text="✏️ 执行替换", command=self.execute_custom_mod).pack(side=tk.LEFT, padx=2)

    def apply_quick_mod(self):
        selection = self.quick_tree.selection()
        if not selection:
            messagebox.showwarning("提示", "请先选择一个模板")
            return
        item = self.quick_tree.item(selection[0])
        name = item['values'][0]
        if not messagebox.askyesno("确认", f"应用模板: {name}\n\n此操作会修改文件，建议先备份！"):
            return
        self.log(f"应用模板: {name}", "modify")
        messagebox.showinfo("演示模式", f"模板「{name}」\n\n这是演示模式。\n实际修改请使用「自定义修改」区域，\n或在「代码编辑」中手动修改。")

    def view_quick_code(self):
        selection = self.quick_tree.selection()
        if not selection:
            return
        item = self.quick_tree.item(selection[0])
        name = item['values'][0]
        messagebox.showinfo("模板代码", f"模板: {name}\n\n实现代码示例（正则表达式）:\n\n查找: r'\\.system\\(size:\\s*(\\d+)'\n替换: lambda m: f'.system(size: {int(m.group(1))*1.5}'\n\n这是使用Python re模块进行批量替换的标准方式。")

    def add_custom_template(self):
        messagebox.showinfo("添加模板", "自定义模板功能开发中...\n\n目前可以使用下方「自定义修改」区域进行正则替换。")

    def preview_custom_mod(self):
        if not self.local_files:
            messagebox.showwarning("提示", "请先加载本地源码")
            return
        pattern = self.custom_find_var.get()
        if not pattern:
            messagebox.showwarning("提示", "请输入查找正则表达式")
            return

        target = self.custom_files_var.get()
        files_to_check = self.local_files.keys() if target == "所有Swift文件" else [target]

        total = 0
        result = f"预览匹配结果:\n{'='*50}\n"
        for filename in files_to_check:
            if filename not in self.local_files:
                continue
            content = self.local_files[filename]
            try:
                matches = re.findall(pattern, content)
                if matches:
                    result += f"  {filename}: {len(matches)} 处匹配\n"
                    total += len(matches)
            except re.error as e:
                result += f"  {filename}: 正则错误 - {e}\n"

        result += f"\n总计: {total} 处匹配"
        self.log(f"预览完成，共 {total} 处匹配", "success")
        messagebox.showinfo("预览结果", result)

    def execute_custom_mod(self):
        if not self.local_files:
            messagebox.showwarning("提示", "请先加载本地源码")
            return
        pattern = self.custom_find_var.get()
        replace = self.custom_replace_var.get()
        if not pattern:
            messagebox.showwarning("提示", "请输入查找正则表达式")
            return

        target = self.custom_files_var.get()
        files_to_mod = self.local_files.keys() if target == "所有Swift文件" else [target]

        # 先预览
        total = 0
        for filename in files_to_mod:
            if filename in self.local_files:
                total += len(re.findall(pattern, self.local_files[filename]))

        if total == 0:
            messagebox.showinfo("无匹配", "没有找到匹配内容")
            return

        if not messagebox.askyesno("确认", f"将在 {len([f for f in files_to_mod if f in self.local_files])} 个文件中替换 {total} 处？\n\n此操作不可撤销，建议先备份！"):
            return

        count = 0
        for filename in list(files_to_mod):
            if filename not in self.local_files:
                continue
            content = self.local_files[filename]
            try:
                new_content, n = re.subn(pattern, replace, content)
                if n > 0:
                    self.local_files[filename] = new_content
                    count += n
                    # 写入本地文件
                    local_path = self.config['project']['local_path']
                    filepath = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep), filename)
                    if os.path.exists(os.path.dirname(filepath)):
                        with open(filepath, 'w', encoding='utf-8') as f:
                            f.write(new_content)
                    self.log(f"修改 {filename}: {n} 处", "modify")
            except re.error as e:
                self.log(f"{filename} 正则错误: {e}", "error")

        self.log(f"自定义修改完成，共替换 {count} 处", "success")
        messagebox.showinfo("完成", f"自定义修改完成！\n共替换 {count} 处。\n\n修改已保存到本地文件。\n请在「构建提交」标签页提交并触发构建。")

    # ============================================================
    # 8. 构建提交标签页
    # ============================================================
    def build_build_tab(self):
        frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(frame, text="🚀 构建提交")

        # 提交信息
        commit_frame = ttk.LabelFrame(frame, text="📝 提交信息", padding="10")
        commit_frame.pack(fill=tk.X, pady=(0, 10))

        row1 = ttk.Frame(commit_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="提交标题:", width=10).pack(side=tk.LEFT)
        self.build_title_var = tk.StringVar(value="fix: tvOS调试修改")
        ttk.Entry(row1, textvariable=self.build_title_var, width=60).pack(side=tk.LEFT, padx=(5, 0))

        row2 = ttk.Frame(commit_frame)
        row2.pack(fill=tk.X, pady=2)
        ttk.Label(row1, text="详细说明:", width=10).pack(side=tk.LEFT)
        self.build_desc_var = tk.StringVar(value="通过tvOS调试工具箱进行的修改")
        ttk.Entry(row2, textvariable=self.build_desc_var, width=60).pack(side=tk.LEFT, padx=(5, 0))

        # 修改的文件列表
        files_frame = ttk.LabelFrame(frame, text="📋 待提交的修改文件", padding="10")
        files_frame.pack(fill=tk.BOTH, expand=True)

        self.build_files_tree = ttk.Treeview(files_frame, columns=("file", "status", "size"), show="headings", height=8)
        self.build_files_tree.heading("file", text="文件名")
        self.build_files_tree.heading("status", text="状态")
        self.build_files_tree.heading("size", text="大小")
        self.build_files_tree.column("file", width=300)
        self.build_files_tree.column("status", width=100)
        self.build_files_tree.column("size", width=100)
        self.build_files_tree.pack(fill=tk.BOTH, expand=True)

        # 操作按钮
        btn_frame = ttk.Frame(frame)
        btn_frame.pack(fill=tk.X, pady=(10, 0))

        row1 = ttk.Frame(btn_frame)
        row1.pack(fill=tk.X, pady=2)
        ttk.Button(row1, text="🔄 扫描本地修改", command=self.scan_local_changes, width=20).pack(side=tk.LEFT, padx=5)
        ttk.Button(row1, text="📤 提交到GitHub", command=self.commit_to_github, width=20).pack(side=tk.LEFT, padx=5)
        ttk.Button(row1, text="🚀 提交并触发tvOS构建", command=self.commit_and_build, width=25).pack(side=tk.LEFT, padx=5)

        # 构建状态
        build_status_frame = ttk.LabelFrame(frame, text="📊 构建状态", padding="10")
        build_status_frame.pack(fill=tk.BOTH, pady=(10, 0))

        self.build_status = scrolledtext.ScrolledText(build_status_frame, font=self.font_mono, height=6, bg="#0d0d0d", fg="#00ff00")
        self.build_status.pack(fill=tk.BOTH, expand=True)
        self.build_status.insert(tk.END, "等待操作...\n")

    def scan_local_changes(self):
        local_path = self.config['project']['local_path']
        if not local_path or not os.path.exists(local_path):
            messagebox.showwarning("提示", "请先配置本地源码目录")
            return

        tvos_path = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep))
        if not os.path.exists(tvos_path):
            messagebox.showerror("错误", f"未找到tvOS源码目录:\n{tvos_path}")
            return

        for item in self.build_files_tree.get_children():
            self.build_files_tree.delete(item)

        count = 0
        for f in os.listdir(tvos_path):
            if f.endswith('.swift'):
                filepath = os.path.join(tvos_path, f)
                size = os.path.getsize(filepath)
                mtime = os.path.getmtime(filepath)
                # 简单判断：修改时间在最近1小时内
                is_recent = (time.time() - mtime) < 3600
                status = "已修改" if is_recent else "未修改"
                self.build_files_tree.insert("", tk.END, values=(f, status, f"{size}B"))
                if is_recent:
                    count += 1

        self.log(f"扫描完成，发现 {count} 个最近修改的文件", "success")
        self.build_status.delete(1.0, tk.END)
        self.build_status.insert(tk.END, f"扫描完成: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        self.build_status.insert(tk.END, f"tvOS源码目录: {tvos_path}\n")
        self.build_status.insert(tk.END, f"Swift文件总数: {len(os.listdir(tvos_path))}\n")
        self.build_status.insert(tk.END, f"最近修改: {count} 个文件\n")

    def commit_to_github(self):
        if not self.config['github']['token']:
            messagebox.showwarning("提示", "请先配置GitHub Token")
            return

        local_path = self.config['project']['local_path']
        tvos_path = os.path.join(local_path, self.config['project']['tvos_path'].replace('/', os.sep))

        # 收集要提交的文件
        files_to_commit = []
        for f in os.listdir(tvos_path):
            if f.endswith('.swift'):
                files_to_commit.append(f)

        if not files_to_commit:
            messagebox.showinfo("无文件", "没有找到要提交的文件")
            return

        if not messagebox.askyesno("确认", f"将提交 {len(files_to_commit)} 个Swift文件到GitHub？\n\n提交信息: {self.build_title_var.get()}"):
            return

        def _do():
            try:
                self.log("开始提交到GitHub...", "command")
                H = self.github_headers()
                base = self.github_base()

                # 1. 获取最新commit
                r = requests.get(f'{base}/git/ref/heads/{self.config["github"]["branch"]}', headers=H, timeout=10)
                latest_sha = r.json()['object']['sha']
                self.log(f"最新commit: {latest_sha[:7]}")

                # 2. 获取base tree
                r = requests.get(f'{base}/git/commits/{latest_sha}', headers=H, timeout=10)
                base_tree = r.json()['tree']['sha']

                # 3. 创建blobs
                tree_items = []
                tvos_remote_path = self.config['project']['tvos_path']
                for filename in files_to_commit:
                    filepath = os.path.join(tvos_path, filename)
                    with open(filepath, 'rb') as f:
                        content = f.read()
                    b64 = base64.b64encode(content).decode()
                    r = requests.post(f'{base}/git/blobs', headers=H, json={'content': b64, 'encoding': 'base64'}, timeout=30)
                    blob_sha = r.json()['sha']
                    remote_path = f"{tvos_remote_path}/{filename}"
                    tree_items.append({'path': remote_path, 'mode': '100644', 'type': 'blob', 'sha': blob_sha})
                    self.log(f"  blob: {filename} ({len(content)}B)")

                # 4. 创建tree
                r = requests.post(f'{base}/git/trees', headers=H, json={'base_tree': base_tree, 'tree': tree_items}, timeout=30)
                new_tree = r.json()['sha']

                # 5. 创建commit
                message = f"{self.build_title_var.get()}\n\n{self.build_desc_var.get()}\n\n通过tvOS调试工具箱提交"
                r = requests.post(f'{base}/git/commits', headers=H, json={'message': message, 'tree': new_tree, 'parents': [latest_sha]}, timeout=30)
                new_commit = r.json()['sha']

                # 6. 更新ref
                r = requests.patch(f'{base}/git/refs/heads/{self.config["github"]["branch"]}', headers=H, json={'sha': new_commit, 'force': False}, timeout=10)

                self.log(f"提交成功! commit: {new_commit[:7]}", "success")
                self.build_status.delete(1.0, tk.END)
                self.build_status.insert(tk.END, f"✅ 提交成功!\n")
                self.build_status.insert(tk.END, f"Commit: {new_commit[:7]}\n")
                self.build_status.insert(tk.END, f"文件数: {len(files_to_commit)}\n")
                self.build_status.insert(tk.END, f"时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                messagebox.showinfo("提交成功", f"已提交到GitHub!\n\nCommit: {new_commit[:7]}\n文件数: {len(files_to_commit)}")

            except Exception as e:
                self.log(f"提交失败: {e}", "error")
                messagebox.showerror("提交失败", str(e))

        threading.Thread(target=_do, daemon=True).start()

    def commit_and_build(self):
        # 先提交
        self.commit_to_github()
        # 等待一下然后触发构建
        self.root.after(3000, lambda: self.github_trigger_build("build-tvos.yml"))


def main():
    root = tk.Tk()
    style = ttk.Style()
    try:
        style.theme_use('clam')
    except:
        pass
    app = TvOSToolbox(root)
    root.mainloop()


if __name__ == '__main__':
    main()
