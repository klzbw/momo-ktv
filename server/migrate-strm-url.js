#!/usr/bin/env node
/**
 * STRM 文件迁移脚本（P0 安全修复配套）
 *
 * 将已有的 .strm 文件从旧格式迁移到新格式：
 *   旧: http://admin:admin123@192.168.3.16:5345/dav/云盘/.../文件.flac
 *   新: http://192.168.3.16:5345/d/云盘/.../文件.flac
 *
 * 变更点：
 *   1. 移除 URL 中的明文管理员密码 (admin:admin123@)
 *   2. WebDAV 端点 /dav/ 改为直链端点 /d/
 *
 * 使用方法（在容器内执行）：
 *   node /app/server/migrate-strm-url.js [strm目录]
 *   默认目录: /data/netseparated-strm
 *
 * 前置条件：Alist 后台已开启「允许匿名访问」，访客角色勾选「可以访问」和「可以下载」。
 */

const fs = require('fs');
const path = require('path');

const STRM_DIR = process.argv[2] || '/data/netseparated-strm';

function migrateStrmFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { changed: false, error: '读取失败: ' + e.message };
  }

  const original = content;

  // 1. 移除明文密码: http://admin:admin123@host -> http://host
  //    兼容各种可能的用户名/密码组合
  content = content.replace(/(https?:\/\/)[^@\s\/]+@/g, '$1');

  // 2. /dav/ 端点改为 /d/ 端点
  //    匹配 :port/dav/ 或 /dav/ 后面跟编码路径的情况
  content = content.replace(/(\/dav)(\/|%2F)/gi, '/d$2');

  if (content === original) {
    return { changed: false, reason: '已是新格式或不匹配' };
  }

  try {
    fs.writeFileSync(filePath, content);
    return { changed: true };
  } catch (e) {
    return { changed: false, error: '写入失败: ' + e.message };
  }
}

function main() {
  if (!fs.existsSync(STRM_DIR)) {
    console.error('目录不存在:', STRM_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(STRM_DIR).filter(f => f.endsWith('.strm'));
  console.log(`找到 ${files.length} 个 .strm 文件，开始迁移...`);

  let changed = 0;
  let skipped = 0;
  let errors = 0;

  for (const f of files) {
    const result = migrateStrmFile(path.join(STRM_DIR, f));
    if (result.changed) {
      changed++;
    } else if (result.error) {
      errors++;
      console.warn(`  [错误] ${f}: ${result.error}`);
    } else {
      skipped++;
    }
  }

  console.log(`\n迁移完成:`);
  console.log(`  已更新: ${changed}`);
  console.log(`  已跳过(已是新格式): ${skipped}`);
  console.log(`  错误: ${errors}`);

  if (changed > 0) {
    console.log(`\n提示: 迁移后建议重启 momo-ktv 服务以清除可能的 URL 缓存。`);
    console.log(`      确认 Alist 已开启匿名访问（设置 -> 允许匿名访问）。`);
  }
}

main();
