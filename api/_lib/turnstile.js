// Cloudflare Turnstile server-side verification.
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// Returns true if the token is valid, false otherwise.
// Returns `true` when no secret is configured so local dev / env without Turnstile still works.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('TURNSTILE_SECRET_KEY not configured — skipping check');
    return true;
  }
  if (!token) return false;
  try {
    const body = new URLSearchParams();
    body.set('secret', secret);
    body.set('response', token);
    if (remoteIp) body.set('remoteip', remoteIp);
    const resp = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) {
      console.error('Turnstile verify HTTP', resp.status);
      return false;
    }
    const data = await resp.json();
    if (!data.success) {
      console.warn('Turnstile verify failed:', data['error-codes']);
    }
    return !!data.success;
  } catch (e) {
    console.error('Turnstile verify error:', e.message);
    return false;
  }
}
