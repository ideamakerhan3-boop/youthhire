import { createClient } from '@supabase/supabase-js';

// Service key bypasses RLS — all sensitive account/job operations go through here.
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
  if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Verify account credentials, returns account row or null
async function verifyAuth(email, pw_hash) {
  if (!email || !pw_hash) return null;
  const { data: acct } = await sb.from('accounts')
    .select('email, pw, name, company, is_admin, status')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (!acct || acct.pw !== pw_hash) return null;
  return acct;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { action } = body;

    // ──────────────── REGISTER (no prior auth) ────────────────
    if (action === 'register') {
      const { email, pw_hash, name, company } = body;
      if (!email || !pw_hash) return res.status(400).json({ error: 'email and pw_hash required' });
      if (!/^[a-f0-9]{64}$/.test(pw_hash)) return res.status(400).json({ error: 'invalid pw_hash format' });
      const em = email.toLowerCase();

      // Check if already exists
      const { data: existing } = await sb.from('accounts').select('email, is_admin').eq('email', em).maybeSingle();
      if (existing) {
        return res.status(409).json({ error: 'Account already exists with this email' });
      }

      // Insert new account (preserve is_admin=false for new accounts)
      const { error: insErr } = await sb.from('accounts').insert({
        email: em, pw: pw_hash, name: name || '', company: company || '', is_admin: false, status: 'active',
        created_at: new Date().toISOString()
      });
      if (insErr) {
        console.error('register insert error:', insErr.message);
        return res.status(500).json({ error: 'Failed to create account' });
      }

      return res.status(200).json({ ok: true, email: em, name: name || '', company: company || '', is_admin: false });
    }

    // ──────────────── ADMIN LOGIN BY PW ONLY (legacy 6-logo-click flow) ────────────────
    // Accepts just pw_hash, finds any admin account that matches.
    // Rate-limited by Vercel. Logs attempts server-side for audit.
    if (action === 'admin_login_by_pw_only') {
      const { pw_hash } = body;
      if (!pw_hash || !/^[a-f0-9]{64}$/.test(pw_hash)) {
        return res.status(400).json({ error: 'pw_hash required (64-char hex)' });
      }
      const { data: admins } = await sb.from('accounts')
        .select('email, name, company, pw')
        .eq('is_admin', true);
      const match = (admins || []).find(a => a.pw === pw_hash);
      if (!match) {
        console.warn('admin_login_by_pw_only: no match');
        return res.status(403).json({ error: 'Incorrect admin password' });
      }
      console.log('admin_login_by_pw_only success:', match.email);
      return res.status(200).json({
        email: match.email, name: match.name, company: match.company, is_admin: true, pw_hash: pw_hash
      });
    }

    // ──────────────── LOGIN (verify creds, return profile) ────────────────
    if (action === 'login') {
      const { email, pw_hash } = body;
      const acct = await verifyAuth(email, pw_hash);
      if (!acct) return res.status(403).json({ error: 'Invalid credentials' });
      if (acct.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
      return res.status(200).json({
        email: acct.email, name: acct.name, company: acct.company, is_admin: !!acct.is_admin
      });
    }

    // ──────────────── All below require auth ────────────────
    const { email, pw_hash } = body;
    const acct = await verifyAuth(email, pw_hash);
    if (!acct) return res.status(403).json({ error: 'Invalid credentials' });
    const em = acct.email;
    const isAdmin = !!acct.is_admin;

    // ──────────────── GET_PROFILE ────────────────
    if (action === 'get_profile') {
      const { data: full } = await sb.from('accounts')
        .select('email, name, company, phone, is_admin, status, created_at')
        .eq('email', em).maybeSingle();
      return res.status(200).json(full || {});
    }

    // ──────────────── UPDATE_PROFILE (name/company/phone + optional new pw) ────────────────
    if (action === 'update_profile') {
      const { name, company, phone, new_pw_hash } = body;
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (company !== undefined) patch.company = company;
      if (phone !== undefined) patch.phone = phone;
      if (new_pw_hash) {
        if (!/^[a-f0-9]{64}$/.test(new_pw_hash)) return res.status(400).json({ error: 'invalid new_pw_hash' });
        patch.pw = new_pw_hash;
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });
      const { error } = await sb.from('accounts').update(patch).eq('email', em);
      if (error) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── DELETE_ACCOUNT (soft: mark jobs deleted, hard-delete account row) ────────────────
    if (action === 'delete_account') {
      // Mark all user's jobs as deleted first
      await sb.from('jobs').update({ status: 'deleted' }).eq('email', em);
      // Then delete account
      const { error } = await sb.from('accounts').delete().eq('email', em);
      if (error) return res.status(500).json({ error: 'Delete failed' });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── LIST_OWN_JOBS ────────────────
    if (action === 'list_own_jobs') {
      const { data } = await sb.from('jobs').select('*').eq('email', em).order('created_at', { ascending: false });
      return res.status(200).json({ jobs: data || [] });
    }

    // ──────────────── CREATE_JOB ────────────────
    if (action === 'create_job') {
      const { job } = body;
      if (!job || typeof job !== 'object') return res.status(400).json({ error: 'job payload required' });
      // Force the email to be the authenticated user's email (prevent spoofing)
      job.email = em;
      job.postedByEmail = em;
      job.postedByAccCompany = acct.company || job.postedByAccCompany || '';
      job.created_at = job.created_at || new Date().toISOString();
      const { data, error } = await sb.from('jobs').upsert(job, { onConflict: 'job_id' }).select();
      if (error) { console.error('create_job error:', error.message); return res.status(500).json({ error: 'Create failed' }); }
      return res.status(200).json({ job: data && data[0] });
    }

    // ──────────────── UPDATE_JOB (own only, unless admin) ────────────────
    if (action === 'update_job') {
      const { job_id, patch } = body;
      if (!job_id || !patch) return res.status(400).json({ error: 'job_id and patch required' });
      // Verify ownership unless admin
      if (!isAdmin) {
        const { data: j } = await sb.from('jobs').select('email').eq('job_id', String(job_id)).maybeSingle();
        if (!j) return res.status(404).json({ error: 'Job not found' });
        if (j.email !== em) return res.status(403).json({ error: 'Not your job' });
      }
      // Strip fields the user should never change
      delete patch.email;
      delete patch.postedByEmail;
      const { error } = await sb.from('jobs').update(patch).eq('job_id', String(job_id));
      if (error) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── GET_OWN_TRANSACTIONS ────────────────
    if (action === 'get_own_transactions') {
      const { data } = await sb.from('transactions')
        .select('id, pkg, amount, credits, method, status, ref, created_at, refunded_at, card_last4, card_brand')
        .eq('email', em).order('created_at', { ascending: false });
      return res.status(200).json({ transactions: data || [] });
    }

    // ──────────────── GET_OWN_CREDITS ────────────────
    if (action === 'get_own_credits') {
      const { data } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
      return res.status(200).json({ total: data?.total || 0, used: data?.used || 0 });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('auth-api error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
