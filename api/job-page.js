import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Only fetch columns needed for SEO rendering
const JOB_COLS = 'job_id, title, company, loc, prov, type, wage, category, remote, lang, edu, exp_req, description, requirements, benefits, apply_method, apply_url, apply_email, posted_date, created_at, exp_date';

/**
 * GET /api/job-page?id=585
 * Serves a pre-rendered HTML page for crawlers with full job details,
 * then redirects real users to the SPA via client-side JS.
 */
export default async function handler(req, res) {
  const id = req.query.id;
  if (!id) return res.redirect(301, 'https://www.canadayouthhire.ca/');

  const { data: job } = await sb.from('jobs')
    .select(JOB_COLS)
    .eq('job_id', id)
    .maybeSingle();

  if (!job) {
    return res.redirect(302, 'https://www.canadayouthhire.ca/');
  }

  const base = 'https://www.canadayouthhire.ca';
  const title = esc(job.title) + ' at ' + esc(job.company) + ' — YouthHire';
  const desc = esc(job.title) + ' job in ' + esc(job.loc || 'Canada') + '. ' + esc(job.type || 'Full-Time') + ' position at ' + esc(job.company) + '. Apply on YouthHire.';
  const url = base + '/jobs/' + id;
  const posted = job.posted_date || (job.created_at ? job.created_at.split('T')[0] : '');
  const expires = job.exp_date || '';
  const jobDesc = esc((job.description || '').substring(0, 500));

  // Escape JSON-LD to prevent </script> injection
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": job.title,
    "description": job.description || job.title,
    "datePosted": posted,
    "validThrough": expires || undefined,
    "employmentType": mapType(job.type),
    "hiringOrganization": {
      "@type": "Organization",
      "name": job.company
    },
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": job.loc || '',
        "addressRegion": job.prov || '',
        "addressCountry": "CA"
      }
    },
    "baseSalary": job.wage ? {
      "@type": "MonetaryAmount",
      "currency": "CAD",
      "value": { "@type": "QuantitativeValue", "value": job.wage }
    } : undefined,
    "jobLocationType": job.remote === 'remote' ? 'TELECOMMUTE' : undefined,
    "educationRequirements": job.edu && job.edu !== 'None' ? { "@type": "EducationalOccupationalCredential", "credentialCategory": job.edu } : undefined,
    "experienceRequirements": job.exp_req && job.exp_req !== 'No experience' ? job.exp_req : undefined,
    "url": url
  }).replace(/<\//g, '<\\/'); // prevent </script> breaking out of JSON-LD

  // Sanitize apply_url to block javascript: URIs
  const safeApplyUrl = job.apply_url && !isUnsafeUri(job.apply_url) ? esc(job.apply_url) : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<meta property="og:locale" content="en_CA">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="robots" content="index, follow">
<script type="application/ld+json">${jsonLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.6}
h1{color:#2563EB;font-size:28px;margin-bottom:4px}
.company{font-size:20px;font-weight:700;margin-bottom:16px}
.meta{color:#5A5A5A;font-size:14px;margin-bottom:24px}
.meta span{margin-right:16px}
.desc{white-space:pre-wrap;margin-bottom:32px}
.cta{display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px}
.footer{margin-top:48px;padding-top:20px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
a{color:#2563EB}
</style>
</head>
<body>
<nav style="margin-bottom:32px">
<a href="${base}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<a href="${base}">All Jobs</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>${esc(job.title)}</span>
</nav>

<h1>${esc(job.title)}</h1>
<div class="company">${esc(job.company)}</div>
<div class="meta">
<span>📍 ${esc(job.loc || 'Canada')}${job.prov ? ', ' + esc(job.prov) : ''}</span>
<span>💼 ${esc(job.type || 'Full-Time')}</span>
${job.wage ? '<span>💰 ' + esc(job.wage) + '</span>' : ''}
${job.category ? '<span>📂 ' + esc(job.category) + '</span>' : ''}
${job.remote && job.remote !== 'onsite' ? '<span>🏠 ' + esc(job.remote) + '</span>' : ''}
${job.lang && job.lang !== 'English' ? '<span>🌐 ' + esc(job.lang) + '</span>' : ''}
</div>
${(job.edu && job.edu !== 'None') || (job.exp_req && job.exp_req !== 'No experience') ? '<p style="font-size:13px;color:#5A5A5A;margin-bottom:8px">' + (job.edu && job.edu !== 'None' ? '🎓 ' + esc(job.edu) : '') + (job.exp_req && job.exp_req !== 'No experience' ? ' · 📋 ' + esc(job.exp_req) : '') + '</p>' : ''}
${posted ? '<p style="font-size:13px;color:#919191">Posted: ' + esc(posted) + (expires ? ' · Expires: ' + esc(expires) : '') + '</p>' : ''}

<div class="desc">${jobDesc}${job.description && job.description.length > 500 ? '...' : ''}</div>
${job.requirements ? '<h3 style="margin:16px 0 8px;font-size:16px">Requirements</h3><ul>' + job.requirements.split('\\n').filter(Boolean).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' : ''}
${job.benefits ? '<h3 style="margin:16px 0 8px;font-size:16px">Benefits</h3><ul>' + job.benefits.split('\\n').filter(Boolean).map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>' : ''}

${job.apply_method === 'url' && safeApplyUrl ? '<p style="margin:16px 0"><strong>Apply:</strong> <a href="' + safeApplyUrl + '" style="color:#2563EB;font-weight:700">' + safeApplyUrl + '</a></p>' : ''}
${job.apply_method === 'email' && job.apply_email ? '<p style="margin:16px 0"><strong>Apply:</strong> <a href="mailto:' + esc(job.apply_email) + '" style="color:#2563EB;font-weight:700">' + esc(job.apply_email) + '</a></p>' : ''}
<a href="${base}/#detail-${id}" class="cta">View Full Posting & Apply →</a>

<div class="footer">
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p>Operated by MOSAIC CANADA RESTAURANT INC.</p>
<p><a href="${base}/about">About</a> · <a href="${base}/contact">Contact</a> · <a href="${base}/privacy">Privacy</a> · <a href="${base}/terms">Terms</a></p>
</div>

<script>
// Real users get redirected to SPA for full experience
if(navigator.userAgent && !/bot|crawl|spider|slurp|Googlebot|Bingbot|DuckDuck|Yandex|Baidu/i.test(navigator.userAgent)){
  window.location.replace('${base}/?openJob=${id}');
}
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
  return res.status(200).send(html);
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isUnsafeUri(uri) {
  if (!uri) return true;
  const lower = uri.trim().toLowerCase();
  return lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:');
}

function mapType(t) {
  if (!t) return 'FULL_TIME';
  var l = t.toLowerCase();
  if (l.indexOf('part') >= 0) return 'PART_TIME';
  if (l.indexOf('contract') >= 0) return 'CONTRACTOR';
  if (l.indexOf('temp') >= 0) return 'TEMPORARY';
  if (l.indexOf('intern') >= 0) return 'INTERN';
  return 'FULL_TIME';
}
