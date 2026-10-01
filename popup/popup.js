/**
 * 书签整理助手 - Popup 主逻辑
 * 支持：树形可视化、拖拽、搜索、批量操作、排序整理、规则分类、相似聚类、死链检测、统计
 */
(async function () {
  'use strict';

  let fullTree = null;
  let flatNodes = [];
  let selectMode = false;
  let selectedIds = new Set();
  let contextTarget = null;
  let currentClassified = null;
  let selectedCategories = new Set();
  let selectedBookmarks = new Map(); // category -> Set of bookmark ids
  let defaultParentId = null;

  const $ = (sel) => document.querySelector(sel);
  const treeContainer = $('#bookmark-tree');
  const searchInput = $('#search-input');
  const contextMenu = $('#context-menu');
  const moveDialog = $('#move-dialog');
  const moveFolderTree = $('#move-folder-tree');

  function createFavicon(url) {
    const span = document.createElement('span');
    span.style.cssText = 'display:inline-flex;align-items:center;flex-shrink:0;width:16px;height:16px;vertical-align:middle;';
    const sources = getFaviconSources(url);
    if (sources.length === 0) { span.textContent = '🔗'; return span; }
    const img = document.createElement('img');
    img.width = 16; img.height = 16;
    img.style.cssText = 'flex-shrink:0;';
    img.loading = 'lazy';
    let srcIdx = 0;
    img.onerror = function() {
      srcIdx++;
      if (srcIdx < sources.length) { this.src = sources[srcIdx]; }
      else { this.style.display = 'none'; span.textContent = '🔗'; }
    };
    img.src = sources[0];
    span.appendChild(img);
    return span;
  }

  async function getDefaultParentId() {
    if (defaultParentId) return defaultParentId;
    defaultParentId = await BrowserAPI.getDefaultParentId();
    return defaultParentId;
  }

  // ==================== 初始化 ====================
  async function init() {
    fullTree = await BookmarkTree.getFullTree();
    defaultParentId = await getDefaultParentId();
    flatNodes = BookmarkTree.flattenTree(fullTree);
    renderTree(treeContainer, fullTree.children);
    bindTabs();
    bindSearch();
    bindContextMenu();
    bindMoveDialog();
    bindBatchBar();
    bindPanelActions();
    bindMergePanel();
    setupDeadLinkMessaging();
    restoreDeadLinkState();
    restoreJobStates();
  }

  // ==================== 标签页 ====================
  function bindTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        $(`#panel-${tab.dataset.tab}`).classList.add('active');
        if (tab.dataset.tab === 'stats') {
          const stats = BookmarkTree.getTreeStats(flatNodes);
          renderStats(stats);
        }
      });
    });
  }

  // ==================== 搜索 ====================
  function bindSearch() {
    let timer;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => filterTree(searchInput.value.trim().toLowerCase()), 200);
    });
    $('#btn-clear-search').addEventListener('click', () => { searchInput.value = ''; filterTree(''); });
  }

  function filterTree(query) {
    const allNodes = treeContainer.querySelectorAll('.tree-node');
    if (!query) {
      allNodes.forEach(n => { n.style.display = ''; });
      return;
    }
    // 第一遍：找出所有匹配的节点，标记它们和所有祖先为"可见"
    const visible = new Set();
    allNodes.forEach(node => {
      const title = (node.dataset.title || '').toLowerCase();
      const url = (node.dataset.url || '').toLowerCase();
      if (title.includes(query) || url.includes(query)) {
        // 标记此节点及所有祖先为可见
        let el = node;
        while (el && el !== treeContainer) {
          if (el.classList && el.classList.contains('tree-node')) visible.add(el);
          el = el.parentElement;
        }
      }
    });
    // 第二遍：设置显示/隐藏，并展开匹配节点的父文件夹
    allNodes.forEach(node => {
      node.style.display = visible.has(node) ? '' : 'none';
    });
    visible.forEach(node => {
      let parent = node.parentElement;
      while (parent) {
        if (parent.classList && parent.classList.contains('tree-children')) parent.classList.add('expanded');
        parent = parent.parentElement;
      }
    });
  }

  // ==================== 书签树渲染 ====================
  function renderTree(container, nodes, depth = 0) {
    container.innerHTML = '';
    if (!nodes) return;
    for (const node of nodes) container.appendChild(createTreeNode(node, depth));
  }

  function createTreeNode(node, depth) {
    const isFolder = !node.url;
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';
    wrapper.dataset.id = node.id;
    wrapper.dataset.title = node.title;
    wrapper.dataset.url = node.url || '';
    wrapper.dataset.isFolder = isFolder;

    const header = document.createElement('div');
    header.className = 'tree-node-header';
    header.style.paddingLeft = (14 + depth * 18) + 'px';

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle leaf';
    toggle.textContent = '';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    if (isFolder) {
      icon.textContent = '📁';
    } else {
      icon.appendChild(createFavicon(node.url));
    }

    const title = document.createElement('span');
    title.className = 'tree-title';
    title.textContent = node.title || '(无标题)';

    header.appendChild(toggle);
    header.appendChild(icon);
    header.appendChild(title);

    if (isFolder && node.children) {
      const badge = document.createElement('span');
      badge.className = 'tree-badge';
      badge.textContent = node.children.length;
      header.appendChild(badge);
    }

    if (!isFolder && node.url) {
      const urlSpan = document.createElement('span');
      urlSpan.className = 'tree-url';
      urlSpan.textContent = node.url;
      header.appendChild(urlSpan);
    }

    wrapper.appendChild(header);

    if (isFolder && node.children && node.children.length > 0) {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      for (const child of node.children) childContainer.appendChild(createTreeNode(child, depth + 1));
      wrapper.appendChild(childContainer);
      header.style.cursor = 'pointer';
      header.addEventListener('click', () => {
        if (selectMode) { toggleSelection(header, node.id); return; }
        childContainer.classList.toggle('expanded');
      });
    } else if (!isFolder) {
      header.style.cursor = 'pointer';
      header.addEventListener('click', () => {
        if (selectMode) { toggleSelection(header, node.id); return; }
        if (node.url) BrowserAPI.tabs.create({ url: node.url, active: false });
      });
    }

    if (!isFolder) {
      header.draggable = true;
      header.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', node.id); header.style.opacity = '0.5'; });
      header.addEventListener('dragend', () => { header.style.opacity = ''; });
    }

    if (isFolder) {
      header.addEventListener('dragover', (e) => { e.preventDefault(); header.classList.add('drag-over'); });
      header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
      header.addEventListener('drop', async (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId && draggedId !== node.id) await moveBookmark(draggedId, node.id);
      });
    }

    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextTarget = node;
      showContextMenu(e.clientX, e.clientY, isFolder);
    });

    return wrapper;
  }

  function getFaviconSources(url) {
    try {
      const u = new URL(url);
      const host = u.hostname;
      return [
        `https://www.google.com/s2/favicons?domain=${host}&sz=32`,
        `https://icons.duckduckgo.com/ip3/${host}.ico`,
        `${u.protocol}//${host}/favicon.ico`
      ];
    } catch { return []; }
  }

  // ==================== 拖拽 ====================
  async function moveBookmark(bookmarkId, targetFolderId) {
    try { await BrowserAPI.bookmarks.move(bookmarkId, { parentId: targetFolderId }); } catch (err) { console.error('移动失败:', err); }
    try { await refreshTree(); } catch {}
  }

  async function refreshTree() {
    fullTree = await BookmarkTree.getFullTree();
    flatNodes = BookmarkTree.flattenTree(fullTree);
    const query = searchInput.value.trim().toLowerCase();
    renderTree(treeContainer, fullTree.children);
    if (query) filterTree(query);
  }

  // ==================== 多选 ====================
  function bindBatchBar() {
    bind($('#btn-batch-cancel'), 'click', exitSelectMode);
    bind($('#btn-batch-delete'), 'click', batchDelete);
    bind($('#btn-batch-move'), 'click', () => { if (selectedIds.size > 0) showMoveDialog(selectedIds); });
  }

  function toggleSelection(header, id) {
    if (selectedIds.has(id)) { selectedIds.delete(id); header.classList.remove('selected'); }
    else { selectedIds.add(id); header.classList.add('selected'); }
    updateBatchBar();
  }

  function updateBatchBar() {
    const bar = $('#batch-bar');
    if (selectedIds.size > 0) { bar.style.display = 'flex'; $('#selected-count').textContent = `已选 ${selectedIds.size} 项`; }
    else { bar.style.display = 'none'; }
  }

  function exitSelectMode() {
    selectMode = false; selectedIds.clear();
    treeContainer.querySelectorAll('.tree-node-header.selected').forEach(h => h.classList.remove('selected'));
    updateBatchBar(); $('#btn-select-mode').textContent = '多选';
    $('#btn-select-mode').classList.remove('active');
  }

  async function batchDelete() {
    if (!confirm(`确定删除选中的 ${selectedIds.size} 项？`)) return;
    for (const id of selectedIds) { try { await BrowserAPI.bookmarks.removeTree(id); } catch {} }
    exitSelectMode(); try { await refreshTree(); } catch {}
  }

  // ==================== 右键菜单 ====================
  function bindContextMenu() {
    document.addEventListener('click', () => { contextMenu.style.display = 'none'; });
    contextMenu.querySelectorAll('.context-item').forEach(item => {
      item.addEventListener('click', async () => {
        const action = item.dataset.action;
        if (!contextTarget) return;
        switch (action) {
          case 'rename': await renameBookmark(contextTarget); break;
          case 'move': showMoveDialog(new Set([contextTarget.id])); break;
          case 'open': if (contextTarget.url) BrowserAPI.tabs.create({ url: contextTarget.url }); break;
          case 'delete':
            try { await BrowserAPI.bookmarks.removeTree(contextTarget.id); await refreshTree(); } catch {}
            break;
        }
        contextMenu.style.display = 'none';
      });
    });
  }

  function showContextMenu(x, y, isFolder) {
    contextMenu.style.display = 'block';
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.querySelector('[data-action="open"]').style.display = isFolder ? 'none' : '';
  }

  async function renameBookmark(node) {
    const newName = prompt('输入新名称:', node.title);
    if (newName && newName !== node.title) { await BrowserAPI.bookmarks.update(node.id, { title: newName }); try { await refreshTree(); } catch {} }
  }

  // ==================== 移动对话框 ====================
  let pendingMoveIds = null;

  function bindMoveDialog() {
    bind($('#move-dialog-close'), 'click', hideMoveDialog);
    bind($('#move-dialog-cancel'), 'click', hideMoveDialog);
    bind($('#move-dialog-confirm'), 'click', async () => {
      const selHeader = moveFolderTree.querySelector('.tree-node-header.selected');
      const targetId = selHeader ? selHeader.parentElement.dataset.id : null;
      if (targetId && pendingMoveIds) {
        for (const id of pendingMoveIds) { try { await BrowserAPI.bookmarks.move(id, { parentId: targetId }); } catch {} }
        hideMoveDialog(); exitSelectMode(); try { await refreshTree(); } catch {}
      }
    });
  }

  function showMoveDialog(ids) {
    pendingMoveIds = ids;
    moveDialog.style.display = 'flex';
    moveFolderTree.innerHTML = '';
    for (const node of fullTree.children || []) {
      const el = createMoveTreeNode(node, 0);
      if (el) moveFolderTree.appendChild(el);
    }
  }

  function createMoveTreeNode(node, depth) {
    if (node.url) return null;
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';
    wrapper.dataset.id = node.id;
    const header = document.createElement('div');
    header.className = 'tree-node-header';
    header.style.paddingLeft = (14 + depth * 18) + 'px';
    const icon = document.createElement('span');
    icon.className = 'tree-icon'; icon.textContent = '📁';
    const title = document.createElement('span');
    title.className = 'tree-title'; title.textContent = node.title || '(根目录)';
    header.appendChild(icon); header.appendChild(title);
    wrapper.appendChild(header);
    header.addEventListener('click', () => {
      moveFolderTree.querySelectorAll('.tree-node-header.selected').forEach(h => h.classList.remove('selected'));
      header.classList.add('selected');
    });
    if (node.children) {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children expanded';
      for (const child of node.children) { const childEl = createMoveTreeNode(child, depth + 1); if (childEl) childContainer.appendChild(childEl); }
      wrapper.appendChild(childContainer);
    }
    return wrapper;
  }

  function hideMoveDialog() { moveDialog.style.display = 'none'; pendingMoveIds = null; }

  // ==================== 排序整理 ====================
  async function sortAll() {
    const sortBy = $('#sort-by').value;
    const btn = $('#btn-sort-all');
    btn.disabled = true; btn.textContent = '排序中...';
    // 优先后台执行：弹窗关闭后排序继续，重开弹窗可看到进度
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'job-start', job: 'sort-all', payload: { sortBy } });
      if (resp && resp.ok) {
        sortJobActive = true;
        btn.textContent = '后台排序中...';
        showOrganizeResult('排序已转入后台运行，可关闭弹窗稍后回来查看', 'info');
        return;
      }
      if (resp && resp.error && resp.error.indexOf('已在后台') >= 0) {
        sortJobActive = true;
        btn.textContent = '后台排序中...';
        return;
      }
      throw new Error('后台不可用');
    } catch (bgErr) {
      // 回退：本地执行
      try {
        const count = await Organizer.sortRecursive(sortBy);
        showOrganizeResult(`排序完成，共处理 ${count} 项`, 'success');
        await refreshTree();
      } catch (e) {
        showOrganizeResult(`排序出错: ${e.message}`, 'warning');
      } finally {
        btn.disabled = false; btn.textContent = '排序书签';
      }
    }
  }

  async function mergeDuplicateFolders() {
    if (!confirm('合并同名文件夹？同名文件夹的内容将合并到第一个。')) return;
    const count = await Organizer.mergeDuplicateFolders(fullTree);
    showOrganizeResult(`合并完成，处理了 ${count} 项`, count > 0 ? 'success' : 'info');
    try { await refreshTree(); } catch {}
  }

  async function cleanEmptyFolders() {
    if (!confirm('清理所有空文件夹？')) return;
    const count = await Organizer.cleanEmptyFolders(fullTree);
    showOrganizeResult(`清理完成，删除了 ${count} 个空文件夹`, count > 0 ? 'success' : 'info');
    try { await refreshTree(); } catch {}
  }

  // ==================== 去重对话框 ====================
  let dedupResult = null;
  let dedupSelection = new Map(); // 手动模式：每组选中的保留项（组序号 → 书签 id）

  function openDedupDialog() {
    $('#dedup-mode').value = 'loose';
    $('#dedup-keep').value = 'first';
    $('#dedup-dialog').style.display = 'flex';
    scanDedup();
  }

  function hideDedupDialog() {
    $('#dedup-dialog').style.display = 'none';
    dedupResult = null;
  }

  function scanDedup() {
    const mode = $('#dedup-mode').value;
    const keep = $('#dedup-keep').value;
    dedupResult = Organizer.findDuplicates(flatNodes, mode, keep);
    renderDedupPreview();
  }

  function renderDedupPreview() {
    const box = $('#dedup-preview');
    const btn = $('#dedup-confirm');
    box.innerHTML = '';
    dedupSelection = new Map();
    if (!dedupResult || dedupResult.groups.length === 0) {
      box.textContent = '当前匹配方式下没有发现重复书签。';
      btn.disabled = true;
      btn.textContent = '移除多余项';
      return;
    }
    const manual = $('#dedup-keep').value === 'manual';
    const head = document.createElement('div');
    head.innerHTML = '发现 <b>' + dedupResult.groups.length + '</b> 组重复' +
      (manual ? '，请逐组勾选要保留的书签：' : '，共 <b>' + dedupResult.extraCount + '</b> 个多余书签：');
    box.appendChild(head);

    const showGroups = dedupResult.groups.slice(0, manual ? 10 : 20);
    showGroups.forEach(function (g, gi) {
      if (!manual) {
        const row = document.createElement('div');
        row.className = 'dup-row';
        const keepSpan = document.createElement('span');
        keepSpan.className = 'dup-keep';
        keepSpan.textContent = g.keep.title || g.keep.url;
        keepSpan.title = g.keep.url;
        row.appendChild(keepSpan);
        row.appendChild(document.createTextNode(' ← 移除 ' + g.extras.length + ' 个重复'));
        box.appendChild(row);
        return;
      }
      dedupSelection.set(gi, g.items[0].id);
      const groupBox = document.createElement('div');
      groupBox.className = 'dup-group';
      g.items.forEach(function (it, ii) {
        const label = document.createElement('label');
        label.className = 'dup-choice';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'dupgroup-' + gi;
        radio.checked = ii === 0;
        radio.addEventListener('change', function () {
          dedupSelection.set(gi, it.id);
          updateDedupButtonText();
        });
        label.appendChild(radio);
        const name = document.createElement('span');
        name.className = 'dup-name';
        name.textContent = it.title || it.url;
        name.title = it.url;
        label.appendChild(name);
        if (it.path) {
          const pathSpan = document.createElement('span');
          pathSpan.className = 'dup-path';
          pathSpan.textContent = it.path;
          pathSpan.title = it.path;
          label.appendChild(pathSpan);
        }
        groupBox.appendChild(label);
      });
      box.appendChild(groupBox);
    });
    const overflow = dedupResult.groups.length - showGroups.length;
    if (overflow > 0) {
      const more = document.createElement('div');
      more.textContent = manual
        ? '… 其余 ' + overflow + ' 组默认每组保留第一个'
        : '… 其余 ' + overflow + ' 组';
      box.appendChild(more);
    }
    updateDedupButtonText();
  }

  // 汇总当前将被移除的书签：自动模式取各组 extras，手动模式按用户勾选
  function currentDedupExtras() {
    if (!dedupResult) return [];
    const manual = $('#dedup-keep').value === 'manual';
    const extras = [];
    dedupResult.groups.forEach(function (g, gi) {
      if (!manual) {
        g.extras.forEach(function (ex) { extras.push(ex); });
        return;
      }
      const keepId = dedupSelection.has(gi) ? dedupSelection.get(gi) : (g.items[0] && g.items[0].id);
      g.items.forEach(function (it) {
        if (it.id !== keepId) extras.push(it);
      });
    });
    return extras;
  }

  function updateDedupButtonText() {
    const btn = $('#dedup-confirm');
    const n = currentDedupExtras().length;
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? '移除 ' + n + ' 个多余书签' : '移除多余项';
  }

  async function confirmDedup() {
    const targets = currentDedupExtras();
    if (targets.length === 0) return;
    const btn = $('#dedup-confirm');
    btn.disabled = true;
    btn.textContent = '移除中…';
    let removed = 0;
    for (const ex of targets) {
      try { await BrowserAPI.bookmarks.remove(ex.id); removed++; } catch {}
    }
    hideDedupDialog();
    showOrganizeResult('已移除 ' + removed + ' 个重复书签', removed > 0 ? 'success' : 'info');
    try { await refreshTree(); } catch {}
  }

  function bindDedupDialog() {
    bind($('#btn-remove-dupes'), 'click', openDedupDialog);
    bind($('#dedup-dialog-close'), 'click', hideDedupDialog);
    bind($('#dedup-cancel'), 'click', hideDedupDialog);
    bind($('#dedup-confirm'), 'click', confirmDedup);
    bind($('#dedup-mode'), 'change', scanDedup);
    bind($('#dedup-keep'), 'change', scanDedup);
  }

  function showOrganizeResult(msg, type) {
    const container = $('#organize-result');
    container.innerHTML = `<div class="organize-msg ${type}">${msg}</div>`;
    setTimeout(() => { container.innerHTML = ''; }, 5000);
  }

  // ==================== 面板操作 ====================
  function bind(el, event, handler) { if (el) el.addEventListener(event, handler); }

  function clearClassifyBtnActive() {
    ['btn-auto-classify', 'btn-rule-stats', 'btn-cluster'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
  }

  function bindPanelActions() {
    let allExpanded = false;
    bind($('#btn-toggle-expand'), 'click', () => {
      allExpanded = !allExpanded;
      treeContainer.querySelectorAll('.tree-children').forEach(c => {
        c.classList.toggle('expanded', allExpanded);
      });
      $('#btn-toggle-expand').textContent = allExpanded ? '全部折叠' : '全部展开';
    });
    bind($('#btn-select-mode'), 'click', () => {
      selectMode = !selectMode;
      $('#btn-select-mode').textContent = selectMode ? '退出多选' : '多选';
      $('#btn-select-mode').classList.toggle('active', selectMode);
      if (!selectMode) exitSelectMode();
    });

    // 排序整理
    bind($('#btn-sort-all'), 'click', sortAll);
    bind($('#btn-merge-dupes'), 'click', mergeDuplicateFolders);
    bind($('#btn-clean-empty'), 'click', cleanEmptyFolders);
    bind($('#btn-remove-dupes'), 'click', openDedupDialog);
    bindDedupDialog();

    // 规则分类
    bind($('#btn-auto-classify'), 'click', async () => {
      const btn = $('#btn-auto-classify');
      clearClassifyBtnActive(); btn.classList.add('active');
      btn.disabled = true; btn.textContent = '分类中...';
      try {
        const rules = await Storage.getRules();
        currentClassified = Classifier.autoClassify(flatNodes, rules);
        renderClassifyResult(currentClassified);
        $('#btn-move-all').style.display = '';
      } finally {
        btn.disabled = false; btn.textContent = '规则分类';
      }
    });

    // 相似聚类
    bind($('#btn-cluster'), 'click', async () => {
      const btn = $('#btn-cluster');
      clearClassifyBtnActive(); btn.classList.add('active');
      btn.disabled = true; btn.textContent = '聚类中...';
      try {
        const config = await Storage.getConfig();
        const clusters = Classifier.clusterSimilar(flatNodes, { threshold: config.clusterThreshold });
        currentClassified = {};
        for (const c of clusters) currentClassified[c.name] = c.items;
        renderClusterResult(clusters);
        $('#btn-move-all').style.display = '';
      } finally {
        btn.disabled = false; btn.textContent = '相似聚类';
      }
    });

    // 全部移入文件夹
    bind($('#btn-move-all'), 'click', moveAllClassifiedFolders);

    // 规则命中统计
    bind($('#btn-rule-stats'), 'click', async () => {
      clearClassifyBtnActive(); $('#btn-rule-stats').classList.add('active');
      const rules = await Storage.getRules();
      const stats = Classifier.getRuleStats(flatNodes, rules);
      renderRuleStats(stats);
      $('#btn-move-all').style.display = 'none';
    });

    // 死链检测
    bind($('#btn-check-links'), 'click', runDeadLinkCheck);
    bind($('#btn-stop-check'), 'click', stopDeadLinkCheck);
    bind($('#btn-clean-dead'), 'click', cleanDeadLinks);

    bind($('#btn-settings'), 'click', () => BrowserAPI.runtime.openOptionsPage());
  }

  // ==================== 规则分类渲染 ====================
  function renderClassifyResult(classified) {
    selectedCategories.clear();
    selectedBookmarks.clear();
    const container = $('#classify-result');
    container.innerHTML = '';
    for (const [category, items] of Object.entries(classified)) {
      const selectedIds = new Set(items.map(i => i.id));
      selectedBookmarks.set(category, { name: category, items, ids: selectedIds });
      selectedCategories.add(category);

      const group = document.createElement('div');
      group.className = 'classify-group';
      const header = document.createElement('div');
      header.className = 'classify-group-title';
      // 分类勾选框
      const catCheckbox = document.createElement('input');
      catCheckbox.type = 'checkbox';
      catCheckbox.checked = true;
      const ids = selectedBookmarks.get(category).ids;
      catCheckbox.addEventListener('change', () => {
        if (catCheckbox.checked) {
          selectedCategories.add(category);
          items.forEach(i => ids.add(i.id));
        } else {
          selectedCategories.delete(category);
          ids.clear();
        }
        group.querySelectorAll('.classify-item input[type="checkbox"]').forEach(cb => cb.checked = catCheckbox.checked);
        updateMoveAllBtn();
      });
      header.appendChild(catCheckbox);
      let folderName = category;
      const label = document.createElement('span');
      label.textContent = `${folderName} (${items.length})`;
      label.title = '点击重命名';
      label.style.cursor = 'pointer';
      label.style.borderBottom = '1px dashed var(--text-secondary)';
      label.addEventListener('click', () => {
        const newName = prompt('重命名此文件夹:', folderName);
        if (newName && newName.trim() && newName.trim() !== folderName) {
          folderName = newName.trim();
          selectedBookmarks.get(category).name = folderName;
          label.textContent = `${folderName} (${items.length})`;
        }
      });
      header.appendChild(label);
      const moveBtn = document.createElement('button');
      moveBtn.className = 'btn-small btn-group-action';
      moveBtn.textContent = '移入文件夹';
      moveBtn.addEventListener('click', () => {
        const selected = items.filter(i => ids.has(i.id));
        if (selected.length > 0) moveGroupToFolder(selected, folderName);
      });
      header.appendChild(moveBtn);
      group.appendChild(header);
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'classify-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.addEventListener('change', () => {
          if (cb.checked) ids.add(item.id);
          else { ids.delete(item.id); catCheckbox.checked = false; }
          if (ids.size === items.length) catCheckbox.checked = true;
          catCheckbox.indeterminate = !catCheckbox.checked && ids.size > 0 && ids.size < items.length;
          updateMoveAllBtn();
        });
        row.appendChild(cb);
        row.appendChild(createFavicon(item.url));
        const name = document.createElement('span');
        name.className = 'classify-item-title';
        name.textContent = item.title;
        name.title = item.url;
        row.appendChild(name);
        if (item.confidence !== undefined) {
          const badge = document.createElement('span');
          badge.className = 'confidence-badge';
          badge.textContent = Math.round(item.confidence * 100) + '%';
          row.appendChild(badge);
        }
        group.appendChild(row);
      }
      container.appendChild(group);
    }
    updateMoveAllBtn();
  }

  // ==================== 聚类结果渲染 ====================
  function renderClusterResult(clusters) {
    selectedCategories.clear();
    selectedBookmarks.clear();
    const container = $('#classify-result');
    container.innerHTML = '';
    if (clusters.length === 0) {
      container.innerHTML = '<p style="padding:20px;text-align:center;color:#999;">未发现相似书签组</p>';
      return;
    }
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const cid = 'c' + i;
      const selectedIds = new Set(cluster.items.map(item => item.id));
      selectedBookmarks.set(cid, { name: cluster.name, items: cluster.items, ids: selectedIds });
      selectedCategories.add(cid);

      const group = document.createElement('div');
      group.className = 'classify-group';
      const header = document.createElement('div');
      header.className = 'classify-group-title';
      const catCheckbox = document.createElement('input');
      catCheckbox.type = 'checkbox';
      catCheckbox.checked = true;
      catCheckbox.addEventListener('change', () => {
        if (catCheckbox.checked) {
          selectedCategories.add(cid);
          cluster.items.forEach(item => selectedIds.add(item.id));
        } else {
          selectedCategories.delete(cid);
          selectedIds.clear();
        }
        group.querySelectorAll('.classify-item input[type="checkbox"]').forEach(cb => cb.checked = catCheckbox.checked);
        updateMoveAllBtn();
      });
      header.appendChild(catCheckbox);
      // 可重命名的名称
      const label = document.createElement('span');
      label.textContent = `${cluster.name} (${cluster.items.length} 项)`;
      label.title = '点击重命名';
      label.style.cursor = 'pointer';
      label.style.borderBottom = '1px dashed var(--text-secondary)';
      label.addEventListener('click', async () => {
        const newName = prompt('重命名此文件夹:', cluster.name);
        if (newName && newName.trim() && newName.trim() !== cluster.name) {
          cluster.name = newName.trim();
          selectedBookmarks.get(cid).name = cluster.name;
          label.textContent = `${cluster.name} (${cluster.items.length} 项)`;
        }
      });
      header.appendChild(label);
      const moveBtn = document.createElement('button');
      moveBtn.className = 'btn-small btn-group-action';
      moveBtn.textContent = '移入文件夹';
      moveBtn.addEventListener('click', () => {
        const selected = cluster.items.filter(item => selectedIds.has(item.id));
        if (selected.length > 0) moveGroupToFolder(selected, cluster.name);
      });
      header.appendChild(moveBtn);
      group.appendChild(header);
      for (const item of cluster.items) {
        const row = document.createElement('div');
        row.className = 'classify-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.addEventListener('change', () => {
          if (cb.checked) selectedIds.add(item.id);
          else { selectedIds.delete(item.id); catCheckbox.checked = false; }
          if (selectedIds.size === cluster.items.length) catCheckbox.checked = true;
          catCheckbox.indeterminate = !catCheckbox.checked && selectedIds.size > 0 && selectedIds.size < cluster.items.length;
          updateMoveAllBtn();
        });
        row.appendChild(cb);
        row.appendChild(createFavicon(item.url));
        const name = document.createElement('span');
        name.className = 'classify-item-title';
        name.textContent = item.title;
        name.title = item.url;
        row.appendChild(name);
        if (item.similarity !== undefined) {
          const sim = document.createElement('span');
          sim.className = 'cluster-similarity';
          sim.textContent = Math.round(item.similarity * 100) + '% 相似';
          row.appendChild(sim);
        }
        group.appendChild(row);
      }
      container.appendChild(group);
    }
    updateMoveAllBtn();
  }

  // ==================== 规则命中统计 ====================
  function renderRuleStats(stats) {
    const container = $('#classify-result');
    container.innerHTML = '';
    if (stats.length === 0) {
      container.innerHTML = '<p style="padding:20px;text-align:center;color:#999;">没有配置规则</p>';
      return;
    }
    const typeLabels = { domain: '域名', keyword: '关键词', regex: '正则', url_path: 'URL路径', compound: '组合' };
    for (const stat of stats) {
      const row = document.createElement('div');
      row.className = 'classify-item';
      const badge = document.createElement('span');
      badge.className = 'rule-type-badge';
      badge.textContent = typeLabels[stat.type] || stat.type;
      const pattern = document.createElement('span');
      pattern.className = 'rule-pattern-text';
      pattern.textContent = Array.isArray(stat.pattern) ? stat.pattern.join(', ') : stat.pattern;
      pattern.title = Array.isArray(stat.pattern) ? stat.pattern.join(', ') : stat.pattern;
      const category = document.createElement('span');
      category.className = 'rule-category-text';
      category.textContent = '→ ' + stat.category;
      const hitRate = document.createElement('span');
      hitRate.className = 'confidence-badge';
      hitRate.textContent = stat.hitCount + ' 命中 (' + stat.hitRate + '%)';
      row.appendChild(badge);
      row.appendChild(pattern);
      row.appendChild(category);
      row.appendChild(hitRate);
      container.appendChild(row);
    }
  }

  // ==================== 移动到文件夹 ====================
  async function moveGroupToFolder(items, folderName) {
    const ids = items.filter(i => i.id).map(i => i.id);
    if (ids.length === 0) return;

    // 优先后台执行
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'job-start', job: 'move-bookmarks',
        payload: { groups: [{ name: folderName, ids }] }
      });
      if (resp && resp.ok) {
        moveJobActive = true;
        showOrganizeResult('移入已转入后台执行，可关闭弹窗稍后回来查看', 'info');
        return;
      }
      if (resp && resp.error && resp.error.indexOf('已在后台') >= 0) {
        moveJobActive = true;
        return;
      }
      throw new Error('后台不可用');
    } catch (bgErr) {
      await moveGroupsLocal([{ name: folderName, ids }]);
    }
  }

  // 本地回退：按名查找/创建文件夹并逐个移动（与后台任务同语义）
  async function moveGroupsLocal(groups) {
    let totalMoved = 0, folderCount = 0;
    for (const g of groups) {
      // 先刷新确保文件夹列表是最新的
      try { await refreshTree(); } catch {}
      const existingFolders = flatNodes.filter(n => n.isFolder && n.title === g.name);
      let targetFolder;
      if (existingFolders.length > 0) {
        targetFolder = existingFolders[0];
      } else {
        targetFolder = await BrowserAPI.bookmarks.create({ parentId: await getDefaultParentId(), title: g.name });
        folderCount++;
      }
      for (const id of g.ids) {
        try {
          await BrowserAPI.bookmarks.move(id, { parentId: targetFolder.id });
          totalMoved++;
        } catch {}
      }
    }
    showOrganizeResult(`已将 ${totalMoved} 个书签移入目标文件夹`, 'success');
    try { await refreshTree(); } catch {}
  }

  function updateMoveAllBtn() {
    const btn = $('#btn-move-all');
    const count = selectedCategories.size;
    btn.textContent = count > 0 ? `移入选中的 ${count} 个文件夹` : '全部移入文件夹';
  }

  async function moveAllClassifiedFolders() {
    if (selectedBookmarks.size === 0) return;
    const btn = $('#btn-move-all');
    btn.disabled = true; btn.textContent = '移入中...';

    // 收集所有选中分类
    const groups = [];
    for (const [cid, info] of selectedBookmarks) {
      if (!selectedCategories.has(cid)) continue;
      const toMove = info.items.filter(i => info.ids.has(i.id));
      if (toMove.length === 0) continue;
      groups.push({ name: info.name, ids: toMove.map(i => i.id) });
    }
    if (groups.length === 0) {
      btn.disabled = false;
      updateMoveAllBtn();
      return;
    }

    // 优先后台执行
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'job-start', job: 'move-bookmarks', payload: { groups }
      });
      if (resp && resp.ok) {
        moveJobActive = true;
        showOrganizeResult('移入已转入后台执行，可关闭弹窗稍后回来查看', 'info');
        return;
      }
      if (resp && resp.error && resp.error.indexOf('已在后台') >= 0) {
        moveJobActive = true;
        return;
      }
      throw new Error('后台不可用');
    } catch (bgErr) {
      await moveGroupsLocal(groups);
      btn.disabled = false;
      updateMoveAllBtn();
    }
  }

  // ==================== 死链检测（后台运行） ====================
  let deadLinkResults = null;
  let deadLinkBgAvailable = null; // null=未探测, true/false
  let deadLinkLocalAborted = false;
  let deadLinkChecking = false; // 防止重复触发
  let deadLinkGeneration = 0; // 检测代次，防止旧的 stop 消息干扰新检测
  let deadLinkStopping = false; // 正在停止中，忽略后续进度消息

  // ==================== 通用后台任务（合并导入/排序/批量移动） ====================
  let mergeJobActive = false;
  let sortJobActive = false;
  let moveJobActive = false;

  function setupDeadLinkMessaging() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'check-progress') {
        if (deadLinkStopping) return; // 正在停止，忽略旧进度
        updateDeadLinkProgress(msg.completed, msg.total, msg.running);
      } else if (msg.type === 'check-done') {
        if (deadLinkStopping) return;
        onDeadLinkDone(msg.results);
      } else if (msg.type === 'check-stopped') {
        if (msg.generation === deadLinkGeneration) {
          deadLinkStopping = false;
          onDeadLinkDone(msg.results);
        }
      } else if (msg.type === 'check-error') {
        if (deadLinkStopping) return;
        onDeadLinkError(msg.error);
      } else if (msg.type === 'job-progress') {
        handleJobProgress(msg);
      } else if (msg.type === 'job-done') {
        handleJobDone(msg);
      } else if (msg.type === 'job-error') {
        handleJobError(msg);
      }
    });
  }

  function handleJobProgress(msg) {
    const p = msg.progress || {};
    if (msg.job === 'merge-import' && mergeJobActive) {
      if (p.total) updateMergeProgress((p.added || 0) + (p.skipped || 0), p.total);
    } else if (msg.job === 'sort-all' && sortJobActive) {
      if (p.foldersTotal) {
        $('#btn-sort-all').textContent = `排序中 ${p.foldersDone || 0}/${p.foldersTotal}`;
        showOrganizeResult(`后台排序中 ${p.foldersDone || 0}/${p.foldersTotal} 个文件夹，可关闭弹窗稍后回来`, 'info');
      }
    } else if (msg.job === 'move-bookmarks' && moveJobActive) {
      if (p.total) $('#btn-move-all').textContent = `移入中 ${p.moved || 0}/${p.total}`;
    }
  }

  function handleJobDone(msg) {
    if (msg.job === 'merge-import') {
      mergeJobActive = false;
      const btn = $('#btn-import-execute');
      btn.disabled = false; btn.textContent = '开始合并';
      $('#merge-progress').style.display = 'none';
      $('#merge-progress-fill').style.width = '0%';
      const s = msg.summary || {};
      $('#merge-result').innerHTML =
        `<div class="organize-msg success">合并完成：新增 ${s.added || 0} 个书签，${s.folders || 0} 个文件夹，跳过 ${s.skipped || 0} 个重复项</div>`;
      setTimeout(() => { $('#merge-result').innerHTML = ''; }, 8000);
      mergeImportTree = null;
      refreshTree();
    } else if (msg.job === 'sort-all') {
      sortJobActive = false;
      const btn = $('#btn-sort-all');
      btn.disabled = false; btn.textContent = '排序书签';
      const s = msg.summary || {};
      showOrganizeResult(`排序完成，共移动 ${s.moved || 0} 项（${s.folders || 0} 个文件夹）`, 'success');
      refreshTree();
    } else if (msg.job === 'move-bookmarks') {
      moveJobActive = false;
      const btn = $('#btn-move-all');
      btn.disabled = false; updateMoveAllBtn();
      const s = msg.summary || {};
      showOrganizeResult(`已将 ${s.moved || 0} 个书签移入目标文件夹（新建 ${s.folders || 0} 个文件夹）`, 'success');
      refreshTree();
    }
  }

  function handleJobError(msg) {
    if (msg.job === 'merge-import') {
      mergeJobActive = false;
      const btn = $('#btn-import-execute');
      btn.disabled = false; btn.textContent = '开始合并';
      $('#merge-progress').style.display = 'none';
      $('#merge-result').innerHTML = `<div class="organize-msg warning">后台合并出错: ${msg.error || '未知错误'}</div>`;
    } else if (msg.job === 'sort-all') {
      sortJobActive = false;
      const btn = $('#btn-sort-all');
      btn.disabled = false; btn.textContent = '排序书签';
      showOrganizeResult(`后台排序出错: ${msg.error || '未知错误'}`, 'warning');
    } else if (msg.job === 'move-bookmarks') {
      moveJobActive = false;
      const btn = $('#btn-move-all');
      btn.disabled = false; updateMoveAllBtn();
      showOrganizeResult(`后台移入出错: ${msg.error || '未知错误'}`, 'warning');
    }
  }

  // 弹窗打开时恢复后台任务的进行中状态（任务可能在弹窗关闭期间完成/继续运行）
  async function restoreJobStates() {
    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: 'job-status' }); } catch { return; }
    if (!resp || !resp.ok) return;

    if (resp.running['merge-import']) {
      mergeJobActive = true;
      const btn = $('#btn-import-execute');
      btn.disabled = true; btn.textContent = '后台合并中...';
      $('#merge-progress').style.display = 'block';
      const p = resp.running['merge-import'].progress || {};
      if (p.total) updateMergeProgress((p.added || 0) + (p.skipped || 0), p.total);
    }
    if (resp.running['sort-all']) {
      sortJobActive = true;
      const btn = $('#btn-sort-all');
      btn.disabled = true; btn.textContent = '后台排序中...';
    }
    if (resp.running['move-bookmarks']) {
      moveJobActive = true;
      const btn = $('#btn-move-all');
      btn.disabled = true; btn.textContent = '后台移入中...';
    }
  }

  function updateDeadLinkProgress(completed, total, running) {
    const progressEl = $('#deadlink-progress');
    const fillEl = $('#progress-fill');
    const textEl = $('#progress-text');
    progressEl.style.display = 'block';
    if (running) {
      $('#btn-check-links').disabled = true;
      $('#btn-check-links').textContent = '检测中...';
      $('#btn-stop-check').style.display = '';
    } else {
      $('#btn-check-links').disabled = false;
      $('#btn-check-links').textContent = '开始检测';
      $('#btn-stop-check').style.display = 'none';
    }
    if (total > 0) {
      const pct = Math.round((completed / total) * 100);
      fillEl.style.width = pct + '%';
      textEl.textContent = `${completed} / ${total} (${pct}%)`;
    }
  }

  function onDeadLinkDone(results) {
    deadLinkResults = results;
    deadLinkChecking = false;
    $('#btn-check-links').disabled = false;
    $('#btn-check-links').textContent = '开始检测';
    $('#btn-stop-check').style.display = 'none';
    $('#deadlink-progress').style.display = 'none';
    $('#progress-fill').style.width = '0%';
    $('#btn-clean-dead').style.display = '';
    renderDeadLinkResult(DeadLinkChecker.groupByStatus(results));
  }

  function onDeadLinkError(errorMsg) {
    deadLinkChecking = false;
    $('#btn-check-links').disabled = false;
    $('#btn-check-links').textContent = '开始检测';
    $('#btn-stop-check').style.display = 'none';
    $('#deadlink-progress').style.display = 'none';
    $('#deadlink-result').innerHTML = `<div class="organize-msg warning">检测出错: ${errorMsg}</div>`;
  }

  async function runDeadLinkCheck() {
    if (deadLinkChecking) {
      // 防御：如果标记卡住了，验证 background 是否真的在运行
      try {
        const st = await chrome.runtime.sendMessage({ type: 'get-status' });
        if (!st || !st.running) {
          deadLinkChecking = false; // 没在运行，强制重置
        } else {
          updateDeadLinkProgress(st.completed, st.total, true);
          return; // 确实在运行，显示进度
        }
      } catch {
        deadLinkChecking = false; // background 不可用，强制重置
      }
    }
    deadLinkChecking = true;
    try {
      await _runDeadLinkCheckInner();
    } finally {
      deadLinkChecking = false;
    }
  }

  async function _runDeadLinkCheckInner() {
    deadLinkGeneration++;
    deadLinkStopping = false;
    const bookmarks = flatNodes.filter(n => !n.isFolder && n.url);
    if (bookmarks.length === 0) return;
    const config = await Storage.getConfig();

    // 检查是否有上次中断的进度，有则续检
    let resumeBookmarks = bookmarks;
    let resumeFrom = 0;
    let existingResults = [];
    try {
      const saved = await chrome.storage.local.get(['deadlink-partial', 'deadlink-partial-results']);
      const partial = saved['deadlink-partial'];
      const pr = saved['deadlink-partial-results'];
      let savedResults, savedCompleted;
      if (partial && Array.isArray(partial.results)) {
        // 旧版单键结构
        savedResults = partial.results || [];
        savedCompleted = partial.completed || 0;
      } else if (partial) {
        savedResults = (pr && pr.results) || [];
        savedCompleted = (pr && pr.completed) || 0;
      }
      if (partial && partial.bookmarks && savedCompleted < partial.total) {
        resumeBookmarks = partial.bookmarks;
        resumeFrom = savedCompleted;
        existingResults = savedResults;
        chrome.storage.local.remove(['deadlink-partial', 'deadlink-partial-results']);
      }
    } catch {}

    // 立即更新 UI
    $('#btn-check-links').disabled = true;
    $('#btn-check-links').textContent = '检测中...';
    $('#btn-stop-check').style.display = '';
    $('#deadlink-progress').style.display = 'block';
    if (resumeFrom > 0) {
      updateDeadLinkProgress(resumeFrom, resumeBookmarks.length, true);
    } else {
      $('#progress-fill').style.width = '0%';
      $('#progress-text').textContent = '准备中...';
    }

    // 尝试 background
    if (deadLinkBgAvailable !== false) {
      try {
        const status = await chrome.runtime.sendMessage({ type: 'get-status' });
        deadLinkBgAvailable = true;
        if (status && status.running) {
          updateDeadLinkProgress(status.completed, status.total, true);
          return;
        }
        if (status && status.hasResults) {
          const resp = await chrome.runtime.sendMessage({ type: 'get-results' });
          if (resp && resp.ok) { onDeadLinkDone(resp.results); return; }
        }
        const resp = await chrome.runtime.sendMessage({
          type: 'start-check',
          bookmarks: resumeBookmarks.map(b => ({ id: b.id, title: b.title, url: b.url, path: b.path })),
          config: { deadLinkConcurrency: config.deadLinkConcurrency, deadLinkTimeout: config.deadLinkTimeout },
          resumeFrom,
          existingResults
        });
        if (!resp) {
          await runDeadLinkCheckLocal(resumeBookmarks, config, resumeFrom, existingResults);
        } else if (!resp.ok) {
          const st = await chrome.runtime.sendMessage({ type: 'get-status' });
          if (st && st.running) updateDeadLinkProgress(st.completed, st.total, true);
        }
        return;
      } catch {
        deadLinkBgAvailable = false;
      }
    }

    await runDeadLinkCheckLocal(resumeBookmarks, config, resumeFrom, existingResults);
  }

  async function runDeadLinkCheckLocal(bookmarks, config, resumeFrom = 0, existingResults = []) {
    deadLinkLocalAborted = false;
    $('#btn-check-links').disabled = true;
    $('#btn-check-links').textContent = '检测中...';
    $('#btn-stop-check').style.display = '';
    $('#deadlink-progress').style.display = 'block';

    const concurrency = config.deadLinkConcurrency || 5;
    const timeout = config.deadLinkTimeout || 15000;
    const results = [...existingResults];
    let completed = resumeFrom;
    const total = bookmarks.length;

    if (resumeFrom > 0) {
      updateDeadLinkProgress(resumeFrom, total, true);
    }

    for (let i = resumeFrom; i < total; ) {
      if (deadLinkLocalAborted) break;
      const batch = bookmarks.slice(i, i + concurrency);
      // 批内真并发（与后台 worker-pool 同语义）
      const batchResults = await Promise.all(batch.map(bm => DeadLinkChecker.checkOne(bm, timeout)));
      results.push(...batchResults);
      completed += batchResults.length;
      i += concurrency;
      updateDeadLinkProgress(completed, total, true);
    }

    // 无论是否中止，都保留已检出的结果
    onDeadLinkDone(results);
  }

  async function stopDeadLinkCheck() {
    deadLinkStopping = true;
    deadLinkLocalAborted = true;
    deadLinkChecking = false;
    if (deadLinkBgAvailable !== false) {
      try { await chrome.runtime.sendMessage({ type: 'stop-check', generation: deadLinkGeneration }); } catch {}
    }
    $('#btn-check-links').disabled = false;
    $('#btn-check-links').textContent = '开始检测';
    $('#btn-stop-check').style.display = 'none';
    $('#deadlink-progress').style.display = 'none';
  }

  async function resetDeadLinkState() {
    deadLinkChecking = false;
    deadLinkStopping = false;
    deadLinkLocalAborted = false;
  }

  async function restoreDeadLinkState() {
    // 重置所有状态，确保干净的起点
    resetDeadLinkState();

    // 先从 storage 恢复上次结果
    try {
      const saved = await chrome.storage.local.get(['deadlink-results', 'deadlink-completed', 'deadlink-total']);
      if (saved['deadlink-results'] && saved['deadlink-results'].length > 0) {
        deadLinkResults = saved['deadlink-results'];
        onDeadLinkDone(deadLinkResults);
        return;
      }
    } catch {}

    // 再检查 background 是否在运行
    try {
      const status = await chrome.runtime.sendMessage({ type: 'get-status' });
      deadLinkBgAvailable = true;
      if (status && status.running) {
        updateDeadLinkProgress(status.completed, status.total, true);
      } else if (status && status.hasResults) {
        const resp = await chrome.runtime.sendMessage({ type: 'get-results' });
        if (resp && resp.ok) onDeadLinkDone(resp.results);
      }
    } catch {
      deadLinkBgAvailable = false;
    }
  }

  function renderDeadLinkResult(groups) {
    const container = $('#deadlink-result');
    container.innerHTML = '';

    // Firefox/Zen MV3 默认不自动授予 host_permissions：
    // 若网络错误占比过高，提示用户手动授权，否则死链检测会全部误报失败
    const allResults = [].concat(groups.dead, groups.timeout, groups.error, groups.redirect, groups.valid, groups.unknown);
    const errCount = groups.error.length;
    if (allResults.length >= 10 && errCount >= allResults.length * 0.6) {
      const tip = document.createElement('div');
      tip.className = 'organize-msg warning';
      tip.style.marginBottom = '8px';
      tip.textContent = '检测到大量网络错误：若几乎全部失败，可能是浏览器未授权联网检测。请在扩展管理页（about:addons）中允许本扩展「访问所有网站的数据」后重新检测。';
      container.appendChild(tip);
    }

    for (const status of ['dead', 'timeout', 'error', 'redirect', 'valid']) {
      const items = groups[status];
      if (!items || items.length === 0) continue;
      const group = document.createElement('div');
      group.className = 'deadlink-group';
      const title = document.createElement('div');
      title.className = 'deadlink-group-title';
      title.textContent = `${DeadLinkChecker.getStatusLabel(status)} (${items.length})`;
      group.appendChild(title);
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'deadlink-item';
        const statusSpan = document.createElement('span');
        statusSpan.className = DeadLinkChecker.getStatusClass(status);
        statusSpan.textContent = item.statusCode || item.error || '●';
        const name = document.createElement('span');
        name.className = 'deadlink-item-title';
        name.textContent = item.title;
        name.title = item.url;
        row.appendChild(statusSpan);
        row.appendChild(name);
        group.appendChild(row);
      }
      container.appendChild(group);
    }
  }

  async function cleanDeadLinks() {
    if (!deadLinkResults) return;
    const deadItems = deadLinkResults.filter(r => r.status === 'dead' || r.status === 'error');
    if (!confirm(`确定删除 ${deadItems.length} 个无效书签？`)) return;
    for (const item of deadItems) { try { await BrowserAPI.bookmarks.removeTree(item.id); } catch {} }
    deadLinkResults = null;
    chrome.storage.local.remove(['deadlink-results', 'deadlink-completed', 'deadlink-total']).catch(() => {});
    $('#deadlink-result').innerHTML = '<div class="organize-msg success">已清理完成</div>';
    $('#btn-clean-dead').style.display = 'none';
    $('#btn-stop-check').style.display = 'none';
    $('#deadlink-progress').style.display = 'none';
    $('#progress-fill').style.width = '0%';
    try { await refreshTree(); } catch {}
  }

  // ==================== 合并导入 ====================
  let mergeImportTree = null;

  function bindMergePanel() {
    bind($('#btn-import-select'), 'click', () => { const f = $('#import-file-input'); if (f) f.click(); });
    bind($('#import-file-input'), 'change', handleImportFile);
    bind($('#btn-import-execute'), 'click', executeMerge);
  }

  let mergeFileCount = 0;

  async function handleImportFile(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    mergeImportTree = { title: '合并导入', children: [] };
    mergeFileCount = files.length;
    const errors = [];

    for (const file of files) {
      try {
        const text = await file.text();
        let tree;
        if (file.name.endsWith('.json')) {
          tree = parseBookmarkJson(JSON.parse(text));
        } else {
          tree = parseBookmarkHtml(text);
        }
        if (tree.children) {
          mergeImportTree.children.push(...tree.children);
        }
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
      }
    }

    if (errors.length > 0 && mergeImportTree.children.length === 0) {
      $('#merge-preview').innerHTML = `<div class="organize-msg warning">解析失败:<br>${errors.join('<br>')}</div>`;
    } else if (errors.length > 0) {
      $('#merge-preview').innerHTML = `<div class="organize-msg warning">部分文件解析失败:<br>${errors.join('<br>')}</div>`;
      const previewDiv = document.createElement('div');
      previewDiv.className = 'merge-preview';
      $('#merge-preview').appendChild(previewDiv);
      renderMergePreview(previewDiv);
    } else {
      renderMergePreview();
    }

    if (mergeImportTree.children.length > 0) {
      $('#btn-import-execute').style.display = '';
      $('#merge-target-bar').style.display = '';
    }
    e.target.value = '';
  }

  function parseBookmarkHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = { title: '书签栏', children: [] };
    const dl = doc.querySelector('dl');
    if (dl) parseHtmlDl(dl, root);

    // 检测浏览器导出格式：顶层全是文件夹且名称匹配常见导出名
    // 如 Chrome 导出的 "书签栏"/"Bookmarks bar"、"其他书签"/"Other bookmarks"
    // 此时解包，将子内容直接作为导入内容
    const exportNames = ['书签栏', 'bookmarks bar', '其他书签', 'other bookmarks', 'toolbar', 'menu bar'];
    const isBrowserExport = root.children.length > 0 &&
      root.children.every(c => !c.url) &&
      root.children.every(c => exportNames.includes((c.title || '').toLowerCase()));
    if (isBrowserExport) {
      const unwrapped = [];
      for (const child of root.children) {
        if (child.children) unwrapped.push(...child.children);
      }
      root.children = unwrapped;
    }

    return root;
  }

  function parseHtmlDl(dl, parentNode) {
    if (!dl) return;
    for (const child of dl.children) {
      if (child.tagName !== 'DT') continue;
      const link = child.querySelector(':scope > a');
      const h3 = child.querySelector(':scope > h3');
      if (link) {
        parentNode.children.push({ title: link.textContent, url: link.href });
      } else if (h3) {
        const folder = { title: h3.textContent, children: [] };
        const subDl = child.querySelector('dl');
        if (subDl) parseHtmlDl(subDl, folder);
        parentNode.children.push(folder);
      }
    }
  }

  function parseBookmarkJson(data) {
    if (data.children) return { title: data.title || '书签栏', children: data.children.map(c => parseJsonNode(c)) };
    if (Array.isArray(data)) return { title: '书签栏', children: data.map(c => parseJsonNode(c)) };
    return { title: '书签栏', children: [] };
  }

  function parseJsonNode(node) {
    if (node.url) return { title: node.title, url: node.url };
    if (node.children) return { title: node.title, children: node.children.map(c => parseJsonNode(c)) };
    return { title: node.title, children: [] };
  }

  function renderMergePreview(container) {
    container = container || $('#merge-preview');
    container.innerHTML = '';
    if (!mergeImportTree) return;

    let totalBookmarks = 0, totalFolders = 0;
    const existingUrls = new Set(flatNodes.filter(n => n.url).map(n => n.url.replace(/\/$/, '')));
    let duplicateCount = 0;

    function countNodes(node) {
      if (node.url) {
        totalBookmarks++;
        if (existingUrls.has(node.url.replace(/\/$/, ''))) duplicateCount++;
      } else {
        totalFolders++;
        if (node.children) node.children.forEach(countNodes);
      }
    }
    if (mergeImportTree.children) mergeImportTree.children.forEach(countNodes);

    const statsDiv = document.createElement('div');
    statsDiv.className = 'merge-stats';
    const fileLabel = mergeFileCount > 1 ? `${mergeFileCount} 个文件合并` : '1 个文件';
    statsDiv.innerHTML = `
      <div class="merge-stat-item"><span class="merge-stat-num">${totalBookmarks}</span><span>书签</span></div>
      <div class="merge-stat-item"><span class="merge-stat-num">${totalFolders}</span><span>文件夹</span></div>
      <div class="merge-stat-item merge-stat-dup"><span class="merge-stat-num">${duplicateCount}</span><span>重复</span></div>
      <div class="merge-stat-item"><span style="font-size:11px;color:var(--text-secondary);">${fileLabel}</span><span></span></div>
    `;
    container.appendChild(statsDiv);

    if (mergeImportTree.children && mergeImportTree.children.length > 0) {
      const treeDiv = document.createElement('div');
      treeDiv.className = 'merge-tree';
      renderMergeTreeNodes(treeDiv, mergeImportTree.children, 0, existingUrls);
      container.appendChild(treeDiv);
    }
  }

  function renderMergeTreeNodes(container, nodes, depth, existingUrls) {
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'merge-tree-item';
      row.style.paddingLeft = (depth * 16) + 'px';
      const icon = document.createElement('span');
      icon.className = 'merge-tree-icon';
      if (node.url) {
        const isDup = existingUrls.has(node.url.replace(/\/$/, ''));
        if (isDup) {
          icon.textContent = '⚠️';
          row.classList.add('merge-dup');
        } else {
          icon.appendChild(createFavicon(node.url));
        }
      } else {
        icon.textContent = '📁';
      }
      const title = document.createElement('span');
      title.className = 'merge-tree-title';
      title.textContent = node.title || '(无标题)';
      row.appendChild(icon);
      row.appendChild(title);
      container.appendChild(row);
      if (node.children) renderMergeTreeNodes(container, node.children, depth + 1, existingUrls);
    }
  }

  function updateMergeProgress(processed, total) {
    const fillEl = $('#merge-progress-fill');
    const textEl = $('#merge-progress-text');
    const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
    fillEl.style.width = Math.min(pct, 100) + '%';
    textEl.textContent = `${processed} / ${total} (${Math.min(pct, 100)}%)`;
  }

  async function executeMerge() {
    if (!mergeImportTree || !mergeImportTree.children) return;
    const btn = $('#btn-import-execute');
    const progressEl = $('#merge-progress');
    btn.disabled = true;
    btn.textContent = '合并中...';
    progressEl.style.display = 'block';

    // 读取文件夹名，创建目标文件夹
    let targetId = await getDefaultParentId();
    const folderNameInput = document.getElementById('merge-folder-name');
    const folderName = ((folderNameInput && folderNameInput.value) || '').trim();
    if (folderName) {
      const existing = flatNodes.filter(n => n.isFolder && n.title === folderName);
      if (existing.length > 0) {
        targetId = existing[0].id;
      } else {
        const folder = await BrowserAPI.bookmarks.create({ parentId: await getDefaultParentId(), title: folderName });
        targetId = folder.id;
      }
    }

    // 预计算总书签数用于进度条
    let totalImportItems = 0;
    (function countMergeItems(list) {
      for (const node of list) {
        if (node.url) totalImportItems++;
        else if (node.children) countMergeItems(node.children);
      }
    })(mergeImportTree.children);

    // 优先后台执行：导入可能持续数分钟，弹窗关闭后继续
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'job-start', job: 'merge-import',
        payload: { nodes: mergeImportTree.children, targetId, total: totalImportItems }
      });
      if (resp && resp.ok) {
        mergeJobActive = true;
        updateMergeProgress(0, totalImportItems);
        return;
      }
      if (resp && resp.error && resp.error.indexOf('已在后台') >= 0) {
        mergeJobActive = true;
        return;
      }
      throw new Error('后台不可用');
    } catch (bgErr) {
      // 回退：本地执行
      const existingUrls = new Set(flatNodes.filter(n => n.url).map(n => n.url.replace(/\/$/, '')));
      try {
        const result = await Organizer.mergeImport(mergeImportTree.children, targetId, existingUrls, (added, skipped) => {
          updateMergeProgress(added + skipped, totalImportItems);
        });

        const resultDiv = $('#merge-result');
        resultDiv.innerHTML = `<div class="organize-msg success">合并完成：新增 ${result.added} 个书签，${result.folders} 个文件夹，跳过 ${result.skipped} 个重复项</div>`;
        setTimeout(() => { resultDiv.innerHTML = ''; }, 8000);
        try { await refreshTree(); } catch {}
      } catch (e) {
        const resultDiv = $('#merge-result');
        resultDiv.innerHTML = `<div class="organize-msg warning">合并出错: ${e.message}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '开始合并';
        progressEl.style.display = 'none';
        $('#merge-progress-fill').style.width = '0%';
      }
    }
  }

  // ==================== 统计 ====================
  function renderStats(stats) {
    const container = $('#stats-content');
    container.innerHTML = `
      <div class="stat-card">
        <h3>总览</h3>
        <div class="stat-number">${stats.totalBookmarks}</div>
        <p style="font-size:12px;color:#666;margin-top:4px;">书签 | ${stats.totalFolders} 个文件夹 | 最深 ${stats.maxDepth} 层</p>
      </div>
      <div class="stat-card">
        <h3>常用域名 Top 10</h3>
        <ul class="stat-list">${stats.topDomains.map(([d, c]) => `<li><span>${d}</span><span>${c}</span></li>`).join('')}</ul>
      </div>
      <div class="stat-card">
        <h3>层级分布</h3>
        <ul class="stat-list">${Object.entries(stats.depthDistribution).sort((a,b) => a[0]-b[0]).map(([d, c]) => `<li><span>第 ${d} 层</span><span>${c} 项</span></li>`).join('')}</ul>
      </div>
      <div class="stat-card">
        <h3>空文件夹</h3>
        <p style="font-size:12px;color:#666;">${stats.emptyFolders.length === 0 ? '没有空文件夹' : `发现 ${stats.emptyFolders.length} 个空文件夹`}</p>
      </div>`;
  }

  init();
})();

