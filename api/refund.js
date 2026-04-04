import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let body = '';
  try {
    for await (const chunk of req) body += chunk;
  } catch (e) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  }

  let data;
  try { data = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  // 인증: 관리자만 환불 가능
  const { payment_intent, email, pw_hash } = data;
  if (!payment_intent) {
    return res.status(400).json({ error: 'Missing payment_intent' });
  }
  if (!email || !pw_hash) {
    return res.status(403).json({ error: 'Unauthorized: credentials required' });
  }

  // DB에서 관리자 확인
  const { data: acct } = await sb
    .from('accounts')
    .select('pw, is_admin')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (!acct || !acct.is_admin || acct.pw !== pw_hash) {
    return res.status(403).json({ error: 'Unauthorized: admin only' });
  }

  try {
    const refund = await stripe.refunds.create({
      payment_intent: payment_intent,
    });

    return res.status(200).json({
      success: true,
      refund_id: refund.id,
      status: refund.status,
      amount: refund.amount,
    });
  } catch (err) {
    console.error('Refund error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
