// Server-side transactional email via the EmailJS REST API.
// Caller passes { template_params }; the helper supplies service/user/access creds
// from env vars (EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY).
//
// EMAILJS_SERVICE_ID must match an active service in the configured EmailJS
// account (currently `service_pbhgrg2` per project_youthhire_emailjs.md).
// Wrong service id surfaces as "[EMAILJS_FAIL] body=The service ID not found".
//
// Returns true on success, false on any failure (network, EmailJS error, missing
// config). Failures are logged but never thrown — callers can decide whether a
// missed email blocks their flow. For password reset specifically, we still
// succeed the user-facing request even if email send fails, to avoid leaking
// account existence via "email did/didn't send" signals.

export async function sendTransactionalEmail({ template_id, template_params }) {
  const serviceId  = process.env.EMAILJS_SERVICE_ID;
  const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  const tmpl       = template_id || process.env.EMAILJS_TEMPLATE_GENERAL || 'template_welcome';

  if (!serviceId || !publicKey || !privateKey) {
    console.error('email: EMAILJS env vars not configured — skipping send');
    return false;
  }
  if (!template_params || !template_params.to_email) {
    console.error('email: template_params.to_email required');
    return false;
  }

  // Cap the EmailJS call so a slow EmailJS upstream doesn't burn our 10s
  // function-timeout budget (saw 504s in production when EmailJS hung >10s).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: tmpl,
        user_id: publicKey,
        accessToken: privateKey,
        template_params,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // Combine status + body + meta into ONE console.error call. Vercel's log
      // table view shows the first stderr line per request; multiple errors
      // get collapsed. Single-line keeps the rejection reason visible.
      const flat = (body || '').substring(0, 400).replace(/\s+/g, ' ');
      console.error('[EMAILJS_FAIL] status=' + resp.status + ' tmpl=' + tmpl + ' to=' + template_params.to_email + ' body=' + flat);
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(timeoutId);
    const reason = e.name === 'AbortError' ? 'timeout_6s' : (e.message || 'unknown');
    console.error('[EMAILJS_FAIL] fetch_error=' + reason + ' tmpl=' + tmpl + ' to=' + template_params.to_email);
    return false;
  }
}
