// Vercel Edge Middleware — Basic Auth on non-production (preview) deployments only
// Production (www.canadayouthhire.ca) is never gated.

export const config = {
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};

export default function middleware(req) {
  const env = process.env.VERCEL_ENV || 'development';

  // Production: enforce apex -> www canonical (SEO + HSTS parity).
  if (env === 'production') {
    const host = req.headers.get('host') || '';
    if (host === 'canadayouthhire.ca') {
      const url = new URL(req.url);
      return Response.redirect(
        'https://www.canadayouthhire.ca' + url.pathname + url.search,
        301
      );
    }
    return;
  }

  const USER = process.env.STAGING_USER;
  const PASS = process.env.STAGING_PASS;

  if (USER && PASS) {
    const auth = req.headers.get('authorization') || '';
    if (auth.startsWith('Basic ')) {
      try {
        const decoded = atob(auth.slice(6));
        const idx = decoded.indexOf(':');
        const u = decoded.slice(0, idx);
        const p = decoded.slice(idx + 1);
        if (u === USER && p === PASS) {
          return; // allow through
        }
      } catch (_) {}
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="YouthHire Staging"',
      'Content-Type': 'text/plain',
    },
  });
}
