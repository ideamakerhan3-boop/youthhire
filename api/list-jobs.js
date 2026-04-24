import { createClient } from '@supabase/supabase-js';
import { rateLimit } from './_lib/ratelimit.js';

// Public, unauthenticated read path for jobs.
//
// Two modes, one function (Vercel Hobby plan caps us at 12 serverless
// functions, so we can't split this):
//   GET /api/list-jobs             — array of active jobs for the feed;
//                                    drops apply_email to block bulk harvest.
//   GET /api/list-jobs?id=<job_id> — single active job including apply_email,
//                                    hit lazily when the user clicks a card.
//
// Service key bypasses RLS; column allow-list enforces what leaves the DB.

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALLOWED_ORIGINS = [
  'https://www.canadayouthhire.ca',
  'https://canadayouthhire.ca',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/youthhire-[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return (Array.isArray(xff) ? xff[0] : xff.split(',')[0]).trim() || req.socket?.remoteAddress || 'unknown';
}

const LIST_COLS = [
  'job_id', 'title', 'company', 'loc', 'prov', 'biz_city', 'biz_prov',
  'type', 'category', 'wage', 'remote', 'lang', 'edu', 'exp_req',
  'vacancy', 'ai_use', 'description', 'requirements', 'benefits',
  'status', 'posted_date', 'exp_date', 'apply_method', 'apply_url',
].join(', ');

const DETAIL_COLS = LIST_COLS + ', apply_email';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const ip = clientIp(req);
  const id = String(req.query.id || '').trim();

  try {
    // ─── Detail mode ──────────────────────────────────────────────
    // Lazy per-job fetch with apply_email. Tighter per-IP cap than the
    // list path because each hit returns an email (harvest vector).
    if (id) {
      if (!/^[0-9a-z_\-]+$/i.test(id)) return res.status(400).json({ error: 'invalid id' });
      const ok = await rateLimit(sb, 'jobdetail:' + ip, 60, 600_000);
      if (!ok) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

      const { data: job, error } = await sb.from('jobs')
        .select(DETAIL_COLS)
        .eq('job_id', id)
        .eq('status', 'active')
        .maybeSingle();

      if (error) {
        console.error('list-jobs detail error:', error.message);
        return res.status(500).json({ error: 'Failed to load job' });
      }
      if (!job) return res.status(404).json({ error: 'Job not found' });

      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ job });
    }

    // ─── List mode ────────────────────────────────────────────────
    // 100 requests per IP per 10 minutes — plenty for real users, blunts scraping.
    const ok = await rateLimit(sb, 'listjobs:' + ip, 100, 600_000);
    if (!ok) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

    const { data, error } = await sb.from('jobs')
      .select(LIST_COLS)
      .eq('status', 'active')
      .order('posted_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('list-jobs error:', error.message);
      return res.status(500).json({ error: 'Failed to load jobs' });
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ jobs: data || [] });
  } catch (err) {
    console.error('list-jobs exception:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
