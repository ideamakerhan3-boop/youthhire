import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');

  const base = 'https://www.canadayouthhire.ca';

  // Static pages
  // SPA: only include pages that render unique content without JS.
  // Other routes (about, contact, pricing, etc.) are JS-rendered from same index.html,
  // which Google sees as duplicates. Removed to fix Search Console "duplicate canonical" warnings.
  const staticPages = [
    { loc: '/', changefreq: 'daily', priority: '1.0' },
  ];

  // Active jobs from DB
  let jobEntries = [];
  try {
    const { data: jobs, error } = await sb.from('jobs').select('job_id, title, company, loc, created_at')
      .eq('status', 'active').order('created_at', { ascending: false }).limit(500);
    if (error) console.error('sitemap DB error:', error.message);

    if (jobs) {
      jobEntries = jobs.map(function(j) {
        const slug = (j.title + '-' + j.company).toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
        const lastmod = j.created_at ? j.created_at.split('T')[0] : new Date().toISOString().split('T')[0];
        return `  <url>
    <loc>${base}/jobs/${j.job_id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
      });
    }
  } catch (e) {
    console.error('sitemap job fetch error:', e.message);
  }

  const staticXml = staticPages.map(function(p) {
    return `  <url>
    <loc>${base}${p.loc}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticXml}
${jobEntries.join('\n')}
</urlset>`;

  return res.status(200).send(xml);
}
