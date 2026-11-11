// A tiny router. Patterns like /hub/teams/:team; each route carries the
// guards it needs (session, team membership, CSRF, rate limit), so a route
// cannot forget them: they run before its handler, in one place (server.js).

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, pattern, re, keys, handler, opts });
  }

  get(p, h, o) {
    this.add('GET', p, h, o);
  }

  post(p, h, o) {
    this.add('POST', p, h, o);
  }

  // { route, params } | { allowed: [methods] } (path known, method not) | null
  match(method, pathname) {
    const m = method === 'HEAD' ? 'GET' : method;
    const allowed = [];
    for (const r of this.routes) {
      const hit = r.re.exec(pathname);
      if (!hit) continue;
      if (r.method !== m) {
        allowed.push(r.method);
        continue;
      }
      const params = {};
      r.keys.forEach((k, i) => (params[k] = hit[i + 1]));
      return { route: r, params };
    }
    return allowed.length ? { allowed } : null;
  }
}
