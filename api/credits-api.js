import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * POST /api/credits-api
 *
 * Actions:
 *   get     — { action:'get', email, pw_hash }
 *   add     — { action:'add', email, pw_hash, credits, reason }  (admin only)
 *   deduct  — { action:'deduct', email, pw_hash, credits, reason }  (admin or self)
 *   use     — { action:'use', email, pw_hash }  (use 1 credit — self only)
 *   promo   — { action:'promo', email, pw_hash, code }  (self only)
 *   checkout_fallback — { action:'checkout_fallback', email, pw_hash, credits, ref, pkg, amount }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { action, email, pw_hash, credits, reason, code, target_email, ref, pkg, amount } = req.body || {};

    if (!email || !pw_hash) {
      return res.status(400).json({ error: 'email and pw_hash required' });
    }

    // ── Auth: verify email + pw_hash ──
    const { data: acct } = await sb.from('accounts').select('pw, is_admin, name, company').eq('email', email.toLowerCase()).maybeSingle();
    if (!acct || acct.pw !== pw_hash) {
      return res.status(403).json({ error: 'Invalid credentials' });
    }
    const isAdmin = !!acct.is_admin;

    // ── GET: read credits ──
    if (action === 'get') {
      const targetEmail = (isAdmin && target_email) ? target_email.toLowerCase() : email.toLowerCase();
      const { data: cr } = await sb.from('credits').select('*').eq('email', targetEmail).maybeSingle();
      return res.status(200).json({ total: cr?.total || 0, used: cr?.used || 0 });
    }

    // ── ADD: admin gives credits (gift / manual transaction / confirm) ──
    if (action === 'add') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const targetEm = (target_email || email).toLowerCase();
      const addAmt = parseInt(credits) || 0;
      if (addAmt <= 0) return res.status(400).json({ error: 'credits must be > 0' });

      const { data: cr } = await sb.from('credits').select('*').eq('email', targetEm).maybeSingle();
      const curTotal = cr?.total || 0;
      const curUsed = cr?.used || 0;
      await sb.from('credits').upsert({
        email: targetEm, total: curTotal + addAmt, used: curUsed, updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

      return res.status(200).json({ total: curTotal + addAmt, used: curUsed, added: addAmt });
    }

    // ── DEDUCT: admin deducts credits (cancel / refund) ──
    if (action === 'deduct') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const targetEm = (target_email || email).toLowerCase();
      const deductAmt = parseInt(credits) || 0;
      if (deductAmt <= 0) return res.status(400).json({ error: 'credits must be > 0' });

      const { data: cr } = await sb.from('credits').select('*').eq('email', targetEm).maybeSingle();
      if (!cr) return res.status(200).json({ total: 0, used: 0, deducted: 0 });

      const newTotal = Math.max(0, (cr.total || 0) - deductAmt);
      await sb.from('credits').update({ total: newTotal, updated_at: new Date().toISOString() }).eq('email', targetEm);

      return res.status(200).json({ total: newTotal, used: cr.used || 0, deducted: deductAmt });
    }

    // ── USE: user uses 1 credit to post a job ──
    if (action === 'use') {
      const em = email.toLowerCase();
      const { data: cr } = await sb.from('credits').select('*').eq('email', em).maybeSingle();
      const curTotal = cr?.total || 0;
      const curUsed = cr?.used || 0;
      if (curTotal - curUsed <= 0) {
        return res.status(400).json({ error: 'No credits available' });
      }
      await sb.from('credits').update({ used: curUsed + 1, updated_at: new Date().toISOString() }).eq('email', em);
      return res.status(200).json({ total: curTotal, used: curUsed + 1 });
    }

    // ── PROMO: redeem promo code ──
    if (action === 'promo') {
      if (!code) return res.status(400).json({ error: 'Promo code required' });
      const em = email.toLowerCase();

      // Check promo code exists and is active
      const { data: p } = await sb.from('promo_codes').select('*').eq('code', code.toUpperCase()).eq('active', true).maybeSingle();
      if (!p) return res.status(400).json({ error: 'Invalid or expired promo code' });

      // Check max uses
      if (p.max_uses && (p.times_used || 0) >= p.max_uses) {
        return res.status(400).json({ error: 'Promo code fully redeemed' });
      }

      // Check if already used by this email
      const { data: dup } = await sb.from('promo_usage').select('id').eq('code', code.toUpperCase()).eq('email', em).maybeSingle();
      if (dup) return res.status(400).json({ error: 'Already redeemed' });

      const promoCredits = p.free_credits || 3;

      // Add credits
      const { data: cr } = await sb.from('credits').select('*').eq('email', em).maybeSingle();
      const curTotal = cr?.total || 0;
      const curUsed = cr?.used || 0;
      await sb.from('credits').upsert({
        email: em, total: curTotal + promoCredits, used: curUsed, updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

      // Record usage
      await sb.from('promo_usage').insert({
        code: code.toUpperCase(), email: em, credits_given: promoCredits,
        free_start: p.free_start || null, free_end: p.free_end || null
      });

      // Increment times_used
      await sb.from('promo_codes').update({ times_used: (p.times_used || 0) + 1 }).eq('id', p.id);

      return res.status(200).json({ total: curTotal + promoCredits, used: curUsed, credits_given: promoCredits });
    }

    // ── CHECKOUT_FALLBACK: client confirms payment when webhook might have failed ──
    if (action === 'checkout_fallback') {
      const em = email.toLowerCase();
      const addCredits = parseInt(credits) || 1;
      const txRef = ref || ('stripe_' + Date.now());

      // Check if webhook already handled this (prevent double-credit)
      const { data: existingTx } = await sb.from('transactions').select('id').eq('ref', txRef).maybeSingle();
      if (existingTx) {
        // Already processed by webhook — just return current credits
        const { data: cr } = await sb.from('credits').select('*').eq('email', em).maybeSingle();
        return res.status(200).json({ total: cr?.total || 0, used: cr?.used || 0, already_processed: true });
      }

      // Not yet processed — add credits + transaction
      const { data: cr } = await sb.from('credits').select('*').eq('email', em).maybeSingle();
      const curTotal = cr?.total || 0;
      const curUsed = cr?.used || 0;
      const newTotal = curTotal + addCredits;

      await sb.from('credits').upsert({
        email: em, total: newTotal, used: curUsed, updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

      await sb.from('transactions').insert({
        email: em, pkg: pkg || 'single', amount: String(amount || 0),
        credits: addCredits, method: 'card', status: 'paid', ref: txRef
      });

      return res.status(200).json({ total: newTotal, used: curUsed, credits_added: addCredits });
    }

    // ── SAVE: generic save (for dbSaveCredits replacement) ──
    if (action === 'save') {
      // Only allow saving own credits or admin saving anyone's
      const targetEm = (isAdmin && target_email) ? target_email.toLowerCase() : email.toLowerCase();
      const total = parseInt(req.body.total);
      const used = parseInt(req.body.used);
      if (isNaN(total) || isNaN(used)) return res.status(400).json({ error: 'total and used required' });

      // Non-admin can only save their own with same or lower total (prevent inflation)
      if (!isAdmin) {
        const { data: cr } = await sb.from('credits').select('*').eq('email', targetEm).maybeSingle();
        const curTotal = cr?.total || 0;
        if (total > curTotal) {
          return res.status(403).json({ error: 'Cannot increase own credits' });
        }
      }

      await sb.from('credits').upsert({
        email: targetEm, total, used, updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

      return res.status(200).json({ total, used });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('credits-api error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
