import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Atomic credit update with optimistic lock.
 * Reads current row, applies `mutate(row)` to get new values, writes with lock on total+used.
 * Retries once on conflict. Returns the final {total, used}.
 */
async function atomicCreditUpdate(email, mutate) {
  const { data: cr } = await sb.from('credits').select('total, used').eq('email', email).maybeSingle();
  const row = { total: cr?.total || 0, used: cr?.used || 0 };
  const next = mutate(row);
  if (next === null) return row; // mutate returned null = no-op

  if (!cr) {
    // No row yet — insert
    await sb.from('credits').insert({ email, total: next.total, used: next.used, updated_at: new Date().toISOString() });
    return next;
  }

  // Optimistic lock: match current total AND used
  const { error } = await sb.from('credits')
    .update({ total: next.total, used: next.used, updated_at: new Date().toISOString() })
    .eq('email', email)
    .eq('total', row.total)
    .eq('used', row.used);

  if (error) {
    // Retry once with fresh read
    const { data: cr2 } = await sb.from('credits').select('total, used').eq('email', email).maybeSingle();
    const row2 = { total: cr2?.total || 0, used: cr2?.used || 0 };
    const next2 = mutate(row2);
    if (next2 === null) return row2;
    const { error: retryErr } = await sb.from('credits')
      .update({ total: next2.total, used: next2.used, updated_at: new Date().toISOString() })
      .eq('email', email);
    if (retryErr) {
      throw new Error('Credit update retry failed: ' + retryErr.message);
    }
    return next2;
  }

  return next;
}

/**
 * POST /api/credits-api
 */
