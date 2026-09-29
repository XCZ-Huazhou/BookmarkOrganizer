/**
 * 智能分类引擎
 * 支持：域名/关键词/正则/URL路径/多条件组合 + 相似聚类 + 规则命中统计
 */
const Classifier = {

  // ==================== 规则匹配 ====================

  classify(bookmark, rules) {
    if (!bookmark.url) return null;
    for (const rule of rules) {
      const result = this.matchRule(bookmark, rule);
      if (result) return { category: rule.category, rule, confidence: result.confidence };
    }
    return null;
  },

  matchRule(bookmark, rule) {
    switch (rule.type) {
      case 'domain':    return this.matchDomain(bookmark, rule);
      case 'keyword':   return this.matchKeyword(bookmark, rule);
      case 'regex':     return this.matchRegex(bookmark, rule);
      case 'url_path':  return this.matchUrlPath(bookmark, rule);
      case 'compound':  return this.matchCompound(bookmark, rule);
      default:          return null;
    }
  },

  matchDomain(bookmark, rule) {
    try {
      const hostname = new URL(bookmark.url).hostname.replace(/^www\./, '');
      const pattern = rule.pattern.toLowerCase();
      return (hostname === pattern || hostname.endsWith('.' + pattern)) ? { confidence: 1.0 } : null;
    } catch { return null; }
  },

  matchKeyword(bookmark, rule) {
    const keywords = Array.isArray(rule.pattern) ? rule.pattern : [rule.pattern];
    const text = (bookmark.title + ' ' + bookmark.url).toLowerCase();
    const matchCount = keywords.filter(kw => text.includes(kw.toLowerCase())).length;
    return matchCount > 0 ? { confidence: matchCount / keywords.length } : null;
  },

  matchRegex(bookmark, rule) {
    try {
      const re = new RegExp(rule.pattern, rule.flags || 'i');
      const text = rule.target === 'url' ? bookmark.url :
                   rule.target === 'title' ? bookmark.title :
                   bookmark.title + ' ' + bookmark.url;
      const match = re.exec(text);
      return match ? { confidence: Math.min(match[0].length / text.length + 0.5, 1.0) } : null;
    } catch { return null; }
  },

  matchUrlPath(bookmark, rule) {
    try {
      const url = new URL(bookmark.url);
      const segments = url.pathname.split('/').filter(Boolean);
      const pattern = rule.pattern.toLowerCase();
      const pathMatch = segments.some(seg => seg.toLowerCase().includes(pattern));
      const queryMatch = url.search.toLowerCase().includes(pattern);
      return (pathMatch || queryMatch) ? { confidence: pathMatch ? 0.9 : 0.7 } : null;
    } catch { return null; }
  },

  matchCompound(bookmark, rule) {
    const conditions = rule.conditions || [];
    const logic = rule.logic || 'AND';
    const results = conditions.map(cond => this.matchRule(bookmark, cond));
    const matchCount = results.filter(r => r !== null).length;

    if (logic === 'AND' && matchCount === conditions.length) {
      const avg = results.reduce((s, r) => s + ((r && r.confidence) || 0), 0) / conditions.length;
      return { confidence: avg };
    }
    if (logic === 'OR' && matchCount > 0) {
      return { confidence: matchCount / conditions.length };
    }
    return null;
  },

  // ==================== 规则命中统计 ====================

  /**
   * 统计每条规则的命中情况
   * @returns {Array} 每条规则附带 hitCount 字段
   */
  getRuleStats(nodes, rules) {
    const bookmarks = nodes.filter(n => !n.isFolder && n.url);
    const stats = rules.map(rule => {
      let hitCount = 0;
      const matchedUrls = [];
      for (const bm of bookmarks) {
        const result = this.matchRule(bm, rule);
        if (result) {
          hitCount++;
          matchedUrls.push(bm.url);
        }
      }
      return {
        type: rule.type,
        pattern: rule.pattern,
        category: rule.category,
        hitCount,
        total: bookmarks.length,
        hitRate: bookmarks.length > 0 ? (hitCount / bookmarks.length * 100).toFixed(1) : '0'
      };
    });
    return stats.sort((a, b) => b.hitCount - a.hitCount);
  },

  // ==================== 批量分类 ====================

  autoClassify(nodes, rules) {
    const bookmarks = nodes.filter(n => !n.isFolder && n.url);
    const result = {};
    const uncategorized = [];

    for (const bm of bookmarks) {
      const match = this.classify(bm, rules);
      if (match) {
        if (!result[match.category]) result[match.category] = [];
        result[match.category].push({ ...bm, confidence: match.confidence });
      } else {
        uncategorized.push(bm);
      }
    }

    if (uncategorized.length > 0) result['未分类'] = uncategorized;
    return result;
  },

  // ==================== 相似书签聚类 ====================

  clusterSimilar(nodes, options = {}) {
    const bookmarks = nodes.filter(n => !n.isFolder && n.url);
    const threshold = options.threshold || 0.35;
    const features = bookmarks.map(bm => this.extractFeatures(bm));
    const clusters = [];
    const assigned = new Set();

    for (let i = 0; i < bookmarks.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [bookmarks[i]];
      assigned.add(i);

      for (let j = i + 1; j < bookmarks.length; j++) {
        if (assigned.has(j)) continue;
        const sim = this.computeSimilarity(features[i], features[j]);
        if (sim >= threshold) {
          cluster.push({ ...bookmarks[j], similarity: sim });
          assigned.add(j);
        }
      }

      if (cluster.length >= 2) {
        clusters.push({ name: this.generateClusterName(cluster), items: cluster });
      }
    }

    return clusters.sort((a, b) => b.items.length - a.items.length);
  },

  extractFeatures(bookmark) {
    let domain = '';
    try { domain = new URL(bookmark.url).hostname.replace(/^www\./, ''); } catch {}
    const titleTokens = this.tokenize(bookmark.title);
    const urlTokens = [];
    try { urlTokens.push(...this.tokenize(new URL(bookmark.url).pathname)); } catch {}
    const folderTokens = this.tokenize(bookmark.path || '');

    return {
      domain,
      allTokens: new Set([...titleTokens, ...urlTokens, ...folderTokens])
    };
  },

  tokenize(text) {
    if (!text) return [];
    const cleaned = text.toLowerCase().replace(/[^\w\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g, ' ');
    const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);
    const result = [...tokens];
    for (const token of tokens) {
      if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(token) && token.length > 2) {
        for (let i = 0; i < token.length - 1; i++) result.push(token.substring(i, i + 2));
      }
    }
    return result;
  },

  computeSimilarity(f1, f2) {
    const domainBonus = (f1.domain === f2.domain && f1.domain) ? 0.3 : 0;
    const intersection = new Set([...f1.allTokens].filter(x => f2.allTokens.has(x)));
    const union = new Set([...f1.allTokens, ...f2.allTokens]);
    const jaccard = union.size > 0 ? intersection.size / union.size : 0;
    return Math.min(jaccard + domainBonus, 1.0);
  },

  generateClusterName(cluster) {
    const stopWords = new Set([
      '书签栏', '书签', '签栏', '其他', '其他书签', '文件夹', '收藏', '收藏夹',
      'toolbar', 'bookmarks', 'bar', 'other', 'bookmark', 'folder',
      'menu', 'menu bar', ' bookmarks bar', 'bookmarks'
    ]);
    const wordCount = {};
    for (const item of cluster) {
      for (const token of this.extractFeatures(item).allTokens) {
        if (stopWords.has(token)) continue;
        wordCount[token] = (wordCount[token] || 0) + 1;
      }
    }
    const threshold = cluster.length * 0.5;
    const commonWords = Object.entries(wordCount)
      .filter(([_, c]) => c >= threshold).sort((a, b) => b[1] - a[1])
      .map(([w]) => w).slice(0, 3);

    if (commonWords.length > 0) return commonWords[0];

    const domains = {};
    for (const item of cluster) {
      try { const d = new URL(item.url).hostname.replace(/^www\./, ''); domains[d] = (domains[d] || 0) + 1; } catch {}
    }
    const top = Object.entries(domains).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : '相似书签';
  },

  getDefaultRules() { return Storage.DEFAULT_RULES; }
};
