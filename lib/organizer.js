/**
 * 书签排序整理模块
 * 支持按字母、日期、域名、类型等排序，以及合并空文件夹等清理操作
 */
const Organizer = {

  // ==================== 排序操作 ====================

  /**
   * 递归排序整个书签树
   * 跳过根级（用户常用的一级文件夹位置不动），只排序各文件夹内部
   */
  async sortRecursive(sortBy, onProgress) {
    let count = 0;
    const rootContainers = await this.getRootContainers();
    for (const container of rootContainers) {
      count += await this.sortBookmarksOnlyKeepFolderPositions(container.id, sortBy);
      if (onProgress) onProgress();
      const topFolders = await BrowserAPI.bookmarks.getChildren(container.id);
      for (const folder of topFolders) {
        if (!folder.url) {
          count += await this._sortFolderRecursive(folder.id, sortBy, 1, onProgress);
        }
      }
    }
    return count;
  },

  async sortBookmarksOnlyKeepFolderPositions(folderId, sortBy) {
    const children = await BrowserAPI.bookmarks.getChildren(folderId);
    if (children.length <= 1) return 0;

    const bookmarkPositions = [];
    const bookmarks = [];
    for (let i = 0; i < children.length; i++) {
      if (children[i].url) {
        bookmarkPositions.push(i);
        bookmarks.push(children[i]);
      }
    }
    if (bookmarks.length <= 1) return 0;

    const isChineseTitle = (b) => {
      const title = (b.title || '').trimStart();
      const firstChar = title.charAt(0);
      return /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/.test(firstChar);
    };
    const chinese = bookmarks.filter(isChineseTitle);
    const nonChinese = bookmarks.filter(b => !isChineseTitle(b));
    const sortedChinese = this.getSortedOrder(chinese, sortBy);
    const sortedNonChinese = this.getSortedOrder(nonChinese, sortBy);
    const sortedBookmarks = [...sortedChinese, ...sortedNonChinese];

    const desired = [...children];
    for (let i = 0; i < bookmarkPositions.length; i++) {
      desired[bookmarkPositions[i]] = sortedBookmarks[i];
    }

    const currentIds = children.map(c => c.id);
    const desiredIds = desired.map(c => c.id);
    const alreadySorted = currentIds.length === desiredIds.length &&
      currentIds.every((id, i) => id === desiredIds[i]);
    if (alreadySorted) return 0;

    return await this.reorderChildren(folderId, desired);
  },

  /**
   * 内部递归：子文件夹保持原顺序，书签在文件夹之后并按规则排序
   * 一级（根级）文件夹保持原有顺序不动，只对内部书签排序
   * 二级及更深层级：文件夹排前面（中英文分组的字母序），书签排后面（中英文分组内按规则排序）
   */
  async _sortFolderRecursive(folderId, sortBy, depth = 1, onProgress = null) {
    let count = 0;
    let children = await BrowserAPI.bookmarks.getChildren(folderId);
    if (children.length <= 1) return 0;

    const subFolders = children.filter(c => !c.url);
    const bookmarks = children.filter(c => c.url);

    // 一级文件夹（depth=1）保持原有顺序，不重排文件夹
    // 二级及更深层级，文件夹按字母排序
    let sortedFolders;
    if (depth > 1) {
      sortedFolders = this.getSortedOrder(subFolders, sortBy);
    } else {
      sortedFolders = subFolders; // 保持原有顺序
    }

    const isChineseTitle = (b) => {
      const title = (b.title || '').trimStart();
      const firstChar = title.charAt(0);
      return /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/.test(firstChar);
    };
    const chinese = bookmarks.filter(isChineseTitle);
    const nonChinese = bookmarks.filter(b => !isChineseTitle(b));
    const sortedChinese = this.getSortedOrder(chinese, sortBy);
    const sortedNonChinese = this.getSortedOrder(nonChinese, sortBy);
    const sortedBookmarks = [...sortedChinese, ...sortedNonChinese];

    const sorted = [...sortedFolders, ...sortedBookmarks];

    const currentIds = children.map(c => c.id);
    const sortedIds = sorted.map(s => s.id);
    const alreadySorted = currentIds.length === sortedIds.length &&
      currentIds.every((id, i) => id === sortedIds[i]);

    if (!alreadySorted && sorted.length > 0) {
      count += await this.reorderChildren(folderId, sorted);
    }
    if (onProgress) onProgress();

    const finalChildren = await BrowserAPI.bookmarks.getChildren(folderId);
    for (const child of finalChildren) {
      if (!child.url) {
        count += await this._sortFolderRecursive(child.id, sortBy, depth + 1, onProgress);
      }
    }
    return count;
  },

  async reorderChildren(folderId, sorted) {
    let moved = 0;
    // 只读一次子列表，之后在本地维护镜像（move 语义 = 先移除再插入目标位），
    // 避免旧实现每个条目都重新 getChildren 一次（O(n²) 次 API 调用）
    const initial = await BrowserAPI.bookmarks.getChildren(folderId);
    const order = initial.map(c => c.id);

    for (let index = 0; index < sorted.length; index++) {
      const item = sorted[index];
      if (order[index] === item.id) continue;

      const currentIndex = order.indexOf(item.id);
      if (currentIndex === -1) {
        throw new Error(`无法找到待排序项: ${item.title || item.id}`);
      }

      try {
        await BrowserAPI.bookmarks.move(item.id, { parentId: folderId, index });
      } catch (error) {
        throw new Error(`排序移动失败: ${item.title || item.id} (${error.message || error})`);
      }
      order.splice(currentIndex, 1);
      order.splice(index, 0, item.id);
      moved++;
    }
    return moved;
  },

  async getRootContainers() {
    try {
      const roots = await BrowserAPI.bookmarks.getTree();
      const rootNode = roots && roots[0];
      if (!rootNode || !rootNode.children) return [];
      return rootNode.children.filter(child => !child.url);
    } catch {
      try {
        const parentId = await BrowserAPI.getDefaultParentId();
        return [{ id: parentId }];
      } catch {
        return [];
      }
    }
  },

  /**
   * 获取排序后的顺序（不执行移动）
   */
  getSortedOrder(children, sortBy) {
    const items = [...children];

    switch (sortBy) {
      case 'title-asc':
        items.sort((a, b) => this.compareTitle(a, b));
        break;
      case 'title-desc':
        items.sort((a, b) => this.compareTitle(b, a));
        break;
      case 'date-asc':
        items.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
        break;
      case 'date-desc':
        items.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
        break;
      case 'domain':
        items.sort((a, b) => this.compareDomain(a, b));
        break;
      default:
        break;
    }

    return items;
  },

  /**
   * 标题比较（支持中文拼音排序）
   * 优先用 localeCompare，不可用时回退到 Unicode 码点比较
   */
  compareTitle(a, b) {
    const ta = (a.title || '').trim();
    const tb = (b.title || '').trim();
    try {
      if (!this._zhPinyinCollator) {
        this._zhPinyinCollator = new Intl.Collator(
          ['zh-u-co-pinyin', 'zh-Hans-CN', 'zh-CN', 'zh'],
          {
            usage: 'sort',
            collation: 'pinyin',
            numeric: true,
            sensitivity: 'base',
            ignorePunctuation: true
          }
        );
      }
      const result = this._zhPinyinCollator.compare(ta, tb);
      if (result !== 0) return result;
      const fallbackZh = ta.localeCompare(tb, 'zh-CN', {
        numeric: true,
        sensitivity: 'base',
        ignorePunctuation: true
      });
      if (fallbackZh !== 0) return fallbackZh;
    } catch {}
    // 回退：逐字符比较 Unicode 码点
    const len = Math.min(ta.length, tb.length);
    for (let i = 0; i < len; i++) {
      const d = ta.charCodeAt(i) - tb.charCodeAt(i);
      if (d !== 0) return d;
    }
    return ta.length - tb.length;
  },

  /**
   * 域名排序
   */
  compareDomain(a, b) {
    const da = this.extractDomain(a.url || '');
    const db = this.extractDomain(b.url || '');
    if (da !== db) return da.localeCompare(db, 'zh-Hans-CN');
    return this.compareTitle(a, b);
  },

  extractDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  },

  // ==================== 整理操作 ====================

  /**
   * 合并同名文件夹
   * 将同级下同名文件夹的内容合并到第一个，删除其余
   */
  async mergeDuplicateFolders(node) {
    let merged = 0;

    if (!node.children) return 0;

    // 按名称分组文件夹
    const folderGroups = {};
    for (const child of node.children) {
      if (!child.url) {
        const name = (child.title || '').trim().toLowerCase();
        if (!folderGroups[name]) folderGroups[name] = [];
        folderGroups[name].push(child);
      }
    }

    // 合并同名文件夹
    for (const [name, folders] of Object.entries(folderGroups)) {
      if (folders.length <= 1) continue;

      const target = folders[0]; // 保留第一个
      for (let i = 1; i < folders.length; i++) {
        const source = folders[i];
        // 移动源文件夹的所有子项到目标文件夹
        if (source.children) {
          for (const child of source.children) {
            try {
              await BrowserAPI.bookmarks.move(child.id, { parentId: target.id });
              merged++;
            } catch {}
          }
        }
        // 删除空的源文件夹
        try { await BrowserAPI.bookmarks.removeTree(source.id); } catch {}
      }
    }

    // 递归处理子文件夹
    const refreshed = await BrowserAPI.bookmarks.getChildren(node.id);
    for (const child of refreshed) {
      if (!child.url) {
        merged += await this.mergeDuplicateFolders(child);
      }
    }

    return merged;
  },

  /**
   * 清理空文件夹
   */
  async cleanEmptyFolders(node) {
    let cleaned = 0;

    if (!node.children) return 0;

    // 先递归处理子文件夹
    for (const child of [...node.children]) {
      if (!child.url) {
        cleaned += await this.cleanEmptyFolders(child);
      }
    }

    // 刷新后检查当前节点的子文件夹
    const refreshed = await BrowserAPI.bookmarks.getChildren(node.id);
    for (const child of refreshed) {
      if (!child.url) {
        const subChildren = await BrowserAPI.bookmarks.getChildren(child.id);
        if (subChildren.length === 0) {
          try {
            await BrowserAPI.bookmarks.removeTree(child.id);
            cleaned++;
          } catch {}
        }
      }
    }

    return cleaned;
  },

  /**
   * 去重 URL 归一化
   * mode: 'exact' 仅去尾部斜杠（完整 URL 一致才算重复）
   *       'hash'  再忽略 #锚点
   *       'loose' 再忽略协议(http/https)与 www. 前缀
   */
  normalizeUrlForDedup(url, mode) {
    let u = (url || '').trim();
    if (mode === 'exact') return u.replace(/\/+$/, '');
    try {
      const x = new URL(u);
      u = x.href;
    } catch {}
    u = u.replace(/#.*$/, '').replace(/\/+$/, '');
    if (mode === 'loose') {
      u = u.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    }
    return u;
  },

  /**
   * 查找重复书签（按归一化 URL 分组，不执行删除）
   * keep: 'first' 保留位置靠前的；'oldest' 保留最早添加的
   * 返回 { groups: [{ key, keep, extras }], extraCount }
   */
  findDuplicates(nodes, mode, keep) {
    mode = mode || 'loose';
    keep = keep || 'first';
    const buckets = new Map();
    const order = [];
    for (const n of nodes || []) {
      if (n.isFolder || !n.url) continue;
      const key = this.normalizeUrlForDedup(n.url, mode);
      if (!key) continue;
      let b = buckets.get(key);
      if (!b) { b = []; buckets.set(key, b); order.push(key); }
      b.push(n);
    }
    const groups = [];
    let extraCount = 0;
    for (const key of order) {
      const items = buckets.get(key);
      if (items.length <= 1) continue;
      let keepNode = items[0];
      if (keep === 'oldest') {
        for (const it of items) {
          if ((it.dateAdded || 0) < (keepNode.dateAdded || 0)) keepNode = it;
        }
      }
      const extras = items.filter(it => it.id !== keepNode.id);
      if (extras.length === 0) continue;
      groups.push({ key, keep: keepNode, extras });
      extraCount += extras.length;
    }
    return { groups, extraCount };
  },

  // ==================== 合并导入 ====================

  /**
   * 递归合并导入书签节点到目标文件夹
   * @param {Array} importNodes - 导入的节点数组 [{title, url?, children?}]
   * @param {string} targetFolderId - 目标文件夹 ID
   * @param {Set} existingUrls - 当前已有的 URL 集合（用于去重）
   * @param {Function} onProgress - 进度回调 (added, skipped)
   * @returns {{ added: number, skipped: number, folders: number }}
   */
  async mergeImport(importNodes, targetFolderId, existingUrls, onProgress) {
    let added = 0, skipped = 0, folders = 0;
    const seenUrls = new Set();
    // 同一父文件夹的子列表缓存：递归导入时避免对同一文件夹反复 getChildren
    const childrenCache = new Map();
    const getChildrenCached = async (pid) => {
      if (!childrenCache.has(pid)) {
        childrenCache.set(pid, await BrowserAPI.bookmarks.getChildren(pid));
      }
      return childrenCache.get(pid);
    };

    for (const node of importNodes) {
      if (node.url) {
        const url = node.url.replace(/\/$/, '');
        if (existingUrls.has(url) || seenUrls.has(url)) {
          skipped++;
        } else {
          try {
            await BrowserAPI.bookmarks.create({
              parentId: targetFolderId,
              title: node.title || '(无标题)',
              url: node.url
            });
            added++;
            seenUrls.add(url);
          } catch {}
        }
        if (onProgress) onProgress(added, skipped);
      } else if (node.children) {
        // 查找同名文件夹，合并进去；否则创建新文件夹
        const existing = await getChildrenCached(targetFolderId);
        const existingFolder = existing.find(c => !c.url && c.title === node.title);
        let folderId;
        if (existingFolder) {
          folderId = existingFolder.id;
        } else {
          const folder = await BrowserAPI.bookmarks.create({
            parentId: targetFolderId,
            title: node.title || '(未命名文件夹)'
          });
          folderId = folder.id;
          folders++;
          existing.push(folder); // 新建的文件夹进入缓存，后续同名查找可见
        }
        const result = await this.mergeImport(node.children, folderId, existingUrls, onProgress);
        added += result.added;
        skipped += result.skipped;
        folders += result.folders;
      }
    }

    return { added, skipped, folders };
  },

};

