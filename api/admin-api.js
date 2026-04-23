import { createClient } from '@supabase/supabase-js';

// Service key bypasses RLS. All admin operations gated by is_admin check.
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

async function verifyAdmin(email, pw_hash) {
  if (!email || !pw_hash) return null;
  const { data: acct } = await sb.from('accounts')
    .select('email, pw, is_admin')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (!acct || acct.pw !== pw_hash || !acct.is_admin) return null;
  return acct;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { email, pw_hash, action } = body;

    const admin = await verifyAdmin(email, pw_hash);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    // ──────────────── LIST OPS ────────────────
    if (action === 'list_accounts') {
      // Never return pw field
      const { data } = await sb.from('accounts')
        .select('email, name, company, phone, is_admin, status, created_at')
        .order('created_at', { ascending: false });
      return res.status(200).json({ accounts: data || [] });
    }

    if (action === 'list_all_jobs') {
      const { data } = await sb.from('jobs').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ jobs: data || [] });
    }

    if (action === 'list_transactions') {
      const { data } = await sb.from('transactions').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ transactions: data || [] });
    }

    if (action === 'list_credits') {
      const { data } = await sb.from('credits').select('email, total, used, updated_at').order('updated_at', { ascending: false });
      return res.status(200).json({ credits: data || [] });
    }

    if (action === 'list_issue_jobs') {
      const { data } = await sb.from('issue_jobs').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ issue_jobs: data || [] });
    }

    if (action === 'list_promos') {
      const { data } = await sb.from('promo_codes').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ promos: data || [] });
    }

    // ──────────────── ACCOUNT MGMT ────────────────
    if (action === 'set_account_status') {
      const { target_email, status } = body;
      if (!target_email || !['active','suspended'].includes(status)) return res.status(400).json({ error: 'bad input' });
      await sb.from('accounts').update({ status }).eq('email', target_email.toLowerCase());
      // If suspending, also close all their active jobs
      if (status === 'suspended') {
        await sb.from('jobs').update({ status: 'closed' }).eq('email', target_email.toLowerCase()).eq('status', 'active');
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── JOB MGMT (admin can change any job) ────────────────
    if (action === 'update_job_status') {
      const { job_id, status } = body;
      if (!job_id || !status) return res.status(400).json({ error: 'job_id and status required' });
      const { error } = await sb.from('jobs').update({ status }).eq('job_id', String(job_id));
      if (error) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── TRANSACTION MGMT ────────────────
    if (action === 'insert_transaction') {
      const { tx } = body;
      if (!tx) return res.status(400).json({ error: 'tx required' });
      const { data, error } = await sb.from('transactions').insert(tx).select();
      if (error) { console.error('insert_transaction:', error.message); return res.status(500).json({ error: error.message }); }
      return res.status(200).json({ transaction: data && data[0] });
    }

    if (action === 'update_transaction_status') {
      const { tx_id, ref, status, refunded_at } = body;
      if (!status) return res.status(400).json({ error: 'status required' });
      const patch = { status };
      if (refunded_at) patch.refunded_at = refunded_at;
      let q = sb.from('transactions').update(patch);
      if (tx_id) q = q.eq('id', tx_id);
      else if (ref) q = q.eq('ref', ref);
      else return res.status(400).json({ error: 'tx_id or ref required' });
      const { data, error } = await q.select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ transactions: data || [] });
    }

    // ──────────────── ISSUE JOBS (admin reports) ────────────────
    if (action === 'upsert_issue_job') {
      const { issue } = body;
      if (!issue) return res.status(400).json({ error: 'issue required' });
      const { data, error } = await sb.from('issue_jobs').upsert(issue).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ issue: data && data[0] });
    }

    if (action === 'update_issue_job_status') {
      const { id, status } = body;
      if (!id || !status) return res.status(400).json({ error: 'id and status required' });
      const { error } = await sb.from('issue_jobs').update({ status }).eq('id', String(id));
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── PROMO MGMT ────────────────
    if (action === 'create_promo') {
      const { promo } = body;
      if (!promo || !promo.code) return res.status(400).json({ error: 'promo with code required' });
      promo.code = promo.code.toUpperCase();
      const { data, error } = await sb.from('promo_codes').insert(promo).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ promo: data && data[0] });
    }

    if (action === 'toggle_promo') {
      const { id, is_active } = body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await sb.from('promo_codes').update({ is_active: !!is_active }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'update_promo_credits') {
      const { id, free_credits } = body;
      if (!id || typeof free_credits !== 'number') return res.status(400).json({ error: 'id and free_credits required' });
      const { error } = await sb.from('promo_codes').update({ free_credits }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── ADMIN SETTINGS ────────────────
    if (action === 'get_settings') {
      const { data } = await sb.from('admin_settings').select('*').eq('key', 'site_config').maybeSingle();
      return res.status(200).json({ settings: data || null });
    }

    if (action === 'upsert_settings') {
      const { settings } = body;
      if (!settings) return res.status(400).json({ error: 'settings required' });
      const { error } = await sb.from('admin_settings').upsert(settings, { onConflict: 'key' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── ADMIN DELETE ACCOUNT (for customer support) ────────────────
    if (action === 'delete_account') {
      const { target_email } = body;
      if (!target_email) return res.status(400).json({ error: 'target_email required' });
      const em = target_email.toLowerCase();
      await sb.from('jobs').update({ status: 'deleted' }).eq('email', em);
      const { error } = await sb.from('accounts').delete().eq('email', em);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('admin-api error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
