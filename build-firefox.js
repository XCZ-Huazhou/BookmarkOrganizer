'use strict';
// 书签整理助手 → Firefox 版一键构建
// 运行：node build-firefox.js → 直接产出可用 xpi 并自动部署到 Zen（若在运行请先关闭 Zen）
// 源码 background.js 已做 importScripts 双内核兼容（条件化），Firefox 后台页
// 由下方 scripts 数组按序加载 lib/sync-engine.js（共享全局作用域）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = __dirname;
const STAGE = path.join(SRC, '..', '.ff-build-bkmorg');
const ZIP = 'D:\\Softwares\\DataAnalysis\\R\\Rtools\\rtools45\\usr\\bin\\zip.exe';
const ZEN_EXT = 'D:\\Softwares\\DailyWork\\ZenBrowser\\Profile\\extensions';
const GECKO_ID = 'bookmark-organizer@cstai.local';
const XPI_OUT = path.join(SRC, '..', 'BookmarkOrganizer-firefox.xpi');

// 1. staging
fs.rmSync(STAGE, { recursive: true, force: true });
fs.cpSync(SRC, STAGE, { recursive: true });
// 仓库元数据与构建脚本不进包（Firefox 走 MV3 事件页，MV2 物料不进）
for (const skip of ['.git', '.gitignore', 'build-firefox.js', 'build-chrome.js', 'build-legacy.js', 'manifest-mv2.json']) {
  fs.rmSync(path.join(STAGE, skip), { recursive: true, force: true });
}

// 2. manifest 转换：service_worker → scripts 数组（前置依赖库）+ gecko id
// 依赖顺序必须与 background.js 的 importScripts 一致：
// browser-api（全局 BrowserAPI）→ organizer（全局 Organizer）→ sync-engine（全局 BookmarkSync）
const mPath = path.join(STAGE, 'manifest.json');
const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
m.background = {
  scripts: ['lib/browser-api.js', 'lib/organizer.js', 'lib/sync-engine.js', m.background.service_worker]
};
m.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: '115.0' } };
fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');

// 3. 打包 xpi
fs.rmSync(XPI_OUT, { force: true });
execFileSync(ZIP, ['-r', '-X', XPI_OUT, '.'], { cwd: STAGE, stdio: 'ignore' });

// 4. 部署到 Zen
if (fs.existsSync(path.join(ZEN_EXT, GECKO_ID + '.xpi'))) {
  try {
    fs.copyFileSync(XPI_OUT, path.join(ZEN_EXT, GECKO_ID + '.xpi'));
    console.log('已部署到 Zen profile，重启 Zen 生效。');
  } catch {
    console.log('部署失败：Zen 运行中锁定了文件，请关闭 Zen 后重跑本脚本。');
  }
} else {
  console.log('未检测到 Zen profile，跳过部署。');
}
console.log('xpi: ' + XPI_OUT);
