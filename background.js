/**
 * Background — 后台任务引擎（Chrome MV3 service worker / Firefox·Zen 事件页 双内核兼容）
 *
 * 能力：
 *  1. 死链检测：真并发 worker-pool（可关闭弹窗后台运行，进程被杀自动续跑）
 *  2. 通用后台任务：合并导入 / 全量排序 / 批量移动（弹窗只发指令，后台执行）
 *  3. 三重保活：20s API 心跳 + 0.5min 看门狗闹钟 + 秒级进度落盘
 *     - Chrome 对 idle 超过 ~30s 的 service worker 直接回收；
 *       心跳每 20s 调用一次扩展 API 重置 idle 计时器（fetch 本身不计入活动）；
 *       万一仍被回收，看门狗闹钟唤醒后从 storage 恢复续跑。
 *  4. 跨内核：Chrome 走 importScripts 加载依赖；Firefox/Zen 由 build-firefox.js
 *     生成的 manifest background.scripts 数组按相同顺序加载。
 */

// ==================== 双内核脚本加载 ====================

if (typeof importScripts === 'function') {
  try {
    // browser-api（全局 BrowserAPI）→ organizer（全局 Organizer）→ sync-engine（全局 BookmarkSync）
    importScripts('lib/browser-api.js', 'lib/organizer.js', 'lib/sync-engine.js');
  } catch (e) {
    self.__bgLoadError = 'background deps load failed: ' + (e && e.message || e);
    console.error(self.__bgLoadError);
  }
}

// ==================== 死链检测逻辑 ====================

const DeadLinkChecker = {
  _aborted: false,

  async checkOne(bookmark, timeout) {
    const result = {
      id: bookmark.id, title: bookmark.title, url: bookmark.url,
      path: bookmark.path, status: 'unknown', statusCode: null, error: null
    };

    if (!bookmark.url || !/^https?:\/\//i.test(bookmark.url)) {
      result.status = 'valid';
      result.error = '非HTTP协议，跳过检测';
      return result;
    }

    if (this._aborted) {
      result.status = 'unknown';
      result.error = '检测已中止';
      return result;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(bookmark.url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow'
      });

      clearTimeout(timer);

      if (response.ok) {
        result.status = 'valid';
        result.statusCode = response.status;
      } else if (response.status === 404) {
        result.status = 'dead';
        result.statusCode = 404;
      } else if (response.status >= 300 && response.status < 400) {
        result.status = 'redirect';
        result.statusCode = response.status;
      } else {
        result.status = 'valid';
        result.statusCode = response.status;
        result.error = `HTTP ${response.status}`;
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        result.status = 'timeout';
        result.error = '请求超时';
      } else {
        result.status = 'error';
        result.error = err.message || '网络错误';
      }
    }

    return result;
  },

  groupByStatus(results) {
    const groups = { valid: [], redirect: [], dead: [], timeout: [], error: [], unknown: [] };
    for (const r of results) {
      const key = groups[r.status] ? r.status : 'unknown';
      groups[key].push(r);
    }
    return groups;
  },

  abort() {
    this._aborted = true;
  },
  reset() {
    this._aborted = false;
  }
};

// ==================== 状态管理 ====================

let checkingState = {
  running: false,
  completed: 0,
  total: 0,
  results: null,
  bookmarks: null,
  config: null
};

// ==================== 保活 ====================

const KEEPALIVE_ALARM = 'deadlink-keepalive';
let heartbeatTimer = null;

function startKeepalive() {
  stopKeepalive();
  // 1) 20s 心跳：扩展 API 调用重置 service worker / 事件页的 idle 计时器
  heartbeatTimer = setInterval(() => {
    try {
      const p = chrome.runtime.getPlatformInfo();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }, 20000);
  // 2) 看门狗：Chrome 最小间隔 0.5min（Firefox 会钳到 1min，均合法）。
  //    若进程仍被回收，闹钟唤醒后由底部启动恢复逻辑自动续跑。
  try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch {}
}

function stopKeepalive() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try { chrome.alarms.clear(KEEPALIVE_ALARM); } catch {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // 唤醒本身即目的：冷启动时底部恢复逻辑会自动续跑未完成的检测
  if (alarm.name === KEEPALIVE_ALARM && checkingState.running) startKeepalive();
});

// ==================== 持久化（死链进度，双键拆分降低写入量） ====================
// meta 键：书签清单 + 配置（检测开始时写一次）
// results 键：已完成结果 + 游标（执行中节流写，进程被杀后由此续跑）

