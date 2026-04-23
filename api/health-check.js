import { createClient } from '@supabase/supabase-js';
import { sendVoiceCall, sendSmsAlert } from './_lib/alerts.js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SITE_BASE = 'https://www.canadayouthhire.ca';
const RE_ALERT_HOURS = 1;

// ── Update monitor state and alert if needed ──
async function recordCheck(checkName, ok, errorMsg) {
  const { data: prev } = await sb.from('monitor_state').select('status, consecutive_failures, last_alert_sent').eq('check_name', checkName).maybeSingle();
  const now = new Date();
  const newStatus = ok ? 'ok' : 'error';
  const prevStatus = prev?.status || 'ok';
  const consecutive = ok ? 0 : ((prev?.consecutive_failures || 0) + 1);

  let shouldAlert = false;
  let alertReason = '';

  if (!ok) {
    if (prevStatus === 'ok') {
      shouldAlert = true;
      alertReason = 'NEW';
    } else if (prev?.last_alert_sent) {
      const hoursSince = (now - new Date(prev.last_alert_sent)) / 3600000;
      if (hoursSince >= RE_ALERT_HOURS) {
        shouldAlert = true;
        alertReason = 'PERSISTING';
      }
    } else {
      shouldAlert = true;
      alertReason = 'NEW';
    }
  } else if (prevStatus === 'error') {
    shouldAlert = true;
    alertReason = 'RECOVERED';
  }

  let alertSent = prev?.last_alert_sent || null;
  if (shouldAlert) {
    const subject = ok ? `✅ TIJobs OK: ${checkName}` : `⚠️ TIJobs ${alertReason}: ${checkName}`;
    const body = ok
      ? `Check "${checkName}" recovered at ${now.toISOString().substring(11,19)} UTC.`
      : `${errorMsg} (fail #${consecutive})`;
    const sent = await sendSmsAlert(subject, body);
    if (!ok) {
      const voiceMsg = `YouthHire alert. Check ${checkName.replace(/_/g, ' ')} is failing. ${alertReason} error.`;
      await sendVoiceCall(voiceMsg);
    }
    if (sent) alertSent = now.toISOString();
  }

  await sb.from('monitor_state').upsert({
    check_name: checkName,
    status: newStatus,
    last_checked: now.toISOString(),
    last_alert_sent: alertSent,
    last_error: ok ? null : errorMsg,
    consecutive_failures: consecutive,
  }, { onConflict: 'check_name' });

  return { ok, alerted: shouldAlert, reason: alertReason };
}

// ── Individual checks ──
async function checkSiteUp() {
  try {
    const resp = await fetch(SITE_BASE, { method: 'HEAD' }); // HEAD is faster than GET
    if (!resp.ok) return { ok: false, error: `Main page HTTP ${resp.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Main page fetch failed: ${e.message}` };
  }
}

