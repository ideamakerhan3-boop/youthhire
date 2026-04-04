import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseExpDate(expStr) {
  if (!expStr) return null;
  try {
    var parts = expStr.replace(',','').split(' ');
    var mIdx = MONTHS.indexOf(parts[0]);
    if (mIdx < 0) return null;
    return new Date(parseInt(parts[2]), mIdx, parseInt(parts[1]));
  } catch(e) { return null; }
}

// EmailJS REST API로 이메일 발송 (서버사이드)
async function sendExpiryEmail(toEmail, toName, jobTitle, expDate, daysLeft) {
  const serviceId  = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_GENERAL || 'template_welcome';
  const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (!serviceId || !publicKey || !privateKey) {
    console.warn('EmailJS env vars not configured — skipping expiry email');
    return false;
  }

  const params = {
    to_email:    toEmail,
    to_name:     toName || toEmail,
    subject:     `Your job posting "${jobTitle}" expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    heading:     'Job Posting Expiring Soon',
    message:     `Your job posting "${jobTitle}" will expire on ${expDate}. If you'd like to keep it active, please renew it before the expiry date. Visit your dashboard to manage your postings.`,
    button_text: 'Go to Dashboard',
  };

  try {
    const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id:      serviceId,
        template_id:     templateId,
        user_id:         publicKey,
        accessToken:     privateKey,
        template_params: params,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error('EmailJS send failed:', resp.status, txt);
      return false;
    }
    return true;
  } catch (e) {
    console.error('EmailJS fetch error:', e.message);
    return false;
  }
}

// Vercel Cron: 매일 06:00 UTC에 실행
// GET /api/expire-jobs
export default async function handler(req, res) {
  // Vercel Cron 인증 (CRON_SECRET 필수)
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const { data: activeJobs, error } = await sb
      .from('jobs')
      .select('id, job_id, email, title, company, exp_date, status, notified_expiry')
      .eq('status', 'active');

    if (error) throw error;
    if (!activeJobs || activeJobs.length === 0) {
      return res.status(200).json({ message: 'No active jobs', expired: 0, notified: 0 });
    }

    let expired = 0;
    let notified = 0;

    for (const job of activeJobs) {
      const expDate = parseExpDate(job.exp_date);
      if (!expDate) continue;

      // ── 만료 처리 ──
      if (expDate < now) {
        await sb.from('jobs').update({ status: 'expired' }).eq('id', job.id);
        expired++;
        continue;
      }

      // ── 7일 전 알림 ──
      if (job.notified_expiry) continue; // 이미 알림 전송됨

      const msLeft = expDate.getTime() - now.getTime();
      const daysLeft = Math.ceil(msLeft / 86400000);

      if (daysLeft <= 7 && daysLeft > 0) {
        // 이메일 발송 시도
        const sent = await sendExpiryEmail(
          job.email,
          job.company || job.email,
          job.title || 'Untitled',
          job.exp_date,
          daysLeft
        );

        // 발송 성공/실패 상관없이 한 번만 시도 (무한 재시도 방지)
        await sb.from('jobs').update({ notified_expiry: true }).eq('id', job.id);
        if (sent) notified++;
        console.log(`📧 Expiry notice ${sent ? 'sent' : 'skipped'}: ${job.title} → ${job.email} (${daysLeft}d left)`);
      }
    }

    console.log(`Cron: expired ${expired}, notified ${notified}/${activeJobs.length} jobs`);
    return res.status(200).json({
      message: `Expired ${expired} jobs, notified ${notified}`,
      expired,
      notified,
      total: activeJobs.length,
    });

  } catch (err) {
    console.error('Expire jobs error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