const DL_PARTIAL_META = 'deadlink-partial';
const DL_PARTIAL_RESULTS = 'deadlink-partial-results';
const DL_RESULTS = 'deadlink-results';

async function savePartialMeta(bookmarks, config, total) {
  try {
    await chrome.storage.local.set({ [DL_PARTIAL_META]: { bookmarks, config, total } });
  } catch {}
}

async function savePartialResults(results, completed) {
  try {
    await chrome.storage.local.set({ [DL_PARTIAL_RESULTS]: { results, completed } });
  } catch {}
}

async function clearPartialProgress() {
  try { await chrome.storage.local.remove([DL_PARTIAL_META, DL_PARTIAL_RESULTS]); } catch {}
}

// 兼容读取：新旧两种结构（旧版把 bookmarks/results 存同一键）
async function loadPartialProgress() {
  try {
    const data = await chrome.storage.local.get([DL_PARTIAL_META, DL_PARTIAL_RESULTS]);
    const meta = data[DL_PARTIAL_META];
    const pr = data[DL_PARTIAL_RESULTS];
    if (!meta) return null;
    if (Array.isArray(meta.results)) {
      // 旧版单键结构
      return { bookmarks: meta.bookmarks, config: meta.config, total: meta.total,
               results: meta.results || [], completed: meta.completed || 0 };
    }
    return { bookmarks: meta.bookmarks, config: meta.config, total: meta.total,
             results: (pr && pr.results) || [], completed: (pr && pr.completed) || 0 };
  } catch { return null; }
}

// ==================== 消息广播 ====================

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

function broadcastProgress() {
  broadcast({
    type: 'check-progress',
    completed: checkingState.completed,
    total: checkingState.total,
    running: checkingState.running
  });
}

// ==================== 死链消息协议 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'get-status':
      sendResponse({
        running: checkingState.running,
        completed: checkingState.completed,
        total: checkingState.total,
        hasResults: checkingState.results !== null
      });
      return false;

    case 'start-check':
      if (checkingState.running) {
        sendResponse({ ok: false, error: '检测正在进行中' });
        return false;
      }
      handleStartCheck(message.bookmarks, message.config, message.resumeFrom || 0, message.existingResults || []);
      sendResponse({ ok: true });
      return false;

    case 'stop-check': {
      DeadLinkChecker.abort();
      checkingState.running = false;
      stopKeepalive();
      clearPartialProgress(); // 关键：清掉续跑快照，防止进程下次被唤醒后又"复活"
      const generation = message.generation;
      (async () => {
        try {
          // 进程还活着：内存结果最准；否则退回 storage 里已落盘的结果
          let results = (checkingState.results && checkingState.results.length)
            ? checkingState.results
            : [];
          if (results.length === 0) {
            const saved = await chrome.storage.local.get(DL_RESULTS);
            results = saved[DL_RESULTS] || [];
          }
          if (results.length > 0) {
            await chrome.storage.local.set({
              [DL_RESULTS]: results,
              'deadlink-completed': results.length,
              'deadlink-total': checkingState.total || results.length
            });
          }
          broadcast({
            type: 'check-stopped',
            results,
            completed: results.length,
            total: checkingState.total || results.length,
            generation
          });
        } catch {}
      })();
      sendResponse({ ok: true });
      return false;
    }

    case 'get-results':
      if (checkingState.results) {
        sendResponse({ ok: true, results: checkingState.results });
      } else {
        sendResponse({ ok: false });
      }
      return false;

    default:
      break;
  }
  // job-* 消息在下方独立监听器处理
  return false;
});

// ==================== 死链执行（真并发 worker-pool） ====================

