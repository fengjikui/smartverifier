/** 丝印检测的公共地址。未来其他检测类型可与 marking 并列。 */
export const MARKING_BASE = '/inspections/marking';
export const MARKING_API = '/api/v1/inspections/marking';
export const markingPaths = {
  workbench: MARKING_BASE,
  standards: MARKING_BASE + '/admin/standards',
  preview: MARKING_BASE + '/preview/tablet',
  loginPreview: MARKING_BASE + '/preview/login',
  debug: MARKING_BASE + '/debug/model',
};

/** 保留组件内部路由词汇，只在公共地址边界映射到资源路径。 */
export function adminPath(route = 'references'): string {
  const [kind, id, context] = route.split('/');
  const base = MARKING_BASE + '/admin';
  switch (kind) {
    case 'references': return base + '/standards';
    case 'new': return base + '/standards/new';
    case 'edit': case 'copy': return base + '/standards/' + id + '/' + kind;
    case 'detail': return base + '/standards/' + id + (context === 'trash' ? '?from=trash' : '');
    case 'trash': return base + '/standards/trash';
    case 'import': return base + '/imports';
    case 'audit': return base + '/audit-logs';
    default: return base + '/' + route;
  }
}

export function adminRoute(pathname: string, search = ''): string {
  const route = pathname.slice((MARKING_BASE + '/admin').length).replace(/^\/+|\/+$/g, '');
  if (!route || route === 'standards') return 'references';
  if (route === 'standards/new') return 'new';
  if (route === 'standards/trash') return 'trash';
  if (route === 'imports') return 'import';
  if (route === 'audit-logs') return 'audit';
  const record = route.match(/^standards\/([^/]+)(?:\/(edit|copy))?$/);
  if (record) return record[2] ? record[2] + '/' + record[1] : 'detail/' + record[1] + (new URLSearchParams(search).get('from') === 'trash' ? '/trash' : '');
  return route;
}

/** 仅认可当前模块的网页与资源入口，不再注册旧地址或其跳转。 */
export function canonicalPage(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '');
  if (path === MARKING_BASE || path === markingPaths.preview || path === markingPaths.loginPreview || path === markingPaths.debug) return path;
  if (path === MARKING_BASE + '/admin') return markingPaths.standards;
  const admin = MARKING_BASE + '/admin/';
  if (['standards','standards/new','standards/trash','imports','audit-logs','tasks','users'].some(route => path === admin + route)) return path;
  if (path.startsWith(admin) && /^standards\/[a-f0-9-]{36}(?:\/(?:edit|copy))?$/.test(path.slice(admin.length))) return path;
  if (path.startsWith(MARKING_BASE + '/assets/')) return path;
  return null;
}

/** 调用方直接使用正式资源名称，不接受旧 API 前缀或别名。 */
export function apiPath(route: string): string {
  if (route === MARKING_API || route.startsWith(MARKING_API + '/')) return route;
  if (!route.startsWith('/') || route.startsWith('/api/')) throw new Error('请使用模块内的规范 API 资源路径。');
  return MARKING_API + route;
}

export function apiRoute(pathname: string): string | null {
  return pathname.startsWith(MARKING_API + '/') ? pathname.slice(MARKING_API.length) : null;
}

export const assetPath = (name: string) => MARKING_BASE + '/assets/' + name;
export function publicUrl(value: string): string {
  if (value.startsWith(MARKING_API + '/')) return value;
  // 仅转换存量资料中的链接；对应的旧 HTTP 路由已移除。
  if (value.startsWith('/api/')) return apiPath(value.slice(4));
  if (value.startsWith('/assets/')) return assetPath(value.slice(8));
  return value;
}

const linkFields = new Set(['url', 'image', 'thumbnail', 'uprightUrl', 'annotatedUrl', 'sheetUrl', 'reportUrl']);
/** 只改写已知链接字段，既不迁移历史数据，也不更改描述或模型原始文本。 */
export function publicLinkReplacer(key: string, value: unknown): unknown {
  return typeof value === 'string' && linkFields.has(key) ? publicUrl(value) : value;
}
