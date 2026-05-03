// Vercel Edge Middleware
// - Production: apex→www redirect, optional Basic Auth gate on /admin
// - Preview/development: Basic Auth on entire site (STAGING_USER/PASS)

export const config = {
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};

function basicAuthChallenge(realm) {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="' + realm + '"',
      'Content-Type': 'text/plain',
    },
  });
}

function checkBasicAuth(req, expectedUser, expectedPass) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    if (idx <= 0) return false;
    return decoded.slice(0, idx) === expectedUser && decoded.slice(idx + 1) === expectedPass;
  } catch (_) {
    return false;
  }
}

export default function middleware(req) {
  const env = process.env.VERCEL_ENV || 'development';

  // Production: apex→www redirect, then optional /admin Basic Auth gate.
  if (env === 'production') {
    const host = req.headers.get('host') || '';
    if (host === 'canadayouthhire.ca') {
      const url = new URL(req.url);
      return Response.redirect(
        'https://www.canadayouthhire.ca' + url.pathname + url.search,
        301
      );
    }

    // Defense-in-depth: server-level Basic Auth on /admin so the admin HTML
    // (~530KB exposing API action names + admin helpers) isn't readable by
    // anyone who guesses the route. API endpoints already verify is_admin
    // server-side, so this is purely belt-and-suspenders. Backwards-compatible:
    // if ADMIN_BASIC_USER / ADMIN_BASIC_PASS aren't set, /admin stays open
    // (current behavior). User adds the env to activate the gate.
    const ADMIN_USER = process.env.ADMIN_BASIC_USER;
    const ADMIN_PASS = process.env.ADMIN_BASIC_PASS;
    if (ADMIN_USER && ADMIN_PASS) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === '/admin' || p.startsWith('/admin/')) {
        if (!checkBasicAuth(req, ADMIN_USER, ADMIN_PASS)) {
          return basicAuthChallenge('YouthHire Admin');
        }
      }
    }
    return;
  }

  // Preview/development: gate the whole site with Basic Auth (fail closed if
  // env missing — avoids accidentally serving a public preview).
  const USER = process.env.STAGING_USER;
  const PASS = process.env.STAGING_PASS;
  if (USER && PASS && checkBasicAuth(req, USER, PASS)) return;
  return basicAuthChallenge('YouthHire Staging');
}
