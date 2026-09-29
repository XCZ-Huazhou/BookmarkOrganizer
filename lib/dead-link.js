/**
 * 死链批量检测模块
 * 使用 fetch GET 请求，只要服务器有响应即视为存活
 */
const DeadLinkChecker = {
  async check(bookmarks, options = {}) {
    const concurrency = options.concurrency || 5;
    const timeout = options.timeout || 15000;
    const onProgress = options.onProgress || (() => {});
    const results = [];
    let completed = 0;
    const total = bookmarks.length;

    for (let i = 0; i < bookmarks.length; i += concurrency) {
      const batch = bookmarks.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(bm => this.checkOne(bm, timeout)));
      results.push(...batchResults);
      completed += batch.length;
      onProgress(completed, total, results);
    }
    return results;
  },

  async checkOne(bookmark, timeout) {
    const result = {
      id: bookmark.id, title: bookmark.title, url: bookmark.url,
      path: bookmark.path, status: 'unknown', statusCode: null, error: null
    };

    // 跳过非 HTTP(S) 协议
    if (!bookmark.url || !/^https?:\/\//i.test(bookmark.url)) {
      result.status = 'valid';
      result.error = '非HTTP协议，跳过检测';
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
        // 403/405/500 等 — 服务器有响应，不算死链
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

  getStatusLabel(status) {
    return { valid: '有效', redirect: '重定向', dead: '无效 (404)', timeout: '超时', error: '错误', unknown: '未知' }[status] || '未知';
  },

  getStatusClass(status) {
    if (status === 'valid') return 'status-valid';
    if (status === 'redirect') return 'status-redirect';
    return 'status-dead';
  }
};
