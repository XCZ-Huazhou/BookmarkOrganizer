/**
 * BrowserAPI.storage 封装模块
 */
const Storage = {
  DEFAULT_RULES: [
    { category: '开发', type: 'domain', pattern: 'github.com' },
    { category: '开发', type: 'domain', pattern: 'stackoverflow.com' },
    { category: '开发', type: 'domain', pattern: 'developer.mozilla.org' },
    { category: '开发', type: 'domain', pattern: 'npmjs.com' },
    { category: '视频', type: 'domain', pattern: 'youtube.com' },
    { category: '视频', type: 'domain', pattern: 'bilibili.com' },
    { category: '社交', type: 'domain', pattern: 'twitter.com' },
    { category: '社交', type: 'domain', pattern: 'x.com' },
    { category: '社交', type: 'domain', pattern: 'weibo.com' },
    { category: '社交', type: 'domain', pattern: 'zhihu.com' },
    { category: 'AI', type: 'domain', pattern: 'openai.com' },
    { category: 'AI', type: 'domain', pattern: 'anthropic.com' },
    { category: 'AI', type: 'domain', pattern: 'huggingface.co' },
    { category: '购物', type: 'domain', pattern: 'amazon.com' },
    { category: '购物', type: 'domain', pattern: 'taobao.com' },
    { category: '购物', type: 'domain', pattern: 'jd.com' },
    { category: '新闻', type: 'keyword', pattern: ['news', '新闻', '资讯'] },
    { category: '学习', type: 'keyword', pattern: ['tutorial', '教程', '文档', 'documentation', 'guide'] }
  ],

  DEFAULT_CONFIG: {
    deadLinkConcurrency: 5,
    deadLinkTimeout: 10000,
    clusterThreshold: 0.35
  },

  async getRules() {
    const result = await BrowserAPI.storage.local.get('rules');
    return result.rules || this.DEFAULT_RULES;
  },

  async setRules(rules) {
    await BrowserAPI.storage.local.set({ rules });
  },

  async getConfig() {
    const result = await BrowserAPI.storage.local.get('config');
    return { ...this.DEFAULT_CONFIG, ...result.config };
  },

  async setConfig(config) {
    await BrowserAPI.storage.local.set({ config });
  }
};

