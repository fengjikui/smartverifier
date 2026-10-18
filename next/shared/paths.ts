/** 丝印检测的公共地址。未来其他检测类型可与 marking 并列。 */
export const MARKING_BASE = '/inspections/marking';
export const MARKING_API = '/api/v1/inspections/marking';
export const markingPaths = {
  workbench: MARKING_BASE,
  standards: MARKING_BASE + '/admin/standards',
  preview: MARKING_BASE + '/preview/tablet',
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

/** 旧页地址迁移；null 代表不属于已知的旧入口。查询参数由调用方原样保留。 */
export function canonicalPage(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return MARKING_BASE;
  if (path === '/tablet-preview' || path === MARKING_BASE + '/tablet-preview') return markingPaths.preview;
  if (path === '/debug/model') return markingPaths.debug;
  if (path === '/admin' || path.startsWith('/admin/')) return adminPath(path.slice(7) || 'references');
  if (path === MARKING_BASE + '/admin') return markingPaths.standards;
  if (path === MARKING_BASE || path.startsWith(MARKING_BASE + '/')) return path;
  return null;
}

/** 接口采用版本号 + 业务命名空间；旧名称只作为兼容入口。 */
export function apiPath(route: string): string {
  if (route === MARKING_API || route.startsWith(MARKING_API + '/')) return route;
  const suffix = route.startsWith('/api/') ? route.slice(4) : route;
  return MARKING_API + suffix
    .replace(/^\/task-list(?=\?|$)/, '/tasks')
    .replace(/^\/standalone(?=\/|\?|$)/, '/checks')
    .replace(/^\/admin\/references(?=\/|\?|$)/, '/admin/standards')
    .replace(/^\/admin\/events(?=\?|$)/, '/admin/audit-logs');
}

export function internalApiPath(pathname: string): string {
  if (pathname !== MARKING_API && !pathname.startsWith(MARKING_API + '/')) return pathname;
  return '/api' + pathname.slice(MARKING_API.length)
    .replace(/^\/tasks$/, '/task-list')
    .replace(/^\/checks(?=\/|$)/, '/standalone')
    .replace(/^\/admin\/standards(?=\/|$)/, '/admin/references')
    .replace(/^\/admin\/audit-logs$/, '/admin/events');
}

export const assetPath = (name: string) => MARKING_BASE + '/assets/' + name;
export function publicUrl(value: string): string {
  if (value.startsWith('/api/')) return apiPath(value);
  if (value.startsWith('/assets/')) return assetPath(value.slice(8));
  return value;
}

const linkFields = new Set(['url', 'image', 'thumbnail', 'uprightUrl', 'annotatedUrl', 'sheetUrl', 'reportUrl']);
/** 只改写已知链接字段，既不迁移历史数据，也不更改描述或模型原始文本。 */
export function publicLinkReplacer(key: string, value: unknown): unknown {
  return typeof value === 'string' && linkFields.has(key) ? publicUrl(value) : value;
}
