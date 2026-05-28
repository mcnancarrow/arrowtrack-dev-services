const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Admin auth (HTTP Basic) ────────────────────────────────────
// Credentials come from env vars only — never hardcoded.
// If unset, admin is locked down entirely (fail closed) rather than left open.
function requireAdminAuth(req, res, next) {
  const USER = process.env.ADMIN_USER;
  const PASS = process.env.ADMIN_PASS;
  if (!USER || !PASS) {
    return res.status(503).send('Admin is not configured. Set ADMIN_USER and ADMIN_PASS environment variables.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === USER && pass === PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Arrowtrack Forge Admin", charset="UTF-8"');
  return res.status(401).send('Authentication required.');
}
// Guard the admin page, its static HTML, and the admin API — BEFORE static serving.
app.use(['/admin', '/admin.html'], requireAdminAuth);

app.use(express.static(path.join(__dirname, 'public')));

// ─── JSON storage for project briefs ───────────────────────────
const DB_FILE = path.join(__dirname, 'submissions.json');
function readDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function genRef() { return 'SOW-' + Date.now().toString(36).toUpperCase(); }

// ─── Pricing engine (single source of truth) ───────────────────
const PRICING = {
  packages: {
    'Starter — $3,500': 3500,
    'Growth — $6,500': 6500,
    'Full-Stack — $12,000': 12000,
    "Custom — Let's Talk": 0
  },
  addons: {
    del_admin:     { label: 'Admin Dashboard',     price: 1500 },
    del_payments:  { label: 'Payments (Stripe)',   price: 1000 },
    del_ai:        { label: 'AI Features',          price: 2500 },
    del_push:      { label: 'Push Notifications',   price: 800 },
    del_email:     { label: 'Email Notifications',  price: 400 },
    del_maps:      { label: 'Maps / Location',      price: 600 },
    del_analytics: { label: 'Analytics',            price: 500 },
    del_cms:       { label: 'CMS / Content',        price: 1200 }
  }
};

function computeQuote(d) {
  const base = PRICING.packages[d.package] || 0;
  const items = [];
  if (d.package) items.push({ label: d.package.split(' — ')[0] + ' Package', price: base });
  let addonTotal = 0;
  Object.keys(PRICING.addons).forEach(key => {
    if (d[key]) {
      items.push(PRICING.addons[key]);
      addonTotal += PRICING.addons[key].price;
    }
  });
  const total = base + addonTotal;
  return { items, total, deposit: Math.round(total * 0.5), isCustom: d.package && d.package.startsWith('Custom') };
}

// Expose pricing to frontend
app.get('/api/pricing', (req, res) => res.json(PRICING));

// ─── Contact form (existing) ────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { firstName, lastName, email, businessType, package: pkg, message } = req.body;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const OWNER_EMAIL = process.env.OWNER_EMAIL;
  if (!RESEND_API_KEY || !OWNER_EMAIL) {
    console.error('Missing RESEND_API_KEY or OWNER_EMAIL env vars');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Arrowtrack Services <hello@delib.io>',
        to: OWNER_EMAIL,
        subject: `New Project Inquiry — ${firstName} ${lastName} (${businessType || 'Unknown'})`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0d0d0d;color:#fff;padding:32px;border-radius:12px;">
            <h2 style="color:#7C3AED;margin-bottom:24px;">New Project Inquiry</h2>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:10px 0;color:#888;width:140px;">Name</td><td style="padding:10px 0;color:#fff;font-weight:600;">${firstName} ${lastName}</td></tr>
              <tr><td style="padding:10px 0;color:#888;">Email</td><td style="padding:10px 0;"><a href="mailto:${email}" style="color:#22C55E;">${email}</a></td></tr>
              <tr><td style="padding:10px 0;color:#888;">Business Type</td><td style="padding:10px 0;color:#fff;">${businessType || '—'}</td></tr>
              <tr><td style="padding:10px 0;color:#888;">Package</td><td style="padding:10px 0;color:#fff;">${pkg || '—'}</td></tr>
            </table>
            <div style="margin-top:24px;padding:20px;background:#1a1a1a;border-radius:8px;border-left:3px solid #7C3AED;">
              <p style="color:#888;font-size:13px;margin-bottom:8px;">MESSAGE</p>
              <p style="color:#fff;line-height:1.7;">${message || '—'}</p>
            </div>
          </div>`
      })
    });
    if (response.ok) res.json({ success: true });
    else { const err = await response.text(); console.error('Resend error:', err); res.status(500).json({ error: 'Failed to send email' }); }
  } catch (err) { console.error('Contact form error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ─── SOW format for email ───────────────────────────────────────
function formatSOW(d, quote) {
  const platforms = [d.platform_web && 'Web App', d.platform_ios && 'iOS', d.platform_android && 'Android'].filter(Boolean).join(', ') || '—';
  const deliverables = [d.del_admin&&'Admin Dashboard',d.del_payments&&'Payments',d.del_ai&&'AI',d.del_push&&'Push',d.del_email&&'Email',d.del_maps&&'Maps',d.del_analytics&&'Analytics',d.del_cms&&'CMS'].filter(Boolean).join(', ') || '—';
  const features = [d.feat_auth&&'Email Auth',d.feat_oauth&&'OAuth',d.feat_roles&&'Roles',d.feat_stripe&&'Stripe',d.feat_subscriptions&&'Subscriptions',d.feat_ai_content&&'AI Content',d.feat_ai_chat&&'AI Chat',d.feat_ai_analysis&&'AI Analysis',d.feat_automation&&'Automation'].filter(Boolean).join(', ') || '—';
  const quoteLines = quote.items.map(i => `  ${i.label.padEnd(28)} $${i.price.toLocaleString()}`).join('\n');
  return `
ARROWTRACK SOLUTIONS — SCOPE OF WORK
=====================================
Reference: ${d.ref_code}
Date: ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}

CLIENT
──────
Name:     ${d.client_name || '—'}
Email:    ${d.client_email || '—'}
Phone:    ${d.phone || '—'}
Company:  ${d.company_name || '—'}
Industry: ${d.business_type || '—'}

PROJECT
───────
Name:      ${d.project_name || '—'}
Platforms: ${platforms}
Package:   ${d.package || '—'}
Urgency:   ${d.urgency || '—'}
Launch:    ${d.target_launch || '—'}

Goal:
${d.business_goal || '—'}

Target Users:
${d.target_users || '—'}

DELIVERABLES
────────────
${deliverables}

FEATURES
────────
${features}

Custom Features:
${d.custom_features || '—'}

SCREENS
───────
${d.screens || '—'}

DESIGN
──────
Mode:      ${d.color_mode || '—'}
Primary:   ${d.color_primary || '—'}
Accent:    ${d.color_secondary || '—'}
Font:      ${d.font_style || '—'}
Reference: ${d.design_reference || '—'}
Notes:     ${d.design_notes || '—'}

ESTIMATED QUOTE
───────────────
${quoteLines}
  ${''.padEnd(28,'─')} ─────────
  ${'TOTAL'.padEnd(28)} $${quote.total.toLocaleString()}
  ${'50% DEPOSIT TO START'.padEnd(28)} $${quote.deposit.toLocaleString()}

NOTE: Final apps use the CLIENT'S own Stripe account + webhook keys.
Arrowtrack Solutions provides and manages all hosting.

=====================================
Arrowtrack Solutions LLC | Carpinteria, CA
  `.trim();
}

// ─── Submit project brief ───────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const OWNER_EMAIL = process.env.OWNER_EMAIL;
  const data = req.body;
  const ref = genRef();
  data.ref_code = ref;
  const quote = computeQuote(data);
  data.quote_total = quote.total;
  data.quote_deposit = quote.deposit;

  const db = readDB();
  db.push({ id: Date.now(), ref_code: ref, client_name: data.client_name, client_email: data.client_email,
    company_name: data.company_name, project_name: data.project_name, quote_total: quote.total,
    status: 'new', created_at: new Date().toISOString(), data });
  writeDB(db);

  const sowText = formatSOW(data, quote);
  const htmlEmail = (title, body) => `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#0d0d0d;color:#fff;padding:40px;border-radius:12px;">
      <div style="margin-bottom:28px;"><span style="color:#7C3AED;font-size:20px;font-weight:800;">Arrowtrack</span><span style="color:#fff;font-size:20px;font-weight:800;"> Solutions</span></div>
      <h2 style="color:#22C55E;margin-bottom:20px;">${title}</h2>${body}
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #333;font-size:12px;color:#555;">Arrowtrack Solutions LLC · Carpinteria, CA · Ref: ${ref}</div></div>`;
  const quoteBox = `<div style="background:#1a1a1a;border-radius:8px;padding:20px;border-left:3px solid #7C3AED;"><pre style="color:#ccc;font-size:13px;white-space:pre-wrap;line-height:1.6;">${sowText}</pre></div>`;

  if (RESEND_API_KEY && OWNER_EMAIL) {
    try {
      await fetch('https://api.resend.com/emails', { method:'POST', headers:{'Authorization':`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
        body: JSON.stringify({ from:'Arrowtrack SOW Builder <hello@delib.io>', to:OWNER_EMAIL,
          subject:`New SOW — ${data.project_name} ($${quote.total.toLocaleString()}) · ${ref}`,
          html: htmlEmail('New Project Brief + Quote', `<p style="color:#aaa;margin-bottom:20px;">New brief from <strong style="color:#fff;">${data.client_name}</strong> · Est. <strong style="color:#22C55E;">$${quote.total.toLocaleString()}</strong></p>${quoteBox}`) }) });
      if (data.client_email) {
        await fetch('https://api.resend.com/emails', { method:'POST', headers:{'Authorization':`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
          body: JSON.stringify({ from:'Arrowtrack Solutions <hello@delib.io>', to:data.client_email,
            subject:`Your Project Quote — ${data.project_name} · ${ref}`,
            html: htmlEmail('Your Project Brief + Quote', `<p style="color:#aaa;margin-bottom:20px;">Thanks ${data.client_name}! Here's your estimated quote. We'll be in touch within 24 hours.</p>${quoteBox}`) }) });
      }
    } catch (err) { console.error('Email error:', err); }
  }
  res.json({ success: true, ref, quote });
});