async function checkSitemap() {
  try {
    const resp = await fetch(`${SITE_BASE}/sitemap.xml`);
    if (!resp.ok) return { ok: false, error: `Sitemap HTTP ${resp.status}` };
    const txt = await resp.text();
    if (!txt.includes('<urlset')) return { ok: false, error: 'Sitemap malformed' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Sitemap fetch failed: ${e.message}` };
  }
}

async function checkCreditsApi() {
  try {
    const resp = await fetch(`${SITE_BASE}/api/credits-api`, { method: 'OPTIONS' });
    if (resp.status !== 200 && resp.status !== 204) return { ok: false, error: `credits-api OPTIONS ${resp.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `credits-api unreachable: ${e.message}` };
  }
}

async function checkDbIntegrity() {
  try {
    // Parallel: fetch both tables at once, select only needed columns
    const [txnRes, creditRes] = await Promise.all([
      sb.from('transactions').select('email, credits').eq('status', 'paid').gte('credits', 1),
      sb.from('credits').select('email, total'),
    ]);
    if (txnRes.error) return { ok: false, error: `txn query: ${txnRes.error.message}` };
    if (creditRes.error) return { ok: false, error: `credits query: ${creditRes.error.message}` };

    const expected = {};
    (txnRes.data || []).forEach(t => {
      const em = (t.email || '').toLowerCase();
      if (!em) return;
      expected[em] = (expected[em] || 0) + (t.credits || 0);
    });

    const actual = {};
    (creditRes.data || []).forEach(c => {
      const em = (c.email || '').toLowerCase();
      actual[em] = c.total || 0;
    });

    const mismatches = [];
    for (const em in expected) {
      const exp = expected[em];
      const act = actual[em] || 0;
      if (act < exp) {
        mismatches.push(`${em}: expected ${exp}, got ${act}`);
      }
    }

    if (mismatches.length > 0) {
      return { ok: false, error: `Credit mismatch: ${mismatches.slice(0, 3).join('; ')}` };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: `DB integrity check error: ${e.message}` };
  }
}

async function checkHtmlIntegrity() {
  try {
    const resp = await fetch(SITE_BASE);
    if (!resp.ok) return { ok: false, error: `HTML fetch HTTP ${resp.status}` };
    const html = await resp.text();

    if (html.length < 10000) {
      return { ok: false, error: `HTML too small (${html.length} bytes) — possibly broken render` };
    }
    if (!html.includes('</body>')) {
      return { ok: false, error: 'HTML missing </body> — incomplete render' };
    }

    const badPatterns = [
      { re: /\[email&#160;protected\]|\[email protected\]/i, msg: 'Cloudflare [email protected] leftover' },
      { re: /__cf_email__|data-cfemail|\/cdn-cgi\/l\/email-protection/i, msg: 'Cloudflare email obfuscation markup' },
      { re: /canadajobboard/i, msg: 'Wrong domain canadajobboard leftover' },
      { re: /lorem ipsum/i, msg: 'Lorem ipsum placeholder' },
      { re: />\s*TODO\s*</i, msg: 'TODO placeholder visible in HTML' },
      { re: />\s*FIXME\s*</i, msg: 'FIXME placeholder visible in HTML' },
      { re: /YOUR_[A-Z_]+_HERE/, msg: 'Unfilled YOUR_*_HERE placeholder' },
    ];

    const found = [];
    for (const p of badPatterns) {
      if (p.re.test(html)) found.push(p.msg);
    }

    if (found.length > 0) {
      return { ok: false, error: 'HTML integrity: ' + found.slice(0, 3).join('; ') };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: `HTML integrity check error: ${e.message}` };
  }
}

async function checkRefundOrphans() {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return { ok: true };

    const since = Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
    const resp = await fetch(`https://api.stripe.com/v1/refunds?created[gte]=${since}&limit=100`, {
      headers: { 'Authorization': 'Bearer ' + stripeKey },
    });
    if (!resp.ok) return { ok: false, error: `Stripe refunds list HTTP ${resp.status}` };
    const data = await resp.json();
    const refunds = data.data || [];
    if (refunds.length === 0) return { ok: true };

    // Batch: get all payment_intents at once instead of N queries
    const piList = refunds.map(r => r.payment_intent).filter(Boolean);
    if (piList.length === 0) return { ok: true };

    const { data: txns } = await sb
      .from('transactions')
      .select('payment_intent, status')
      .in('payment_intent', piList);

    const refundedPIs = new Set((txns || []).filter(t => t.status === 'refunded').map(t => t.payment_intent));

    const orphans = [];
    for (const r of refunds) {
      if (!r.payment_intent) continue;
      if (!refundedPIs.has(r.payment_intent)) {
        orphans.push(`${r.id} (PI=${r.payment_intent}, $${(r.amount/100).toFixed(2)})`);
      }
    }

    if (orphans.length > 0) {
      return { ok: false, error: `Stripe refund(s) not reflected in DB: ${orphans.slice(0,3).join('; ')}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `refund check error: ${e.message}` };
  }
}

// ── Main handler ──
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  const auth = req.headers.authorization || '';
  const querySecret = (req.query && req.query.secret) || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && querySecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const checks = [
    { name: 'site_up', fn: checkSiteUp },
    { name: 'html_integrity', fn: checkHtmlIntegrity },
    { name: 'sitemap', fn: checkSitemap },
    { name: 'credits_api', fn: checkCreditsApi },
    { name: 'db_integrity', fn: checkDbIntegrity },
    { name: 'refund_orphans', fn: checkRefundOrphans },
  ];

  // Run all checks in parallel instead of sequential
  const settled = await Promise.allSettled(checks.map(c => c.fn()));
  const results = {};

  // Record results (must be sequential — each writes to monitor_state)
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const s = settled[i];
    if (s.status === 'fulfilled') {
      const r = s.value;
      const recorded = await recordCheck(c.name, r.ok, r.error || null);
      results[c.name] = { ok: r.ok, error: r.error || null, alerted: recorded.alerted, reason: recorded.reason };
    } else {
      results[c.name] = { ok: false, error: 'check threw: ' + (s.reason?.message || 'unknown') };
    }
  }

  const allOk = Object.values(results).every(r => r.ok);
  return res.status(200).json({
    timestamp: new Date().toISOString(),
    overall: allOk ? 'ok' : 'error',
    checks: results,
  });
}
