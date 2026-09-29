'use strict';
// 书签整理助手 → Chrome 包一键构建
// 运行：node build-chrome.js → 产出 ../BookmarkOrganizer-chrome.zip（解压后加载已解压扩展即用）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = __dirname;
const STAGE = path.join(SRC, '..', '.chrome-build-bkmorg');
const ZIP = 'D:\\Softwares\\DataAnalysis\\R\\Rtools\\rtools45\\usr\\bin\\zip.exe';
const ZIP_OUT = path.join(SRC, '..', 'BookmarkOrganizer-chrome.zip');

// 1. staging（构建脚本与仓库元数据不进包；Chrome 包用 MV3 清单，MV2 物料不进）
fs.rmSync(STAGE, { recursive: true, force: true });
fs.cpSync(SRC, STAGE, { recursive: true });
for (const skip of ['.git', '.gitignore', 'build-firefox.js', 'build-chrome.js', 'build-legacy.js', 'manifest-mv2.json']) {
  fs.rmSync(path.join(STAGE, skip), { recursive: true, force: true });
}

// 2. 打包
fs.rmSync(ZIP_OUT, { force: true });
execFileSync(ZIP, ['-r', '-X', ZIP_OUT, '.'], { cwd: STAGE, stdio: 'ignore' });
fs.rmSync(STAGE, { recursive: true, force: true });
console.log('chrome zip: ' + ZIP_OUT);