export default async function handler(req, res) {
  // CORS: only allow our own domain (and Vercel preview deployments)
  const ALLOWED_ORIGINS = [
    'https://www.canadayouthhire.ca',
    'https://canadayouthhire.ca',
  ];
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
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
      const { data: cr } = await sb.from('credits').select('total, used').eq('email', targetEmail).maybeSingle();
      return res.status(200).json({ total: cr?.total || 0, used: cr?.used || 0 });
    }

    // ── ADD: admin gives credits ──
    if (action === 'add') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const targetEm = (target_email || email).toLowerCase();
      const addAmt = parseInt(credits) || 0;
      if (addAmt <= 0) return res.status(400).json({ error: 'credits must be > 0' });

      const result = await atomicCreditUpdate(targetEm, function(row) {
        return { total: row.total + addAmt, used: row.used };
      });

      return res.status(200).json({ total: result.total, used: result.used, added: addAmt });
    }

    // ── DEDUCT: admin deducts credits ──
    if (action === 'deduct') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const targetEm = (target_email || email).toLowerCase();
      const deductAmt = parseInt(credits) || 0;
      if (deductAmt <= 0) return res.status(400).json({ error: 'credits must be > 0' });

      const result = await atomicCreditUpdate(targetEm, function(row) {
        return { total: Math.max(0, row.total - deductAmt), used: row.used };
      });

      return res.status(200).json({ total: result.total, used: result.used, deducted: deductAmt });
    }

    // ── USE: user uses 1 credit to post a job ──
    if (action === 'use') {
      const em = email.toLowerCase();
      const { data: cr } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
      const curTotal = cr?.total || 0;
      const curUsed = cr?.used || 0;
      if (curTotal - curUsed <= 0) {
        return res.status(400).json({ error: 'No credits available' });
      }

      // Atomic: lock on both total and used to prevent double-spend
      const { error } = await sb.from('credits')
        .update({ used: curUsed + 1, updated_at: new Date().toISOString() })
        .eq('email', em)
        .eq('total', curTotal)
        .eq('used', curUsed);

      if (error) {
        // Retry once
        const { data: cr2 } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
        const t2 = cr2?.total || 0;
        const u2 = cr2?.used || 0;
        if (t2 - u2 <= 0) return res.status(400).json({ error: 'No credits available' });
        const { error: retryErr } = await sb.from('credits').update({ used: u2 + 1, updated_at: new Date().toISOString() }).eq('email', em).eq('used', u2);
        if (retryErr) {
          console.error('use action retry failed:', retryErr.message);
          return res.status(500).json({ error: 'Credit deduction failed' });
        }
        return res.status(200).json({ total: t2, used: u2 + 1 });
      }

      return res.status(200).json({ total: curTotal, used: curUsed + 1 });
    }

    // ── PROMO: redeem promo code ──
    if (action === 'promo') {
      if (!code) return res.status(400).json({ error: 'Promo code required' });
      const em = email.toLowerCase();
      const upperCode = code.toUpperCase();

      const { data: p } = await sb.from('promo_codes').select('*').eq('code', upperCode).eq('is_active', true).maybeSingle();
      if (!p) return res.status(400).json({ error: 'Invalid or expired promo code' });

      if (p.max_uses && (p.times_used || 0) >= p.max_uses) {
        return res.status(400).json({ error: 'Promo code fully redeemed' });
      }

      // Insert usage first (unique constraint on code+email prevents duplicates atomically)
      const promoCredits = p.free_credits || 3;
      const { error: dupErr } = await sb.from('promo_usage').insert({
        code: upperCode, email: em, credits_given: promoCredits,
        free_start: p.free_start || null, free_end: p.free_end || null
      });

      if (dupErr) {
        // Duplicate — already redeemed
        return res.status(400).json({ error: 'This promo code has already been used. For more credits, please contact tijobs.ca@gmail.com' });
      }

      // Usage recorded — now add credits atomically
      let result;
      try {
        result = await atomicCreditUpdate(em, function(row) {
          return { total: row.total + promoCredits, used: row.used };
        });
      } catch (e) {
        // Rollback promo_usage to keep state consistent
        await sb.from('promo_usage').delete().eq('code', upperCode).eq('email', em);
        console.error('promo credit grant failed:', e.message);
        return res.status(500).json({ error: 'Credit grant failed, please retry' });
      }

      // Increment times_used
      await sb.from('promo_codes').update({ times_used: (p.times_used || 0) + 1 }).eq('id', p.id);

      // Create transaction record (server-side — reliable)
      await sb.from('transactions').insert({
        email: em,
        pkg: p.billing_label || ('Promo: ' + upperCode + ' (' + promoCredits + ' credits)'),
        credits: promoCredits,
        method: 'free',
        status: 'paid',
        amount: '0',
        ref: 'PROMO-' + upperCode + '-' + em,
        created_at: new Date().toISOString(),
      });

      return res.status(200).json({ total: result.total, used: result.used, credits_given: promoCredits, code: upperCode });
    }

    // ── SIGNUP_BONUS: give 5 free credits to newly registered account ──
    if (action === 'signup_bonus') {
      const em = email.toLowerCase();

      // Insert transaction first — unique ref pattern prevents duplicates atomically
      const { error: txErr } = await sb.from('transactions').insert({
        email: em, pkg: 'Welcome 5 Credits', credits: 5,
        method: 'free', status: 'paid', amount: '0',
        ref: 'SIGNUP-' + em, created_at: new Date().toISOString()
      });

      if (txErr) {
        // Duplicate — already given (ref='SIGNUP-email' is unique)
        const { data: cr } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
        return res.status(200).json({ total: cr?.total || 0, used: cr?.used || 0, already_given: true });
      }

      // Transaction inserted — now add credits atomically (5 credits)
      let result;
      try {
        result = await atomicCreditUpdate(em, function(row) {
          return { total: row.total + 5, used: row.used };
        });
      } catch (e) {
        // Rollback the transaction marker so retry is possible
        // Note: only deletes the new 'SIGNUP-<email>' format; legacy timestamp refs unaffected
        await sb.from('transactions').delete().eq('ref', 'SIGNUP-' + em);
        console.error('signup bonus credit grant failed:', e.message);
        return res.status(500).json({ error: 'Signup bonus failed, please retry' });
      }

      return res.status(200).json({ total: result.total, used: result.used, bonus: 5 });
    }

    // ── CHECKOUT_FALLBACK: client confirms payment when webhook might have failed ──
    if (action === 'checkout_fallback') {
      const em = email.toLowerCase();
      const addCredits = parseInt(credits) || 1;
      // Prefer real Stripe session id (cs_...) so this row matches whatever the webhook will write
      const hasSessionId = ref && /^cs_/.test(ref);
      const txRef = hasSessionId ? ref : ('stripe_' + Date.now());

      // Defense-in-depth: even before insert, check for any recent paid txn matching this purchase.
      // The webhook (using session.id) and the fallback (using stripe_<ts>) would otherwise both succeed
      // because their refs differ. Window: 30 minutes.
      const sinceIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: recent } = await sb
        .from('transactions')
        .select('id, ref, credits, created_at')
        .eq('email', em)
        .eq('status', 'paid')
        .eq('pkg', pkg || 'single')
        .eq('credits', addCredits)
        .gte('created_at', sinceIso)
        .limit(1);
      if (recent && recent.length > 0) {
        const { data: cr } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
        return res.status(200).json({ total: cr?.total || 0, used: cr?.used || 0, already_processed: true, matched_ref: recent[0].ref });
      }

      // Insert transaction — ref uniqueness still protects against exact duplicate calls
      const { error: txErr } = await sb.from('transactions').insert({
        email: em, pkg: pkg || 'single', amount: String(amount || 0),
        credits: addCredits, method: 'card', status: 'paid', ref: txRef
      });

      if (txErr) {
        // Already processed (by webhook or duplicate call)
        const { data: cr } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
        return res.status(200).json({ total: cr?.total || 0, used: cr?.used || 0, already_processed: true });
      }

      // Transaction inserted — now add credits atomically
      const result = await atomicCreditUpdate(em, function(row) {
        return { total: row.total + addCredits, used: row.used };
      });

      return res.status(200).json({ total: result.total, used: result.used, credits_added: addCredits });
    }

    // ── SAVE: generic save (for dbSaveCredits replacement) ──
    if (action === 'save') {
      const targetEm = (isAdmin && target_email) ? target_email.toLowerCase() : email.toLowerCase();
      const total = parseInt(req.body.total);
      const used = parseInt(req.body.used);
      if (isNaN(total) || isNaN(used)) return res.status(400).json({ error: 'total and used required' });

      // Validate used <= total
      if (used > total) return res.status(400).json({ error: 'used cannot exceed total' });
      if (total < 0 || used < 0) return res.status(400).json({ error: 'values cannot be negative' });

      if (!isAdmin) {
        const { data: cr } = await sb.from('credits').select('total, used').eq('email', targetEm).maybeSingle();
        const curTotal = cr?.total || 0;
        const curUsed = cr?.used || 0;
        // Non-admin cannot increase total
        if (total > curTotal) {
          return res.status(403).json({ error: 'Cannot increase own credits' });
        }
        // Non-admin cannot decrease used (would give themselves free credits)
        if (used < curUsed) {
          return res.status(403).json({ error: 'Cannot decrease used credits' });
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
