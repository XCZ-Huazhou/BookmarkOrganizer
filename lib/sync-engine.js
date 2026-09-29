/**
 * 跨平台书签同步引擎（WebDAV 通道）
 * - 自包含模块：service worker 与设置页均可使用（不依赖 browser-api.js）
 * - 三种模式：merge（双向合并，按 URL 并集，不传播删除）/ upload（上传覆盖云端）/ download（下载覆盖本地）
 * - 云端文件：<serverUrl>/<remoteDir>/bookmarks.json
 * - 兼容坚果云等标准 WebDAV 服务
 */
(function () {
  'use strict';

  const rawApi = globalThis.browser || globalThis.chrome;
  if (!rawApi || !rawApi.bookmarks) {
    throw new Error('BookmarkSync: browser bookmarks API not found');
  }

  // ==================== 常量 ====================

  const CONFIG_KEY = 'sync-config';
  const STATE_KEY = 'sync-state';
  const FILE_NAME = 'bookmarks.json';
  const CONTAINER_FOLDER = '书签同步';
  const FORMAT_ID = 'bookmark-organizer-sync';
  const FORMAT_VERSION = 1;

  // 顶层根目录名（不同浏览器叫法不同），存云端时剥离
  const ROOT_NAME_RE =
    /^(书签栏|其他书签|收藏夹栏|移动设备书签|bookmarks bar|bookmarks menu|other bookmarks|mobile bookmarks)$/i;

  const DEFAULT_CONFIG = {
    serverUrl: '',
    username: '',
    password: '',
    remoteDir: '书签同步',
    deviceName: '',
    autoSync: false,
    intervalMin: 30
  };

  const ALARM_NAME = 'bookmark-sync-auto';

  // ==================== 基础工具 ====================

  function b64auth(user, pass) {
    // btoa 对非 ASCII 会抛错，先转 UTF-8 字节
    const bytes = new TextEncoder().encode(user + ':' + pass);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return 'Basic ' + btoa(bin);
  }

  function normalizeServer(url) {
    let s = (url || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s.replace(/\/+$/, '') + '/';
  }

  function joinUrl(server, dir, name) {
    const d = (dir || '').replace(/^\/+|\/+$/g, '');
    return normalizeServer(server) + (d ? d + '/' : '') + (name || '');
  }

  function normalizeKey(u) {
    if (!u || typeof u !== 'string') return '';
    try {
      const x = new URL(u);
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return 'raw:' + u;
      const host = x.host.toLowerCase();
      const path = x.pathname.replace(/\/+$/, '');
      return x.protocol + '//' + host + path + x.search;
    } catch (e) {
      return 'raw:' + u;
    }
  }

  function now() { return Date.now(); }

  function deviceLabel(config) {
    return (config.deviceName || '').trim() || '未命名设备';
  }

  // ==================== WebDAV 客户端 ====================

  const Webdav = {
    authHeaders(config) {
      return { Authorization: b64auth(config.username, config.password) };
    },

    async request(url, method, config, body, extraHeaders) {
      const headers = Object.assign(this.authHeaders(config), extraHeaders || {});
      const resp = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : body
      });
      return resp;
    },

    // 探测连接：PROPFIND 根路径，Depth 0
    async testConnection(config) {
      const url = normalizeServer(config.serverUrl);
      if (!url) throw new Error('服务器地址为空');
      const resp = await this.request(url, 'PROPFIND', config, undefined, { Depth: '0' });
      if (resp.status === 401) throw new Error('认证失败（401）：检查用户名/应用密码');
      if (!resp.ok && resp.status !== 207) throw new Error('服务器响应异常：HTTP ' + resp.status);
      return true;
    },

    // 逐级创建远程目录（已存在时 WebDAV 返回 405，视为成功）
    async ensureDir(config) {
      const dir = (config.remoteDir || '').replace(/^\/+|\/+$/g, '');
      if (!dir) return;
      const server = normalizeServer(config.serverUrl);
      const segs = dir.split('/');
      let cur = server;
      for (const seg of segs) {
        cur += seg + '/';
        const resp = await this.request(cur, 'MKCOL', config);
        if (!resp.ok && resp.status !== 405 && resp.status !== 301) {
          throw new Error('创建远程目录失败：HTTP ' + resp.status + ' @ ' + cur);
        }
      }
    },

    async getRemoteList(config) {
      const url = joinUrl(config.serverUrl, config.remoteDir, FILE_NAME);
      const resp = await this.request(url, 'GET', config);
      if (resp.status === 404) return null;
      if (resp.status === 401) throw new Error('认证失败（401）');
      if (!resp.ok) throw new Error('读取云端文件失败：HTTP ' + resp.status);
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        if (data.format !== FORMAT_ID) throw new Error('云端文件格式不识别（可能不是本插件的同步文件）');
        return data;
      } catch (e) {
        if (String(e.message || '').indexOf('格式') >= 0) throw e;
        throw new Error('云端文件损坏：' + e.message);
      }
    },

    async putRemoteList(config, list, deviceNote) {
      await this.ensureDir(config);
      const url = joinUrl(config.serverUrl, config.remoteDir, FILE_NAME);
      const payload = JSON.stringify({
        format: FORMAT_ID,
        version: FORMAT_VERSION,
        updatedAt: now(),
        updatedBy: deviceNote,
        count: list.length,
        bookmarks: list
      });
      const resp = await this.request(url, 'PUT', config, payload, { 'Content-Type': 'application/json; charset=utf-8' });
      if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
        throw new Error('上传云端失败：HTTP ' + resp.status);
      }
      return true;
    }
  };

  // ==================== 书签编解码 ====================

  const Codec = {
    // 本地书签树 → 云端扁平列表；跳过非 http(s) 书签；按 URL 去重（保留先出现者）
    treeToFlatList(tree) {
      const out = [];
      const seen = new Set();
      const skip = { skipped: 0 };
      function walkFolder(node, segments) {
        if (!node.children) return;
        for (const child of node.children) {
          if (child.url) {
            const key = normalizeKey(child.url);
            if (!key) continue;
            if (!/^https?:/i.test(child.url)) { skip.skipped++; continue; }
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              u: child.url,
              t: child.title || '',
              p: segments.slice(),          // 逻辑路径（已剥离根名）
              d: child.dateAdded || 0
            });
          } else {
            walkFolder(child, segments.concat(child.title));
          }
        }
      }
      if (tree && Array.isArray(tree.children)) {
        for (const root of tree.children) {
          // 根层书签（罕见）直接放入无路径列表
          if (root.url) {
            const key = normalizeKey(root.url);
            if (key && /^https?:/i.test(root.url) && !seen.has(key)) {
              seen.add(key);
              out.push({ u: root.url, t: root.title || '', p: [], d: root.dateAdded || 0 });
            }
            continue;
          }
          walkFolder(root, []);
        }
      }
      out.skipCount = skip.skipped;
      return out;
    },

    // 云端列表 → 本地缺失子集（本地已有 URL 不返回）
    missingFromLocal(cloudList, localKeySet) {
      return (cloudList || []).filter(item => item.u && !localKeySet.has(normalizeKey(item.u)));
    },

    // 本地列表补入云端列表（并集；不覆盖云端同名 URL）
    unionIntoCloud(cloudList, localList) {
      const cloudKeys = new Set((cloudList || []).map(i => normalizeKey(i.u)));
      const additions = (localList || []).filter(i => !cloudKeys.has(normalizeKey(i.u)));
      return { list: (cloudList || []).concat(additions), additions: additions.length };
    },

    localKeySet(tree) {
      const set = new Set();
      function walk(node) {
        if (node.url) set.add(normalizeKey(node.url));
        if (node.children) for (const c of node.children) walk(c);
      }
      if (tree) walk(tree);
      return set;
    },

    // 从本地书签树删除整层内容（下载覆盖用）
    async wipeLocalBookmarks() {
      const tree = await rawApi.bookmarks.getTree();
      const root = tree && tree[0];
      if (!root || !Array.isArray(root.children)) return;
      for (const child of root.children) {
        // removeTree 对文件夹；对散落的顶层 URL 书签用 remove
        if (child.url) {
          await rawApi.bookmarks.remove(child.id);
        } else {
          await rawApi.bookmarks.removeTree(child.id);
        }
      }
    },

    // 把云端列表写回本地：优先按云端路径首段映射到对应根目录，否则进「书签同步」容器
    async importCloudList(cloudList, mode) {
      const tree = await rawApi.bookmarks.getTree();
      const rootNode = tree && tree[0];
      if (!rootNode) throw new Error('无法读取本地书签根');

      const roots = (rootNode.children || []).filter(c => !c.url);
      const toolbarRoot = roots.find(r => ROOT_NAME_RE.test(r.title || '') && /bar|书签栏|收藏夹/i.test(r.title || ''));
      const otherRoot =
        roots.find(r => /^(其他书签|other bookmarks)$/i.test(r.title || '')) ||
        roots.find(r => !ROOT_NAME_RE.test(r.title || '')) ||
        roots[roots.length - 1] || rootNode;

      const folderCache = new Map(); // "rootId|seg1/seg2" -> folderId
      const keySet = new Set();

      async function ensureFolder(parentId, title) {
        const existing = await rawApi.bookmarks.getChildren(parentId);
        const hit = (existing || []).find(c => !c.url && c.title === title);
        if (hit) return hit.id;
        const made = await rawApi.bookmarks.create({ parentId, title });
        return made.id;
      }

      async function ensurePath(baseRootId, segments) {
        let cur = baseRootId;
        let chain = '';
        for (const seg of segments) {
          chain = chain ? chain + '/' + seg : seg;
          const cacheKey = baseRootId + '|' + chain;
          if (folderCache.has(cacheKey)) { cur = folderCache.get(cacheKey); continue; }
          cur = await ensureFolder(cur, seg);
          folderCache.set(cacheKey, cur);
        }
        return cur;
      }

      // 重建本地键集（覆盖模式下本地已清空，集合用于边建边防重）
      function collectKeys(node) {
        if (node.url) keySet.add(normalizeKey(node.url));
        if (node.children) for (const c of node.children) collectKeys(c);
      }
      collectKeys(rootNode);

      let created = 0;
      for (const item of (cloudList || [])) {
        const key = normalizeKey(item.u);
        if (!key || keySet.has(key)) continue;
        let segments = Array.isArray(item.p) ? item.p.filter(Boolean) : [];
        let baseRootId;
        if (mode === 'restore' && segments.length && ROOT_NAME_RE.test(segments[0])) {
          // 覆盖恢复：首段是根名 → 映射到真实根目录
          const first = segments[0];
          const matched = roots.find(r => (r.title || '').toLowerCase() === first.toLowerCase());
          baseRootId = (matched || toolbarRoot || otherRoot).id;
          segments = segments.slice(1);
        } else {
          // 合并模式：统一放进「书签同步」容器，保留子路径
          baseRootId = otherRoot.id;
          segments = [CONTAINER_FOLDER].concat(segments);
        }
        const parentId = segments.length ? await ensurePath(baseRootId, segments) : baseRootId;
        await rawApi.bookmarks.create({ parentId, title: item.t || item.u, url: item.u });
        keySet.add(key);
        created++;
      }
      return created;
    }
  };

  // ==================== 同步引擎 ====================

  const SyncEngine = {
    running: false,

    async getConfig() {
      const data = await rawApi.storage.local.get(CONFIG_KEY);
      return Object.assign({}, DEFAULT_CONFIG, data[CONFIG_KEY] || {});
    },

    async saveConfig(patch) {
      const config = Object.assign(await this.getConfig(), patch);
      await rawApi.storage.local.set({ [CONFIG_KEY]: config });
      return config;
    },

    async getState() {
      const data = await rawApi.storage.local.get(STATE_KEY);
      return data[STATE_KEY] || { lastSyncAt: 0, lastResult: null };
    },

    async setState(patch) {
      const state = Object.assign(await this.getState(), patch, { lastSyncAt: now() });
      await rawApi.storage.local.set({ [STATE_KEY]: state });
      return state;
    },

    validateConfig(config) {
      if (!config.serverUrl) throw new Error('请先填写服务器地址');
      if (!config.username || !config.password) throw new Error('请填写用户名和密码');
    },

    // mode: 'merge' | 'upload' | 'download'(=restore)
    async syncNow(mode) {
      if (this.running) throw new Error('同步正在进行中');
      const config = await this.getConfig();
      this.validateConfig(config);
      this.running = true;
      try {
        let summary;
        if (mode === 'upload') {
          summary = await this.doUpload(config);
        } else if (mode === 'download') {
          summary = await this.doDownload(config);
        } else {
          summary = await this.doMerge(config);
        }
        await this.setState({
          lastResult: { mode, ok: true, at: now(), summary }
        });
        return summary;
      } catch (err) {
        await this.setState({
          lastResult: { mode, ok: false, at: now(), error: err.message || String(err) }
        });
        throw err;
      } finally {
        this.running = false;
      }
    },

    async localSnapshot() {
      const tree = await rawApi.bookmarks.getTree();
      const rootNode = tree && tree[0];
      return { tree: rootNode, list: Codec.treeToFlatList(rootNode) };
    },

    async doMerge(config) {
      const remoteDoc = await Webdav.getRemoteList(config);
      const remoteList = remoteDoc ? remoteDoc.bookmarks || [] : [];
      const local = await this.localSnapshot();
      const localKeys = Codec.localKeySet(local.tree);

      // 方向一：云端有、本地没有 → 建到本地「书签同步」容器
      const pullItems = Codec.missingFromLocal(remoteList, localKeys);
      let pulled = 0;
      if (pullItems.length) {
        pulled = await Codec.importCloudList(remoteList, 'merge');
      }

      // 方向二：本地有、云端没有 → 并入云端列表
      const freshKeys = Codec.localKeySet(await rawApi.bookmarks.getTree().then(t => t[0]));
      const pushList = remoteList.slice();
      let pushed = 0;
      for (const item of local.list) {
        const key = normalizeKey(item.u);
        let existsRemotely = remoteList.some(r => normalizeKey(r.u) === key);
        if (!existsRemotely && freshKeys.has(key)) {
          pushList.push(item);
          pushed++;
        }
      }

      // 乐观锁：PUT 前复查云端是否被其他设备改动；若改动则基于最新云端重算一次
      const recheck = await Webdav.getRemoteList(config);
      let finalList = pushList;
      if (recheck && remoteDoc && recheck.updatedAt !== remoteDoc.updatedAt) {
        const keys = new Set(pushList.map(i => normalizeKey(i.u)));
        finalList = pushList.slice();
        for (const item of (recheck.bookmarks || [])) {
          if (!keys.has(normalizeKey(item.u))) finalList.push(item);
        }
      }
      await Webdav.putRemoteList(config, finalList, deviceLabel(config));

      return {
        pulled,
        pushed,
        cloudTotal: finalList.length,
        skippedLocal: local.list.skipCount || 0
      };
    },

    async doUpload(config) {
      const local = await this.localSnapshot();
      await Webdav.putRemoteList(config, local.list, deviceLabel(config) + '（覆盖上传）');
      return { uploaded: local.list.length, skippedLocal: local.list.skipCount || 0 };
    },

    async doDownload(config) {
      const remoteDoc = await Webdav.getRemoteList(config);
      if (!remoteDoc) throw new Error('云端还没有同步文件，请先执行一次合并或上传');
      const cloudList = remoteDoc.bookmarks || [];
      await Codec.wipeLocalBookmarks();
      const created = await Codec.importCloudList(cloudList, 'restore');
      return { restored: created, cloudTotal: cloudList.length };
    },

    // ==================== 自动同步 ====================

    async setupAutoSync() {
      try {
        const config = await this.getConfig();
        if (config.autoSync && config.serverUrl && config.username) {
          const minutes = Math.max(15, parseInt(config.intervalMin, 10) || 30);
          rawApi.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
        } else {
          rawApi.alarms.clear(ALARM_NAME);
        }
      } catch (e) { /* 忽略：配置未就绪 */ }
    },

    async runAutoSync() {
      try {
        const config = await this.getConfig();
        if (!config.autoSync || !config.serverUrl || !config.username) return;
        if (this.running) return;
        await this.syncNow('merge');
      } catch (e) {
        // 自动同步静默失败，仅记录
        try { await this.setState({ lastResult: { mode: 'auto', ok: false, at: now(), error: e.message } }); } catch (_) {}
      }
    }
  };

  if (rawApi.alarms && rawApi.alarms.onAlarm) {
    rawApi.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === ALARM_NAME) {
        SyncEngine.runAutoSync();
      }
    });
  }

  if (rawApi.runtime && rawApi.runtime.onMessage) {
    rawApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string' || message.type.indexOf('sync-') !== 0) return false;
      (async () => {
        try {
          if (message.type === 'sync-now') {
            const summary = await SyncEngine.syncNow(message.mode || 'merge');
            SyncEngine.setupAutoSync();
            sendResponse({ ok: true, summary });
          } else if (message.type === 'sync-state') {
            sendResponse({
              ok: true,
              state: await SyncEngine.getState(),
              config: await SyncEngine.getConfig(),
              running: SyncEngine.running
            });
          } else if (message.type === 'sync-test') {
            const config = await SyncEngine.getConfig();
            await Webdav.testConnection(config);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: '未知同步指令' });
          }
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
      })();
      return true; // 异步应答
    });
  }

  // service worker 每次启动时校准自动同步闹钟
  SyncEngine.setupAutoSync();

  globalThis.BookmarkSync = { SyncEngine, Webdav, Codec, DEFAULT_CONFIG };
})();
