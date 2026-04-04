import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PACKAGES = {
  single: { credits: 1,  amount: 999,   name: 'Single Post (1 Credit)',   label: 'single' },
  triple: { credits: 3,  amount: 2499,  name: '3-Pack (3 Credits)',        label: 'triple' },
  ten:    { credits: 10, amount: 5999,  name: '10-Pack (10 Credits)',      label: 'ten'    },
  thirty: { credits: 30, amount: 14999, name: '30-Pack (30 Credits)',      label: 'thirty' },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  let body = '';
  try {
    for await (const chunk of req) body += chunk;
  } catch (e) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  }

  let data;
  try { data = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { email, pkg } = data;
  if (!email || !pkg || !PACKAGES[pkg]) {
    return res.status(400).json({ error: 'Missing or invalid email/pkg' });
  }

  const p = PACKAGES[pkg];
  const origin = req.headers.origin || 'https://settlejobs.vercel.app';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email.toLowerCase(),
      locale: 'en',
      line_items: [{
        price_data: {
          currency: 'cad',
          product_data: { name: p.name },
          unit_amount: p.amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: origin + '/redirect.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  origin + '/?checkout=cancel',
      metadata: {
        email: email.toLowerCase(),
        pkg,
        credits: String(p.credits),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
