// Server-side transactional email via the EmailJS REST API.
// Caller passes { template_params }; the helper supplies service/user/access creds
// from env vars (EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY).
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
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('email: send failed', resp.status, body.substring(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('email: fetch error', e.message);
    return false;
  }
}
