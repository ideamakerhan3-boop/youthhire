// Shared alert utilities for Twilio voice + EmailJS SMS
// Used by: health-check.js, stripe-webhook.js

const ALERT_PHONE = process.env.ALERT_PHONE || '+12508554037';
const ALERT_TO = process.env.ALERT_PHONE_EMAIL || '2508554037@txt.bell.ca';

export async function sendVoiceCall(message) {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) { console.error('Twilio not configured'); return false; }
  const safe = String(message).replace(/[<>&]/g, ' ').substring(0, 200);
  const twiml = `<Response><Say voice="alice">${safe}</Say><Pause length="1"/><Say voice="alice">${safe}</Say></Response>`;
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: ALERT_PHONE, From: from, Twiml: twiml }).toString(),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('Twilio call failed:', resp.status, txt);
      return false;
    }
    console.log('📞 Voice call placed');
    return true;
  } catch (e) { console.error('Twilio error:', e.message); return false; }
}

export async function sendSmsAlert(subject, body) {
  const serviceId  = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_GENERAL || 'template_welcome';
  const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  if (!serviceId || !publicKey || !privateKey) { console.error('EmailJS not configured'); return false; }
  try {
    const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        accessToken: privateKey,
        template_params: {
          to_email: ALERT_TO,
          to_name: 'Admin',
          subject,
          heading: subject,
          message: (body || '').substring(0, 140),
          button_text: '',
        },
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('SMS alert failed:', resp.status, txt);
      return false;
    }
    console.log('📱 SMS alert sent:', subject);
    return true;
  } catch (e) { console.error('EmailJS error:', e.message); return false; }
}
