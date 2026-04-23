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

async function sendExpiryEmail(toEmail, toName, jobTitle, expDate, daysLeft) {
  const serviceId  = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_GENERAL || 'template_welcome';
  const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (!serviceId || !publicKey || !privateKey) {
    console.warn('EmailJS env vars not configured — skipping expiry email');
    return false;
  }

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
          to_email:    toEmail,
          to_name:     toName || toEmail,
          subject:     `Your job posting "${jobTitle}" expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          heading:     'Job Posting Expiring Soon',
          message:     `Your job posting "${jobTitle}" will expire on ${expDate}. If you'd like to keep it active, please renew it before the expiry date. Visit your dashboard to manage your postings.`,
          button_text: 'Go to Dashboard',
        },
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
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    // Select only needed columns
    const { data: activeJobs, error } = await sb
      .from('jobs')
      .select('id, job_id, email, title, company, exp_date, notified_expiry')
      .eq('status', 'active');

    if (error) throw error;
    if (!activeJobs || activeJobs.length === 0) {
      return res.status(200).json({ message: 'No active jobs', expired: 0, notified: 0 });
    }

    // Separate expired vs needs-notification
    const toExpire = [];
    const toNotify = [];

    for (const job of activeJobs) {
      const expDate = parseExpDate(job.exp_date);
      if (!expDate) continue;

      if (expDate < now) {
        toExpire.push(job.id);
      } else if (!job.notified_expiry) {
        const daysLeft = Math.ceil((expDate.getTime() - now.getTime()) / 86400000);
        if (daysLeft <= 7 && daysLeft > 0) {
          toNotify.push({ ...job, daysLeft });
        }
      }
    }

    // Batch expire: single UPDATE for all expired jobs
    if (toExpire.length > 0) {
      await sb.from('jobs').update({ status: 'expired' }).in('id', toExpire);
    }

    // Parallel email sends with concurrency limit (max 5 at a time)
    let notified = 0;
    const CONCURRENCY = 5;
    for (let i = 0; i < toNotify.length; i += CONCURRENCY) {
      const batch = toNotify.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(job => sendExpiryEmail(
          job.email,
          job.company || job.email,
          job.title || 'Untitled',
          job.exp_date,
          job.daysLeft
        ))
      );

      // Mark notified for successful sends
      const successIds = [];
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value === true) {
          successIds.push(batch[j].id);
          notified++;
        }
        console.log(`📧 Expiry notice ${results[j].status === 'fulfilled' && results[j].value ? 'sent' : 'skipped'}: ${batch[j].title} → ${batch[j].email} (${batch[j].daysLeft}d left)`);
      }

      // Batch update notified flags
      if (successIds.length > 0) {
        await sb.from('jobs').update({ notified_expiry: true }).in('id', successIds);
      }
    }

    console.log(`Cron: expired ${toExpire.length}, notified ${notified}/${activeJobs.length} jobs`);
    return res.status(200).json({
      message: `Expired ${toExpire.length} jobs, notified ${notified}`,
      expired: toExpire.length,
      notified,
      total: activeJobs.length,
    });

  } catch (err) {
    console.error('Expire jobs error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
