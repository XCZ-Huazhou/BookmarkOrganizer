/**
 * 书签树遍历、扁平化、统计、去重模块
 */
const BookmarkTree = {
  async getFullTree() {
    const tree = await BrowserAPI.bookmarks.getTree();
    return tree[0];
  },

  flattenTree(node, path = '', depth = 0) {
    const currentPath = path ? `${path} / ${node.title}` : node.title;
    const isFolder = !node.url;
    const result = {
      id: node.id, title: node.title, url: node.url || null,
      parentId: node.parentId, dateAdded: node.dateAdded,
      path: currentPath, depth, isFolder,
      childCount: node.children ? node.children.length : 0
    };
    let all = [result];
    if (node.children) {
      for (const child of node.children) {
        all = all.concat(this.flattenTree(child, currentPath, depth + 1));
      }
    }
    return all;
  },

  getTreeStats(nodes) {
    const bookmarks = nodes.filter(n => !n.isFolder && n.url);
    const folders = nodes.filter(n => n.isFolder);
    const domainMap = {};
    for (const bm of bookmarks) {
      try {
        const domain = new URL(bm.url).hostname.replace(/^www\./, '');
        domainMap[domain] = (domainMap[domain] || 0) + 1;
      } catch {}
    }
    const topDomains = Object.entries(domainMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const depthMap = {};
    for (const node of nodes) {
      depthMap[node.depth] = (depthMap[node.depth] || 0) + 1;
    }
    return {
      totalBookmarks: bookmarks.length, totalFolders: folders.length,
      maxDepth: Math.max(...nodes.map(n => n.depth), 0),
      topDomains, depthDistribution: depthMap,
      emptyFolders: this.findEmptyFolders(nodes)
    };
  },

  findEmptyFolders(nodes) {
    return nodes.filter(n => n.isFolder && n.childCount === 0 && n.depth > 0);
  },

  findNode(root, id) {
    if (root.id === id) return root;
    if (root.children) {
      for (const child of root.children) {
        const found = this.findNode(child, id);
        if (found) return found;
      }
    }
    return null;
  },

  getFoldersOnly(nodes) {
    return nodes.filter(n => n.isFolder);
  }
};