async function handleStartCheck(bookmarks, config, resumeFrom = 0, existingResults = []) {
  if (checkingState.running) return; // 防止恢复逻辑与 popup 启动竞争导致双跑
  DeadLinkChecker.reset();
  checkingState = {
    running: true,
    completed: resumeFrom,
    total: bookmarks.length,
    results: [...existingResults],
    bookmarks: bookmarks,
    config: config
  };
  startKeepalive();

  try {
    const concurrency = Math.max(1, Math.min(20, (config && config.deadLinkConcurrency) || 5));
    const timeout = (config && config.deadLinkTimeout) || 15000;
    const total = bookmarks.length;

    // 开始时落盘快照（书签清单 + 配置），此后只增量写结果键
    await savePartialMeta(bookmarks, config, total);
    if (resumeFrom > 0) await savePartialResults(checkingState.results, resumeFrom);
    broadcastProgress();

    let next = resumeFrom;
    let lastPersistAt = 0;
    let lastBroadcastAt = 0;

    const laneCount = Math.max(1, Math.min(concurrency, total - resumeFrom));
    const lanes = Array.from({ length: laneCount }, () => (async () => {
      while (!DeadLinkChecker._aborted) {
        const i = next++;
        if (i >= total) break;
        const r = await DeadLinkChecker.checkOne(bookmarks[i], timeout);
        checkingState.results.push(r);
        checkingState.completed = checkingState.results.length;

        const now = Date.now();
        // 3) 秒级落盘 + 节流广播：storage 写入本身也是 API 活动，参与保活
        if (now - lastPersistAt > 1000) {
          lastPersistAt = now;
          await savePartialResults(checkingState.results, checkingState.completed);
        }
        if (now - lastBroadcastAt > 250) {
          lastBroadcastAt = now;
          broadcastProgress();
        }
      }
    })());
    await Promise.all(lanes);

    if (DeadLinkChecker._aborted) {
      // 用户主动停止：收尾由 stop-check 分支负责，这里只清理现场
      checkingState.bookmarks = null;
      await clearPartialProgress();
      return;
    }

    const finalResults = checkingState.results;
    checkingState.running = false;
    checkingState.bookmarks = null;
    stopKeepalive();
    await clearPartialProgress();

    await chrome.storage.local.set({
      [DL_RESULTS]: finalResults,
      'deadlink-completed': checkingState.completed,
      'deadlink-total': checkingState.total
    });

    broadcast({
      type: 'check-done',
      results: finalResults,
      completed: checkingState.completed,
      total: checkingState.total
    });
  } catch (err) {
    checkingState.running = false;
    stopKeepalive();
    if (checkingState.results && checkingState.results.length > 0) {
      await savePartialResults(checkingState.results, checkingState.completed);
    }
    broadcast({ type: 'check-error', error: err.message });
  }
}

// ==================== 通用后台任务框架 ====================
// 任务全部幂等（重跑不会产生重复数据），进程被杀后由启动恢复逻辑自动重跑。

const JOB_KEY = 'bg-jobs';
const JOB_NAMES = ['merge-import', 'sort-all', 'move-bookmarks'];
let jobState = { running: {}, lastResult: {} };

async function loadJobState() {
  try {
    const data = await chrome.storage.local.get(JOB_KEY);
    if (data[JOB_KEY] && typeof data[JOB_KEY] === 'object') {
      jobState = { running: data[JOB_KEY].running || {}, lastResult: data[JOB_KEY].lastResult || {} };
    }
  } catch {}
}

async function persistJobState() {
  try { await chrome.storage.local.set({ [JOB_KEY]: jobState }); } catch {}
}

function jobProgressDefault(name) {
  if (name === 'merge-import') return { added: 0, skipped: 0, total: 0 };
  if (name === 'sort-all') return { foldersDone: 0, foldersTotal: 0 };
  if (name === 'move-bookmarks') return { moved: 0, total: 0, folders: 0, groupIndex: 0, groupCount: 0, groupName: '' };
  return {};
}

async function startJob(name, payload) {
  if (!JOB_NAMES.includes(name)) return { ok: false, error: '未知任务类型' };
  if (jobState.running[name]) return { ok: false, error: '该任务已在后台运行' };
  jobState.running[name] = { startedAt: Date.now(), progress: jobProgressDefault(name), payload };
  jobState.lastResult[name] = null;
  await persistJobState(); // 先落盘（含 payload），进程被杀后可恢复
  executeJob(name, payload);
  return { ok: true };
}

async function executeJob(name, payload) {
  let lastEmit = 0;
  const update = (patch) => {
    const entry = jobState.running[name];
    if (!entry) return;
    Object.assign(entry.progress, patch);
    const now = Date.now();
    if (now - lastEmit > 500) {
      lastEmit = now;
      persistJobState();
      broadcast({ type: 'job-progress', job: name, progress: entry.progress });
    }
  };

  try {
    const summary = await runJob(name, payload, update);
    delete jobState.running[name];
    jobState.lastResult[name] = { ok: true, at: Date.now(), summary };
    await persistJobState();
    broadcast({ type: 'job-done', job: name, summary });
  } catch (err) {
    delete jobState.running[name];
    const msg = (err && err.message) || String(err);
    jobState.lastResult[name] = { ok: false, at: Date.now(), error: msg };
    await persistJobState();
    broadcast({ type: 'job-error', job: name, error: msg });
  }
}

async function runJob(name, payload, update) {
  if (name === 'merge-import') return runMergeImportJob(payload, update);
  if (name === 'sort-all') return runSortJob(payload, update);
  if (name === 'move-bookmarks') return runMoveJob(payload, update);
  throw new Error('未知任务类型');
}

