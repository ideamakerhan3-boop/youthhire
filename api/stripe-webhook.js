import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { sendVoiceCall, sendSmsAlert } from './_lib/alerts.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// raw body 필요 (서명 검증용)
export const config = { api: { bodyParser: false } };

async function alertOrphanRefund(paymentIntentId, amount) {
  const subject = 'TIJOBS REFUND ORPHAN';
  const body = `Stripe refund received but no matching transaction. PI=${paymentIntentId} amount=${amount || '?'}. Manual review required.`;
  const voiceMsg = `YouthHire alert. A Stripe refund arrived but no matching transaction was found in the database. Manual review required immediately.`;
  await sendSmsAlert(subject, body);
  await sendVoiceCall(voiceMsg);
}

const PACKAGES = {
  single: { credits: 1,  amount: 9.99  },
  triple: { credits: 3,  amount: 24.99 },
  ten:    { credits: 10, amount: 59.99 },
  thirty: { credits: 30, amount: 149.99},
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // raw body 수집
  let rawBody = '';
  for await (const chunk of req) rawBody += chunk;

  // Stripe 서명 검증
  let event;
  const sig = req.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!whSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured — rejecting webhook');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const type = event?.type;
  console.log('Webhook received:', type);

  try {

    // ── 결제 완료 ─────────────────────────────────────────────
    if (type === 'checkout.session.completed') {
      const session         = event.data.object;
      const email           = (session.metadata?.email || session.customer_email || '').toLowerCase();
      const pkg             = session.metadata?.pkg;
      const sessionId       = session.id;
      const paymentIntentId = session.payment_intent || null;
      const pkgInfo         = PACKAGES[pkg];

      if (!email || !pkgInfo) {
        console.error('Missing metadata:', { email, pkg });
        return res.status(200).json({ received: true });
      }

      // 금액 검증
      const expectedCents = Math.round(pkgInfo.amount * 100);
      const actualCents = session.amount_total;
      if (actualCents && actualCents !== expectedCents) {
        console.error('Amount mismatch — BLOCKED:', { expected: expectedCents, actual: actualCents, pkg, email });
        return res.status(400).json({ error: 'Amount mismatch — payment not processed' });
      }

      // 중복 방지 — select only id
      const { data: existing } = await sb
        .from('transactions')
        .select('id')
        .eq('ref', sessionId)
        .maybeSingle();

      if (existing) {
        console.log('Duplicate, skip:', sessionId);
        return res.status(200).json({ received: true });
      }

      const credits = pkgInfo.credits;
      const amount  = pkgInfo.amount;

      // 카드 정보 가져오기 (last4, brand)
      let cardLast4 = null;
      let cardBrand = null;
      if (paymentIntentId) {
        try {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ['payment_method'],
          });
          if (pi.payment_method?.card) {
            cardLast4 = pi.payment_method.card.last4;
            cardBrand = pi.payment_method.card.brand;
          }
        } catch (e) {
          console.warn('Card info lookup failed:', e.message);
        }
      }

      // 크레딧 추가 (atomic)
      const { data: cr } = await sb
        .from('credits')
        .select('total, used')
        .eq('email', email)
        .maybeSingle();

      if (cr) {
        const { error: updErr } = await sb
          .from('credits')
          .update({
            total: cr.total + credits,
            updated_at: new Date().toISOString(),
          })
          .eq('email', email)
          .eq('total', cr.total);

        if (updErr) {
          const { data: cr2 } = await sb.from('credits').select('total').eq('email', email).maybeSingle();
          if (cr2) {
            const { error: retryErr } = await sb.from('credits').update({
              total: cr2.total + credits,
              updated_at: new Date().toISOString(),
            }).eq('email', email);
            if (retryErr) {
              console.error('CRITICAL: credit grant retry failed for paid user', email, retryErr.message);
              return res.status(500).json({ error: 'Credit grant failed after payment' });
            }
          } else {
            console.error('CRITICAL: credits row disappeared during retry', email);
            return res.status(500).json({ error: 'Credit state inconsistent' });
          }
        }
      } else {
        await sb.from('credits').insert({
          email,
          total: credits,
          used: 0,
          updated_at: new Date().toISOString(),
        });
      }

      // 트랜잭션 저장
      await sb.from('transactions').insert({
        email,
        pkg,
        amount,
        credits,
        method: 'card',
        status: 'paid',
        ref:    sessionId,
        payment_intent: paymentIntentId,
        card_last4: cardLast4,
        card_brand: cardBrand,
      });

      console.log(`✅ Paid: ${email} +${credits} credits ($${amount})`);
    }

    // ── 환불 완료 ─────────────────────────────────────────────
    else if (type === 'charge.refunded') {
      const charge          = event.data.object;
      const paymentIntentId = charge.payment_intent;

      // 방법 1: payment_intent 직접 매핑
      let txn = null;
      const { data: txn1 } = await sb
        .from('transactions')
        .select('id, email, credits, status')
        .eq('payment_intent', paymentIntentId)
        .maybeSingle();
      txn = txn1;

      // 방법 2: Stripe session 역추적
      if (!txn && paymentIntentId) {
        try {
          const sessions = await stripe.checkout.sessions.list({
            payment_intent: paymentIntentId,
            limit: 1,
          });
          const session = sessions.data[0];
          if (session) {
            const { data: txn2 } = await sb
              .from('transactions')
              .select('id, email, credits, status')
              .eq('ref', session.id)
              .maybeSingle();
            txn = txn2;
          }
        } catch (e) {
          console.error('Session lookup error:', e.message);
        }
      }

      if (!txn) {
        console.error('⚠️ REFUND ORPHAN: Stripe refunded PI:', paymentIntentId, 'but no matching transaction found in DB. Manual review required.');
        try { await alertOrphanRefund(paymentIntentId, charge.amount_refunded); } catch (e) { console.error('Alert send failed:', e.message); }
        return res.status(500).json({ error: 'Transaction not found for refund — will retry' });
      }

      if (txn.status === 'refunded') {
        console.log('Already refunded, skip:', txn.id);
        return res.status(200).json({ received: true });
      }

      // DB 상태 업데이트
      const { error: txnUpdErr } = await sb
        .from('transactions')
        .update({ status: 'refunded', refunded_at: new Date().toISOString() })
        .eq('id', txn.id);
      if (txnUpdErr) {
        console.error('Refund txn update failed:', txnUpdErr.message, 'txn.id=', txn.id);
        return res.status(500).json({ error: 'Transaction status update failed — will retry' });
      }

      // 크레딧 차감 (atomic)
      const { data: cr } = await sb
        .from('credits')
        .select('total, used')
        .eq('email', txn.email)
        .maybeSingle();

      if (cr) {
        const newTotal = Math.max(0, (cr.total || 0) - (txn.credits || 0));
        const { error: updErr } = await sb
          .from('credits')
          .update({
            total: newTotal,
            updated_at: new Date().toISOString(),
          })
          .eq('email', txn.email)
          .eq('total', cr.total);

        if (updErr) {
          const { data: cr2 } = await sb.from('credits').select('total').eq('email', txn.email).maybeSingle();
          if (cr2) {
            const { error: retryErr } = await sb.from('credits').update({
              total: Math.max(0, (cr2.total || 0) - (txn.credits || 0)),
              updated_at: new Date().toISOString(),
            }).eq('email', txn.email);
            if (retryErr) {
              console.error('Refund credits retry failed:', retryErr.message, 'email=', txn.email);
              return res.status(500).json({ error: 'Credit deduction failed — will retry' });
            }
          } else {
            console.error('Refund credits row vanished on retry, email=', txn.email);
            return res.status(500).json({ error: 'Credit row missing — will retry' });
          }
        }
      } else {
        console.warn('Refund: no credits row for', txn.email, '— txn marked refunded but nothing to deduct');
      }

      console.log(`💸 Refunded: ${txn.email} -${txn.credits} credits`);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: 'Internal processing error' });
  }
}
