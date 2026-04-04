import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// raw body 필요 (서명 검증용)
export const config = { api: { bodyParser: false } };

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

      // 금액 검증: Stripe 실제 결제 금액(센트)과 패키지 가격 비교
      const expectedCents = Math.round(pkgInfo.amount * 100);
      const actualCents = session.amount_total;
      if (actualCents && actualCents !== expectedCents) {
        console.error('Amount mismatch:', { expected: expectedCents, actual: actualCents, pkg });
        return res.status(200).json({ received: true });
      }

      // 중복 방지
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

      // 크레딧 추가 (atomic — race condition 방지)
      const { data: cr } = await sb
        .from('credits')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      if (cr) {
        // 기존 레코드: optimistic lock으로 atomic 처리
        const { error: updErr } = await sb
          .from('credits')
          .update({
            total: cr.total + credits,
            updated_at: new Date().toISOString(),
          })
          .eq('email', email)
          .eq('total', cr.total); // optimistic lock

        if (updErr) {
          // 충돌 시 1회 재시도
          const { data: cr2 } = await sb.from('credits').select('*').eq('email', email).maybeSingle();
          if (cr2) {
            await sb.from('credits').update({
              total: cr2.total + credits,
              updated_at: new Date().toISOString(),
            }).eq('email', email);
          }
        }
      } else {
        // 신규 레코드
        await sb.from('credits').insert({
          email,
          total: credits,
          used: 0,
          updated_at: new Date().toISOString(),
        });
      }

      // 트랜잭션 저장 (payment_intent + 카드정보 포함)
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

      // 방법 1: payment_intent 컬럼 직접 매핑
      let txn = null;
      const { data: txn1 } = await sb
        .from('transactions')
        .select('*')
        .eq('payment_intent', paymentIntentId)
        .maybeSingle();
      txn = txn1;

      // 방법 2: Stripe API로 session 역추적 → ref로 매핑
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
              .select('*')
              .eq('ref', session.id)
              .maybeSingle();
            txn = txn2;
          }
        } catch (e) {
          console.error('Session lookup error:', e.message);
        }
      }

      if (!txn) {
        console.warn('Refund: no matching txn for PI:', paymentIntentId);
        return res.status(200).json({ received: true });
      }

      if (txn.status === 'refunded') {
        console.log('Already refunded, skip:', txn.id);
        return res.status(200).json({ received: true });
      }

      // DB 상태 업데이트
      await sb
        .from('transactions')
        .update({ status: 'refunded', refunded_at: new Date().toISOString() })
        .eq('id', txn.id);

      // 크레딧 차감 (atomic — race condition 방지)
      const { data: cr } = await sb
        .from('credits')
        .select('*')
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
          .eq('total', cr.total); // optimistic lock

        if (updErr) {
          const { data: cr2 } = await sb.from('credits').select('*').eq('email', txn.email).maybeSingle();
          if (cr2) {
            await sb.from('credits').update({
              total: Math.max(0, (cr2.total || 0) - (txn.credits || 0)),
              updated_at: new Date().toISOString(),
            }).eq('email', txn.email);
          }
        }
      }

      console.log(`💸 Refunded: ${txn.email} -${txn.credits} credits`);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    // DB 오류 등 재시도 가능한 에러는 500 반환 → Stripe가 재시도함
    return res.status(500).json({ error: 'Internal processing error' });
  }
}
