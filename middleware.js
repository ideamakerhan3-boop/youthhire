// Vercel Edge Middleware — Basic Auth on non-production (preview) deployments only
// Production (www.canadayouthhire.ca) is never gated.

export const config = {
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};

export default function middleware(req) {
  const env = process.env.VERCEL_ENV || 'development';

  // Only gate preview/development. Production stays open.
  if (env === 'production') {
    return;
  }

  const USER = process.env.STAGING_USER || 'ideamakerhan';
  const PASS = process.env.STAGING_PASS || 'gks125412';

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

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="YouthHire Staging"',
      'Content-Type': 'text/plain',
    },
  });
}