// ─── Stripe Checkout for deposit (graceful without keys) ────────
app.post('/api/checkout', async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const data = req.body;
  const quote = computeQuote(data);
  if (quote.isCustom || quote.total === 0) {
    return res.json({ demo: true, message: 'Custom quote — we will contact you directly.' });
  }
  if (!STRIPE_SECRET_KEY) {
    // Test mode — no Stripe configured yet
    return res.json({ demo: true, message: `Deposit of $${quote.deposit.toLocaleString()} would be charged here once Stripe is connected.` });
  }
  try {
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${origin}/build?paid=1`);
    params.append('cancel_url', `${origin}/build`);
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', `${data.project_name || 'Project'} — 50% Deposit`);
    params.append('line_items[0][price_data][unit_amount]', String(quote.deposit * 100));
    params.append('line_items[0][quantity]', '1');
    if (data.client_email) params.append('customer_email', data.client_email);
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const session = await r.json();
    if (session.url) res.json({ url: session.url });
    else { console.error('Stripe error:', session); res.status(500).json({ error: 'Checkout failed' }); }
  } catch (err) { console.error('Checkout error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Admin API ──────────────────────────────────────────────────
app.get('/admin/api/submissions', (req, res) => {
  res.json(readDB().map(r => ({ id:r.id, ref_code:r.ref_code, client_name:r.client_name, client_email:r.client_email, company_name:r.company_name, project_name:r.project_name, quote_total:r.quote_total, status:r.status, created_at:r.created_at })).reverse());
});
app.get('/admin/api/submissions/:id', (req, res) => {
  const row = readDB().find(r => r.id == req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
app.put('/admin/api/submissions/:id', (req, res) => {
  const db = readDB(); const idx = db.findIndex(r => r.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db[idx].status = req.body.status; writeDB(db); res.json({ success: true });
});

// ─── Routes ─────────────────────────────────────────────────────
app.get('/build', (req, res) => res.sendFile(path.join(__dirname, 'public', 'build.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Arrowtrack Dev Services running on port ${PORT}`));
