'use strict';
// 书签整理助手 → 老内核兼容包一键构建（MV2）
// 运行：node build-legacy.js → 产出 ../BookmarkOrganizer-legacy-mv2.zip
// 适用：360 安全浏览器 / 360 极速浏览器 / 旧版 Edge / 其他不支持 MV3 的旧 Chromium 内核。
// 原理：以 manifest-mv2.json 为准打包；persistent 后台页常驻，长任务不受空闲回收限制。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = __dirname;
const STAGE = path.join(SRC, '..', '.mv2-build-bkmorg');
const ZIP = 'D:\\Softwares\\DataAnalysis\\R\\Rtools\\rtools45\\usr\\bin\\zip.exe';
const ZIP_OUT = path.join(SRC, '..', 'BookmarkOrganizer-legacy-mv2.zip');

// 1. staging（构建脚本与仓库元数据不进包）
fs.rmSync(STAGE, { recursive: true, force: true });
fs.cpSync(SRC, STAGE, { recursive: true });
for (const skip of ['.git', '.gitignore', 'build-firefox.js', 'build-chrome.js', 'build-legacy.js']) {
  fs.rmSync(path.join(STAGE, skip), { recursive: true, force: true });
}

// 2. MV2 清单覆盖 MV3（background.js 已兼容回调式 chrome.* 与后台页形态）
fs.copyFileSync(path.join(STAGE, 'manifest-mv2.json'), path.join(STAGE, 'manifest.json'));
fs.rmSync(path.join(STAGE, 'manifest-mv2.json'), { force: true });

// 3. 打包
fs.rmSync(ZIP_OUT, { force: true });
execFileSync(ZIP, ['-r', '-X', ZIP_OUT, '.'], { cwd: STAGE, stdio: 'ignore' });
fs.rmSync(STAGE, { recursive: true, force: true });
console.log('legacy mv2 zip: ' + ZIP_OUT);
