/**
 * 书签整理助手 - 设置页面逻辑 v2
 */
(async function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);

  let currentRules = [];

  async function init() {
    await renderRules();
    await loadConfig();
    bindEvents();
    bindRuleTypeChange();
    bindSyncEvents();
    bindFileSyncEvents();
    await loadSyncConfig();
    refreshSyncState();
  }

  // ==================== 规则类型切换（显示/隐藏高级选项） ====================
  function bindRuleTypeChange() {
    const typeSelect = $('#rule-type');
    const advanced = $('#advanced-rule-options');

    typeSelect.addEventListener('change', () => {
      const type = typeSelect.value;
      // 正则显示 flags 和 target
      // 组合显示 logic
      if (type === 'regex' || type === 'compound') {
        advanced.style.display = 'block';
      } else {
        advanced.style.display = 'none';
      }
    });
  }

  // ==================== 规则管理 ====================
  async function renderRules() {
    currentRules = await Storage.getRules();
    const list = $('#rules-list');
    list.innerHTML = '';
    const typeLabels = { domain: '域名', keyword: '关键词', regex: '正则', url_path: 'URL路径', compound: '组合' };

    for (let i = 0; i < currentRules.length; i++) {
      const rule = currentRules[i];
      const item = document.createElement('div');
      item.className = 'rule-item';
      let patternText = '';
      if (rule.type === 'compound' && rule.conditions) {
        patternText = rule.conditions.map(c => `${c.type}:${c.pattern}`).join(` ${rule.logic || 'AND'} `);
      } else if (Array.isArray(rule.pattern)) {
        patternText = rule.pattern.join(', ');
      } else {
        patternText = rule.pattern;
      }
      item.innerHTML = `
        <span class="rule-type-badge">${typeLabels[rule.type] || rule.type}</span>
        <span class="rule-pattern">${patternText}</span>
        <span class="rule-category">→ ${rule.category}</span>
        <button class="rule-delete" data-index="${i}" title="删除">&times;</button>
      `;
      list.appendChild(item);
    }

    list.querySelectorAll('.rule-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        currentRules.splice(parseInt(btn.dataset.index), 1);
        await Storage.setRules(currentRules);
        await renderRules();
      });
    });
  }

  function bindEvents() {
    // 添加规则
    $('#btn-add-rule').addEventListener('click', async () => {
      const type = $('#rule-type').value;
      const pattern = $('#rule-pattern').value.trim();
      const category = $('#rule-category').value.trim();

      if (!pattern || !category) { alert('请填写规则模式和分类名称'); return; }

      let rule = { type, category };

      if (type === 'regex') {
        rule.pattern = pattern;
        rule.flags = $('#rule-flags').value.trim() || 'i';
        rule.target = $('#rule-target').value;
      } else if (type === 'keyword') {
        // 支持逗号分隔的多关键词
        rule.pattern = pattern.includes(',') ? pattern.split(',').map(s => s.trim()) : pattern;
      } else if (type === 'compound') {
        // 简单的组合规则：用 | 分隔多个条件
        const parts = pattern.split('|').map(s => s.trim());
        rule.logic = $('#rule-logic').value;
        rule.conditions = parts.map(p => {
          const [t, ...rest] = p.split(':');
          return { type: t.trim(), pattern: rest.join(':').trim() };
        });
      } else {
        rule.pattern = pattern;
      }

      currentRules.push(rule);
      await Storage.setRules(currentRules);
      $('#rule-pattern').value = '';
      $('#rule-category').value = '';
      await renderRules();
    });

    // 恢复默认
    $('#btn-reset-rules').addEventListener('click', async () => {
      if (!confirm('确定恢复默认规则？当前规则将被覆盖。')) return;
      currentRules = [...Storage.DEFAULT_RULES];
      await Storage.setRules(currentRules);
      await renderRules();
    });

    // 导出规则
    $('#btn-export-rules').addEventListener('click', () => {
      downloadBlob(new Blob([JSON.stringify(currentRules, null, 2)], { type: 'application/json' }), 'bookmark-rules.json');
    });

    // 导入规则
    $('#btn-import-rules').addEventListener('click', () => $('#import-rules-file').click());
    $('#import-rules-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const rules = JSON.parse(await file.text());
        if (!Array.isArray(rules)) throw new Error('格式错误');
        currentRules = rules;
        await Storage.setRules(currentRules);
        await renderRules();
        alert('导入成功');
      } catch (err) { alert('导入失败: ' + err.message); }
      e.target.value = '';
    });

    // 保存聚类配置
    $('#btn-save-cluster').addEventListener('click', async () => {
      const config = await Storage.getConfig();
      config.clusterThreshold = parseFloat($('#cluster-threshold').value) || 0.35;
      await Storage.setConfig(config);
      alert('聚类配置已保存');
    });

    // 保存死链配置
    $('#btn-save-config').addEventListener('click', async () => {
      const config = await Storage.getConfig();
      config.deadLinkConcurrency = parseInt($('#config-concurrency').value) || 5;
      config.deadLinkTimeout = parseInt($('#config-timeout').value) || 10000;
      await Storage.setConfig(config);
      alert('配置已保存');
    });

    // 导出书签 HTML
    $('#btn-export-html').addEventListener('click', async () => {
      const tree = await BookmarkTree.getFullTree();
      downloadBlob(new Blob([exportToHtml(tree)], { type: 'text/html;charset=utf-8' }), 'bookmarks.html');
    });

    // 导出书签 JSON
    $('#btn-export-json').addEventListener('click', async () => {
      const tree = await BookmarkTree.getFullTree();
      downloadBlob(new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' }), 'bookmarks.json');
    });

    // 导入书签
    $('#btn-import-bookmarks').addEventListener('click', () => $('#import-bookmarks-file').click());
    $('#import-bookmarks-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        if (file.name.endsWith('.json')) await importFromJson(JSON.parse(text));
        else await importFromHtml(text);
        alert('导入成功');
      } catch (err) { alert('导入失败: ' + err.message); }
      e.target.value = '';
    });
  }

  // ==================== 配置加载 ====================
  async function loadConfig() {
    const config = await Storage.getConfig();
    $('#config-concurrency').value = config.deadLinkConcurrency;
    $('#config-timeout').value = config.deadLinkTimeout;
    $('#cluster-threshold').value = config.clusterThreshold || 0.35;
  }

  // ==================== 导出 HTML ====================
  function exportToHtml(node, indent = 0) {
    const pad = '  '.repeat(indent);
    let html = '';
    if (indent === 0) {
      html += '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
    }
    if (node.children) {
      for (const child of node.children) {
        const ts = child.dateAdded ? Math.floor(parseInt(child.dateAdded) / 1000) : 0;
        if (child.url) {
          html += `${pad}  <DT><A HREF="${esc(child.url)}" ADD_DATE="${ts}">${esc(child.title)}</A>\n`;
        } else {
          html += `${pad}  <DT><H3 ADD_DATE="${ts}">${esc(child.title)}</H3>\n${pad}  <DL><p>\n`;
          html += exportToHtml(child, indent + 2);
          html += `${pad}  </DL><p>\n`;
        }
      }
    }
    if (indent === 0) html += '</DL><p>\n';
    return html;
  }

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ==================== 导入 JSON ====================
  async function importFromJson(node, parentId) {
    const resolvedParentId = parentId || await BrowserAPI.getDefaultParentId();
    if (node.children) {
      for (const child of node.children) {
        if (child.url) {
          await BrowserAPI.bookmarks.create({ parentId: resolvedParentId, title: child.title, url: child.url });
        } else {
          const folder = await BrowserAPI.bookmarks.create({ parentId: resolvedParentId, title: child.title });
          await importFromJson(child, folder.id);
        }
      }
    }
  }

  // ==================== 导入 HTML ====================
  async function importFromHtml(html, parentId) {
    const resolvedParentId = parentId || await BrowserAPI.getDefaultParentId();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    await importHtmlNode(doc.querySelector('dl'), resolvedParentId);
  }

  async function importHtmlNode(dl, parentId) {
    if (!dl) return;
    for (const child of dl.children) {
      if (child.tagName === 'DT') {
        const link = child.querySelector('a');
        const h3 = child.querySelector('h3');
        if (link) {
          await BrowserAPI.bookmarks.create({ parentId, title: link.textContent, url: link.href });
        } else if (h3) {
          const folder = await BrowserAPI.bookmarks.create({ parentId, title: h3.textContent });
          const subDl = child.querySelector('dl');
          if (subDl) await importHtmlNode(subDl, folder.id);
        }
      }
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ==================== 跨平台同步 ====================

  function syncStatusEl() { return $('#sync-status'); }

  function showSyncStatus(text, isError) {
    const el = syncStatusEl();
    el.style.display = 'block';
    el.textContent = text;
    el.style.borderLeft = isError ? '3px solid #d9534f' : '3px solid #5cb85c';
  }

  function readSyncInputs() {
    return {
      serverUrl: $('#sync-server').value.trim(),
      username: $('#sync-username').value.trim(),
      password: $('#sync-password').value,
      remoteDir: $('#sync-remotedir').value.trim() || '书签同步',
      deviceName: $('#sync-device').value.trim(),
      autoSync: $('#sync-auto').checked,
      intervalMin: parseInt($('#sync-interval').value, 10) || 30
    };
  }

  async function saveSyncInputs() {
    const config = await BookmarkSync.SyncEngine.saveConfig(readSyncInputs());
    BookmarkSync.SyncEngine.setupAutoSync();
    return config;
  }

  async function loadSyncConfig() {
    const config = await BookmarkSync.SyncEngine.getConfig();
    $('#sync-server').value = config.serverUrl || '';
    $('#sync-username').value = config.username || '';
    $('#sync-password').value = config.password || '';
    $('#sync-remotedir').value = config.remoteDir || '书签同步';
    $('#sync-device').value = config.deviceName || '';
    $('#sync-auto').checked = !!config.autoSync;
    $('#sync-interval').value = String(config.intervalMin || 30);
  }

  async function refreshSyncState() {
    try {
      const resp = await new Promise(res =>
        chrome.runtime.sendMessage({ type: 'sync-state' }, r => res(r || { ok: false }))
      );
      if (resp.ok && resp.state && resp.state.lastResult) {
        const r = resp.state.lastResult;
        const when = r.at ? new Date(r.at).toLocaleString() : '-';
        if (r.ok) {
          const s = r.summary || {};
          showSyncStatus(`上次同步成功（${when}）：云端 ${s.cloudTotal !== undefined ? s.cloudTotal + ' 条' : ''}` +
            (s.pulled !== undefined ? `，云端→本机 ${s.pulled} 条，本机→云端 ${s.pushed} 条` : ''), false);
        } else {
          showSyncStatus(`上次同步失败（${when}）：${r.error || '未知错误'}`, true);
        }
      }
    } catch (e) { /* service worker 未就绪时静默 */ }
  }

  function syncRequest(type, mode) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, mode }, r => resolve(r || { ok: false, error: '后台无响应' }));
    });
  }

  function bindSyncEvents() {
    // 预设填充
    $('#sync-preset').addEventListener('change', () => {
      const v = $('#sync-preset').value;
      if (v && v !== 'custom') $('#sync-server').value = v;
    });

    $('#btn-sync-save').addEventListener('click', async () => {
      await saveSyncInputs();
      showSyncStatus('同步配置已保存', false);
    });

    $('#btn-sync-test').addEventListener('click', async () => {
      await saveSyncInputs();
      showSyncStatus('正在测试连接…', false);
      const r = await syncRequest('sync-test');
      showSyncStatus(r.ok ? '连接成功' : ('连接失败：' + (r.error || '未知')), !!r.ok === false);
    });

    $('#btn-sync-merge').addEventListener('click', async () => {
      await saveSyncInputs();
      showSyncStatus('双向合并中…', false);
      const r = await syncRequest('sync-now', 'merge');
      if (r.ok) {
        const s = r.summary;
        showSyncStatus(`合并完成：云端→本机新增 ${s.pulled} 条，本机→云端新增 ${s.pushed} 条，云端共 ${s.cloudTotal} 条` +
          (s.skippedLocal ? `（跳过非 http 书签 ${s.skippedLocal} 条）` : ''), false);
      } else {
        showSyncStatus('合并失败：' + (r.error || '未知'), true);
      }
      refreshSyncState();
    });

    $('#btn-sync-upload').addEventListener('click', async () => {
      if (!confirm('上传将用本机全部书签【覆盖】云端文件，云端现有内容会被替换。继续？')) return;
      await saveSyncInputs();
      showSyncStatus('上传中…', false);
      const r = await syncRequest('sync-now', 'upload');
      showSyncStatus(r.ok ? `上传完成：云端现为 ${r.summary.uploaded} 条书签` : ('上传失败：' + (r.error || '未知')), !r.ok);
      refreshSyncState();
    });

    $('#btn-sync-download').addEventListener('click', async () => {
      if (!confirm('下载将【清空本机全部书签】后用云端内容重建，本机现有书签会丢失。确定继续？')) return;
      if (!confirm('再次确认：本机书签即将被清空并替换为云端内容。')) return;
      await saveSyncInputs();
      showSyncStatus('下载覆盖中…', false);
      const r = await syncRequest('sync-now', 'download');
      showSyncStatus(r.ok ? `覆盖完成：本机已重建 ${r.summary.restored} 条书签` : ('覆盖失败：' + (r.error || '未知')), !r.ok);
      refreshSyncState();
    });
  }

  // ==================== 文件同步（免账号） ====================

  const SYNC_FORMAT_ID = 'bookmark-organizer-sync';

  function showFileStatus(text, isError) {
    const el = $('#file-sync-status');
    el.style.display = 'block';
    el.textContent = text;
    el.style.borderLeft = isError ? '3px solid #d9534f' : '3px solid #5cb85c';
  }

  function todayStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  async function writeHandle(handle, text) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  }

  function syncPayload(list) {
    return JSON.stringify({
      format: SYNC_FORMAT_ID,
      version: 1,
      updatedAt: Date.now(),
      count: list.length,
      bookmarks: list
    }, null, 2);
  }

  async function importFile(file, handle) {
    try {
      if (!file) return;
      const data = JSON.parse(await file.text());
      if (data.format !== SYNC_FORMAT_ID || !Array.isArray(data.bookmarks)) {
        throw new Error('不是本插件导出的同步文件');
      }
      const tree = await BrowserAPI.bookmarks.getTree();
      const rootNode = tree && tree[0];
      const localList = BookmarkSync.Codec.treeToFlatList(rootNode);
      const created = await BookmarkSync.Codec.importCloudList(data.bookmarks, 'merge');
      const union = BookmarkSync.Codec.unionIntoCloud(data.bookmarks, localList);

      let wroteBack = false;
      if (handle) {
        try {
          if (handle.queryPermission && await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
            const req = await handle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') throw new Error('未授权写入');
          }
          await writeHandle(handle, syncPayload(union.list));
          wroteBack = true;
        } catch (e) { wroteBack = false; }
      }

      if (created === 0 && union.additions === 0) {
        showFileStatus('两边书签已一致，无需合并', false);
      } else {
        showFileStatus(
          `合并完成：从文件新增 ${created} 条到本地（位于「其他书签 / 书签同步」）` +
          (union.additions ? `，本机比文件多 ${union.additions} 条` : '') +
          (wroteBack
            ? `；文件已更新为两边并集（${union.list.length} 条），把它传回原设备再导入一次即可完成闭环`
            : `；如需把本机新增带回去，请点「导出同步文件」覆盖保存`),
          false
        );
      }
    } catch (err) {
      showFileStatus('导入失败：' + err.message, true);
    }
  }

  function bindFileSyncEvents() {
    // 导出：全量书签 → 用户选择的文件
    $('#btn-file-export').addEventListener('click', async () => {
      try {
        const tree = await BrowserAPI.bookmarks.getTree();
        const list = BookmarkSync.Codec.treeToFlatList(tree && tree[0]);
        const name = `书签同步_${todayStamp()}.json`;
        if (window.showSaveFilePicker) {
          const handle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
          });
          await writeHandle(handle, syncPayload(list));
          showFileStatus(`已导出 ${list.length} 条书签（跳过非 http 书签 ${list.skipCount || 0} 条）`, false);
        } else {
          downloadBlob(new Blob([syncPayload(list)], { type: 'application/json' }), name);
          showFileStatus('已导出（保存到浏览器下载目录）', false);
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        showFileStatus('导出失败：' + err.message, true);
      }
    });

    // 导入：优先 File System Access（可回写合并结果），否则普通文件选择
    $('#btn-file-import').addEventListener('click', async () => {
      if (window.showOpenFilePicker) {
        let handle = null;
        try {
          [handle] = await window.showOpenFilePicker({
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
            mode: 'readwrite'
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
        if (!handle) return;
        const file = await handle.getFile();
        await importFile(file, handle);
      } else {
        $('#file-import-input').click();
      }
    });
    $('#file-import-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      await importFile(file, null);
    });
  }

  init();
})();

