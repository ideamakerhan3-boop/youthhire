import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { rateLimit } from './_lib/ratelimit.js';
import { verifyTurnstile } from './_lib/turnstile.js';

// Service key bypasses RLS — all sensitive account/job operations go through here.
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BCRYPT_ROUNDS = 12;
const BCRYPT_PREFIX = '$2'; // bcrypt hashes start with $2a / $2b / $2y

const ALLOWED_ORIGINS = [
  'https://www.canadayouthhire.ca',
  'https://canadayouthhire.ca',
];

// Specific employer email allowed (alongside admins) to override
// posted_date / exp_date on their own job postings via My Page.
const PRIVILEGED_DATE_EDITOR_EMAIL = 'ideamakerhan2@gmail.com';

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/youthhire-[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return (Array.isArray(xff) ? xff[0] : xff.split(',')[0]).trim() || req.socket?.remoteAddress || 'unknown';
}

// Verify account credentials, returns account row or null.
// Supports both legacy unsalted SHA-256 (from pre-bcrypt users) and bcrypt.
// On successful legacy login, transparently upgrades stored hash to bcrypt.
async function verifyAuth(email, pw_hash) {
  if (!email || !pw_hash) return null;
  const { data: acct } = await sb.from('accounts')
    .select('email, pw, name, company, is_admin, status')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (!acct) return null;
  let ok = false;
  if (acct.pw && acct.pw.startsWith(BCRYPT_PREFIX)) {
    ok = await bcrypt.compare(pw_hash, acct.pw);
  } else if (acct.pw === pw_hash) {
    // Legacy plain SHA-256 match — upgrade to bcrypt on-the-fly
    ok = true;
    try {
      const upgraded = await bcrypt.hash(pw_hash, BCRYPT_ROUNDS);
      await sb.from('accounts').update({ pw: upgraded }).eq('email', acct.email);
    } catch (e) {
      console.error('bcrypt upgrade failed for', acct.email, e.message);
    }
  }
  return ok ? acct : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { action } = body;
    const ip = clientIp(req);

    // ──────────────── REGISTER (no prior auth) ────────────────
    if (action === 'register') {
      // Honeypot: legitimate registrations never set these fields.
      // Naive bots auto-fill any field named website/url/homepage/phone_number.
      // If set, silently succeed (200) so bots think they passed — no DB write, no alert leak.
      if (body.website || body.url || body.homepage || body.phone_number) {
        console.warn('honeypot tripped from IP', ip);
        return res.status(200).json({ ok: true, email: 'silent@honeypot', name: '', company: '', is_admin: false });
      }
      // Turnstile CAPTCHA: when client sends turnstile_token, verify with Cloudflare.
      // Backwards-compatible: if client hasn't been updated yet (no token), the
      // helper returns true when TURNSTILE_SECRET_KEY is set but token missing
      // we fail closed. Client-side integration comes in a separate pass.
      if (body.turnstile_token !== undefined) {
        const ok = await verifyTurnstile(body.turnstile_token, ip);
        if (!ok) return res.status(403).json({ error: 'Bot check failed. Please refresh and try again.' });
      }
      const { email, pw_hash, name, company } = body;
      if (!email || !pw_hash) return res.status(400).json({ error: 'email and pw_hash required' });
      if (!/^[a-f0-9]{64}$/.test(pw_hash)) return res.status(400).json({ error: 'invalid pw_hash format' });
      // Input length hard caps (defense against oversized payloads)
      if (email.length > 254) return res.status(400).json({ error: 'email too long' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email format' });
      if (name && String(name).length > 120) return res.status(400).json({ error: 'name too long' });
      if (company && String(company).length > 160) return res.status(400).json({ error: 'company too long' });
      // Rate limit: 5 registrations per IP per 10 min (Supabase-backed, durable)
      if (!(await rateLimit(sb, 'reg:' + ip, 5, 600_000))) {
        return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
      }
      const em = email.toLowerCase();

      // Check if already exists
      const { data: existing } = await sb.from('accounts').select('email, is_admin').eq('email', em).maybeSingle();
      if (existing) {
        return res.status(409).json({ error: 'Account already exists with this email' });
      }

      // Insert new account with bcrypt-hashed password (salt is embedded)
      const hashedPw = await bcrypt.hash(pw_hash, BCRYPT_ROUNDS);
      const { error: insErr } = await sb.from('accounts').insert({
        email: em, pw: hashedPw, name: name || '', company: company || '', is_admin: false, status: 'active',
        created_at: new Date().toISOString()
      });
      if (insErr) {
        console.error('register insert error:', insErr.message);
        return res.status(500).json({ error: 'Failed to create account' });
      }

      // Grant 5 free signup credits atomically. transactions.ref has a UNIQUE
      // constraint on 'SIGNUP-<email>' so this is idempotent — the legacy
      // /api/credits-api signup_bonus path stays as a defensive recovery and
      // won't double-grant.
      let signupTotal = 0, signupUsed = 0;
      try {
        const { error: txErr } = await sb.from('transactions').insert({
          email: em, pkg: 'Welcome 5 Credits', credits: 5,
          method: 'free', status: 'paid', amount: '0',
          ref: 'SIGNUP-' + em, created_at: new Date().toISOString()
        });
        if (!txErr) {
          // First-time grant — account is brand new so no concurrent credit writers.
          await sb.from('credits').upsert(
            { email: em, total: 5, used: 0, updated_at: new Date().toISOString() },
            { onConflict: 'email' }
          );
          signupTotal = 5;
        } else {
          // SIGNUP tx already existed (recovery path) — just read current state.
          const { data: cr } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
          signupTotal = cr?.total || 0;
          signupUsed = cr?.used || 0;
        }
      } catch (e) {
        console.error('register: signup credit grant failed for', em, e.message);
        // Account exists but credits not granted. Client's existing signup_bonus
        // call recovers. Don't block register.
      }

      return res.status(200).json({
        ok: true, email: em, name: name || '', company: company || '', is_admin: false,
        credits: { total: signupTotal, used: signupUsed }
      });
    }

    // ──────────────── ADMIN LOGIN BY PW ONLY (legacy 6-logo-click flow) ────────────────
    // Accepts just pw_hash, finds any admin account that matches.
    // Rate-limited by Vercel. Logs attempts server-side for audit.
    if (action === 'admin_login_by_pw_only') {
      const { pw_hash } = body;
      if (!pw_hash || !/^[a-f0-9]{64}$/.test(pw_hash)) {
        return res.status(400).json({ error: 'pw_hash required (64-char hex)' });
      }
      // Rate limit: 5 attempts per IP per 10 min (admin is highest value target)
      if (!(await rateLimit(sb, 'adminpw:' + ip, 5, 600_000))) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      const { data: admins } = await sb.from('accounts')
        .select('email, name, company, pw')
        .eq('is_admin', true);
      let match = null;
      for (const a of (admins || [])) {
        if (a.pw && a.pw.startsWith(BCRYPT_PREFIX)) {
          if (await bcrypt.compare(pw_hash, a.pw)) { match = a; break; }
        } else if (a.pw === pw_hash) {
          match = a;
          // Upgrade legacy admin hash
          try {
            const upgraded = await bcrypt.hash(pw_hash, BCRYPT_ROUNDS);
            await sb.from('accounts').update({ pw: upgraded }).eq('email', a.email);
          } catch (e) { console.error('admin bcrypt upgrade failed:', e.message); }
          break;
        }
      }
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
      // Rate limit: 10 attempts per IP+email per 10 min
      if (!(await rateLimit(sb, 'login:' + ip + ':' + (email || '').toLowerCase(), 10, 600_000))) {
        return res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
      }
      const acct = await verifyAuth(email, pw_hash);
      if (!acct) return res.status(403).json({ error: 'Invalid credentials' });
      if (acct.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
      return res.status(200).json({
        email: acct.email, name: acct.name, company: acct.company, is_admin: !!acct.is_admin
      });
    }

    // ──────────────── REQUEST_RESET (no auth) — generate token, email link ────────────────
    if (action === 'request_reset') {
      const rawEmail = body.email;
      if (!rawEmail || typeof rawEmail !== 'string') return res.status(400).json({ error: 'email required' });
      const em = rawEmail.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 254) {
        return res.status(400).json({ error: 'invalid email' });
      }
      // Rate limits: stricter than login because compromised reset = takeover.
      // 3 per email/hour blunts targeted harassment; 5 per IP/hour blunts enumeration sweeps.
      if (!(await rateLimit(sb, 'reset_email:' + em, 3, 3600_000))) {
        return res.status(429).json({ error: 'Too many reset requests for this email. Try again in an hour.' });
      }
      if (!(await rateLimit(sb, 'reset_ip:' + ip, 5, 3600_000))) {
        return res.status(429).json({ error: 'Too many reset requests. Try again in an hour.' });
      }

      // Always return a generic success regardless of whether the email matches an
      // account (prevents enumeration). Only do the work if the account exists.
      const { data: acct } = await sb.from('accounts').select('email, name, status').eq('email', em).maybeSingle();
      if (acct && acct.status !== 'suspended') {
        try {
          const crypto = await import('node:crypto');
          const token = crypto.randomBytes(32).toString('hex'); // 64-char URL-safe
          const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
          const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1h
          await sb.from('accounts').update({
            reset_token_hash: tokenHash,
            reset_token_expires_at: expiresAt,
          }).eq('email', acct.email);

          const resetUrl = 'https://www.canadayouthhire.ca/reset?token=' + token;
          const { sendTransactionalEmail } = await import('./_lib/email.js');
          await sendTransactionalEmail({
            template_id: process.env.EMAILJS_TEMPLATE_GENERAL || 'template_welcome',
            template_params: {
              to_email: acct.email,
              to_name: acct.name || acct.email,
              subject: 'Reset your YouthHire password',
              heading: 'Password Reset Requested',
              message:
                'Click the link below to choose a new password. The link expires in 1 hour.\n\n' +
                resetUrl + '\n\n' +
                'If you did not request this, you can safely ignore this email — your password will not change.',
              button_text: 'Reset Password',
            },
          });
        } catch (e) {
          // Log but do not surface — generic success keeps email enumeration shut.
          console.error('request_reset internal error:', e.message);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── VERIFY_RESET (token-based, sets new password) ────────────────
    if (action === 'verify_reset') {
      const { token, new_pw_hash } = body;
      if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        return res.status(400).json({ error: 'invalid token' });
      }
      if (!new_pw_hash || !/^[a-f0-9]{64}$/.test(new_pw_hash)) {
        return res.status(400).json({ error: 'invalid new password' });
      }
      // Rate limit per IP — slows offline-style token guessing if anything leaks.
      if (!(await rateLimit(sb, 'reset_verify:' + ip, 10, 3600_000))) {
        return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
      }
      const crypto = await import('node:crypto');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const { data: acct } = await sb.from('accounts')
        .select('email, reset_token_hash, reset_token_expires_at, status')
        .eq('reset_token_hash', tokenHash)
        .maybeSingle();
      if (!acct) return res.status(403).json({ error: 'Invalid or expired reset link' });
      if (!acct.reset_token_expires_at || new Date(acct.reset_token_expires_at) < new Date()) {
        return res.status(403).json({ error: 'Reset link expired. Please request a new one.' });
      }
      if (acct.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

      const newHashed = await bcrypt.hash(new_pw_hash, BCRYPT_ROUNDS);
      const { error: updErr } = await sb.from('accounts').update({
        pw: newHashed,
        reset_token_hash: null,
        reset_token_expires_at: null,
      }).eq('email', acct.email);
      if (updErr) {
        console.error('verify_reset update error:', updErr.message);
        return res.status(500).json({ error: 'Could not update password. Try again.' });
      }
      return res.status(200).json({ ok: true, email: acct.email });
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
        patch.pw = await bcrypt.hash(new_pw_hash, BCRYPT_ROUNDS);
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
      // Whitelist actual DB columns. Anything else (camelCase legacy keys,
      // spoofed fields) is dropped before reaching Supabase upsert.
      const ALLOWED = new Set([
        'job_id','title','company','loc','prov','type','wage','category',
        'description','status','posted_date','exp_date','apply_method',
        'apply_email','apply_url','lang','edu','exp_req','vacancy','ai_use',
        'remote','requirements','benefits','biz_city','biz_prov',
        'posted_by_acc_company',
      ]);
      const clean = {};
      for (const k of Object.keys(job)) {
        if (ALLOWED.has(k)) clean[k] = job[k];
      }
      // Force the email to be the authenticated user's email (prevent spoofing)
      clean.email = em;
      clean.posted_by_acc_company = acct.company || clean.posted_by_acc_company || '';
      clean.created_at = new Date().toISOString();
      if (!clean.job_id) return res.status(400).json({ error: 'job_id required' });
      const { data, error } = await sb.from('jobs').upsert(clean, { onConflict: 'job_id' }).select();
      if (error) { console.error('create_job error:', error.message, 'payload keys:', Object.keys(clean)); return res.status(500).json({ error: 'Create failed: ' + error.message }); }
      return res.status(200).json({ job: data && data[0] });
    }

    // ──────────────── UPDATE_JOB (own only, unless admin) ────────────────
    if (action === 'update_job') {
      const { job_id, patch } = body;
      if (!job_id || !patch || typeof patch !== 'object') return res.status(400).json({ error: 'job_id and patch required' });
      // Verify ownership unless admin
      if (!isAdmin) {
        const { data: j } = await sb.from('jobs').select('email').eq('job_id', String(job_id)).maybeSingle();
        if (!j) return res.status(404).json({ error: 'Job not found' });
        if (j.email !== em) return res.status(403).json({ error: 'Not your job' });
      }
      // Whitelist mutable columns. Drops camelCase legacy keys + spoofed fields.
      // email + job_id are immutable identity; created_at is set once at insert.
      // posted_date/exp_date are DATE_FIELDS — gated to admin or the privileged
      // date editor account so regular employers can't backdate their listings.
      const ALLOWED_PATCH = new Set([
        'title','company','loc','prov','type','wage','category',
        'description','status','apply_method',
        'apply_email','apply_url','lang','edu','exp_req','vacancy','ai_use',
        'remote','requirements','benefits','biz_city','biz_prov',
        'posted_by_acc_company','notified_expiry',
      ]);
      const DATE_FIELDS = new Set(['posted_date','exp_date']);
      const canEditDates = isAdmin || em === PRIVILEGED_DATE_EDITOR_EMAIL;
      const cleanPatch = {};
      for (const k of Object.keys(patch)) {
        if (ALLOWED_PATCH.has(k)) cleanPatch[k] = patch[k];
        else if (DATE_FIELDS.has(k) && canEditDates) cleanPatch[k] = patch[k];
      }
      if (Object.keys(cleanPatch).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
      const { error } = await sb.from('jobs').update(cleanPatch).eq('job_id', String(job_id));
      if (error) { console.error('update_job error:', error.message); return res.status(500).json({ error: 'Update failed: ' + error.message }); }
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
