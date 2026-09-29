/**
 * 浏览器 API 兼容层（chrome / browser）
 * - 统一 Promise 风格调用
 * - 提供跨浏览器的根目录定位能力
 */
(function () {
  'use strict';

  const rawApi = globalThis.browser || globalThis.chrome;
  if (!rawApi) {
    throw new Error('Bookmark Organizer: browser API not found');
  }

  function lastError() {
    if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.lastError) {
      return globalThis.chrome.runtime.lastError;
    }
    if (rawApi.runtime && rawApi.runtime.lastError) {
      return rawApi.runtime.lastError;
    }
    return null;
  }

  function promisify(namespace, method) {
    return (...args) => {
      const fn = namespace && namespace[method];
      if (typeof fn !== 'function') {
        return Promise.reject(new Error(`API not available: ${method}`));
      }

      try {
        if (globalThis.browser) {
          const maybePromise = fn.apply(namespace, args);
          if (maybePromise && typeof maybePromise.then === 'function') {
            return maybePromise;
          }
        }
      } catch (_) {}

      return new Promise((resolve, reject) => {
        try {
          fn.call(namespace, ...args, (result) => {
            const err = lastError();
            if (err) {
              reject(new Error(err.message || String(err)));
            } else {
              resolve(result);
            }
          });
        } catch (error) {
          reject(error);
        }
      });
    };
  }

  const bookmarksNs = rawApi.bookmarks || {};
  const storageLocalNs = rawApi.storage && rawApi.storage.local ? rawApi.storage.local : {};
  const tabsNs = rawApi.tabs || {};
  const runtimeNs = rawApi.runtime || {};

  const BrowserAPI = {
    bookmarks: {
      getTree: promisify(bookmarksNs, 'getTree'),
      getChildren: promisify(bookmarksNs, 'getChildren'),
      get: promisify(bookmarksNs, 'get'),
      create: promisify(bookmarksNs, 'create'),
      move: promisify(bookmarksNs, 'move'),
      update: promisify(bookmarksNs, 'update'),
      removeTree: promisify(bookmarksNs, 'removeTree')
    },
    storage: {
      local: {
        get: promisify(storageLocalNs, 'get'),
        set: promisify(storageLocalNs, 'set')
      }
    },
    tabs: {
      create: promisify(tabsNs, 'create')
    },
    runtime: {
      openOptionsPage: promisify(runtimeNs, 'openOptionsPage')
    },
    async getDefaultParentId() {
      const roots = await this.bookmarks.getTree();
      const rootNode = roots && roots[0];
      if (!rootNode || !Array.isArray(rootNode.children)) return '1';

      const candidates = rootNode.children.filter(node => !node.url);
      if (candidates.length === 0) return '1';

      const toolbarLike = candidates.find(node => /bookmark|书签|toolbar|bar/i.test(node.title || ''));
      return (toolbarLike || candidates[0]).id;
    },
    async getTopLevelFoldersKeepOrder() {
      const parentId = await this.getDefaultParentId();
      const children = await this.bookmarks.getChildren(parentId);
      return children.filter(child => !child.url);
    }
  };

  globalThis.BrowserAPI = BrowserAPI;
})();