// ---- 合并导入：URL 去重幂等，中断后重跑等于续传 ----

async function runMergeImportJob(payload, update) {
  const nodes = payload.nodes || [];
  const targetId = payload.targetId;
  if (!targetId) throw new Error('缺少目标文件夹');

  const tree = await BrowserAPI.bookmarks.getTree();
  const existingUrls = new Set();
  (function collect(n) {
    if (!n) return;
    if (n.url) existingUrls.add(n.url.replace(/\/$/, ''));
    if (n.children) n.children.forEach(collect);
  })(tree && tree[0]);

  let total = payload.total || 0;
  if (!total) {
    (function cnt(list) {
      for (const n of list) {
        if (n.url) total++;
        else if (n.children) cnt(n.children);
      }
    })(nodes);
  }
  update({ total });

  const result = await Organizer.mergeImport(nodes, targetId, existingUrls, (added, skipped) => {
    update({ added, skipped });
  });
  return result;
}

// ---- 全量排序：排序收敛幂等，中断后重跑安全 ----

function countFolders(node, isRoot) {
  if (!node || node.url) return 0;
  let n = isRoot ? 0 : 1;
  if (node.children) for (const c of node.children) n += countFolders(c, false);
  return n;
}

async function runSortJob(payload, update) {
  const sortBy = payload.sortBy || 'title-asc';
  const tree = await BrowserAPI.bookmarks.getTree();
  const foldersTotal = countFolders(tree && tree[0], true);
  update({ foldersTotal, foldersDone: 0 });

  let done = 0;
  const count = await Organizer.sortRecursive(sortBy, () => {
    done++;
    update({ foldersDone: done });
  });
  return { moved: count, folders: foldersTotal };
}

// ---- 批量移动：按名查找/创建文件夹 + 移动，重复执行安全 ----

function findFolderByTitle(root, title) {
  if (!root) return null;
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur.url && cur.id !== root.id && (cur.title || '') === title) return cur;
    if (cur.children) for (const c of cur.children) queue.push(c);
  }
  return null;
}

async function runMoveJob(payload, update) {
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  let total = 0;
  for (const g of groups) total += (g.ids || []).length;
  update({ total, moved: 0, folders: 0, groupIndex: 0, groupCount: groups.length,
           groupName: groups[0] ? groups[0].name : '' });

  const tree = await BrowserAPI.bookmarks.getTree();
  const rootNode = tree && tree[0];
  let moved = 0, folders = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const name = g.name || '未命名';
    let targetId = g.targetId || null;
    if (!targetId) {
      const found = findFolderByTitle(rootNode, name);
      if (found) {
        targetId = found.id;
      } else {
        const parentId = await BrowserAPI.getDefaultParentId();
        const made = await BrowserAPI.bookmarks.create({ parentId, title: name });
        targetId = made.id;
        folders++;
      }
    }
    update({ groupName: name, groupIndex: gi + 1 });

    for (const id of (g.ids || [])) {
      try {
        const got = await BrowserAPI.bookmarks.get(id);
        const bm = got && got[0];
        if (bm && bm.parentId !== targetId) {
          await BrowserAPI.bookmarks.move(id, { parentId: targetId });
          moved++;
        }
      } catch {}
      update({ moved });
    }
  }
  return { moved, folders };
}

// ---- 后台任务消息 ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || message.type.indexOf('job-') !== 0) return false;
  if (message.type === 'job-start') {
    startJob(message.job, message.payload || {})
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // 异步应答
  }
  if (message.type === 'job-status') {
    sendResponse({ ok: true, running: jobState.running, lastResult: jobState.lastResult });
    return false;
  }
  if (message.type === 'job-clear-result') {
    const name = message.job;
    if (name && jobState.lastResult[name]) {
      delete jobState.lastResult[name];
      persistJobState();
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ==================== 启动恢复（冷启动 / 被杀后被闹钟唤醒） ====================

(async () => {
  await loadJobState();
  // 恢复中断的后台任务（幂等：合并导入按 URL 去重、排序收敛、移动去重）
  for (const name of Object.keys(jobState.running)) {
    const entry = jobState.running[name];
    if (entry && entry.payload) executeJob(name, entry.payload);
  }

  // 恢复中断的死链检测
  const partial = await loadPartialProgress();
  if (partial && partial.bookmarks && partial.completed < partial.total) {
    handleStartCheck(partial.bookmarks, partial.config, partial.completed, partial.results || []);
  }
})();
