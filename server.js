const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { generateStep, GENERATION_STEPS } = require('./generator');
const { deployProject } = require('./deployer');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Minimal cookie parser (no extra deps) ──────────────────────
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) raw.split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > -1) req.cookies[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  next();
});

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
// Logout: returns 401 with a throwaway realm so the browser drops its cached Basic Auth credentials.
// Must be registered BEFORE the requireAdminAuth middleware so it's reachable without valid creds.
app.get('/admin/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="logged-out"');
  res.status(401).send('Logged out.');
});

// ─── Config health check (admin only) ───────────────────────────────────────
app.get('/admin/api/health', requireAdminAuth, async (req, res) => {
  const checks = {
    anthropic:   !!process.env.ANTHROPIC_API_KEY,
    github_token: !!process.env.GITHUB_TOKEN,
    github_org:   process.env.GITHUB_ORG || null,
    resend:       !!process.env.RESEND_API_KEY,
    netlify:      !!process.env.NETLIFY_TOKEN,
    stripe:       !!process.env.STRIPE_SECRET_KEY,
    database:     !!process.env.DATABASE_URL,
    session:      !!process.env.SESSION_SECRET,
  };
  // Live GitHub ping — verify token + org actually work
  if (checks.github_token && checks.github_org) {
    try {
      const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
      await octokit.orgs.get({ org: process.env.GITHUB_ORG });
      checks.github_live = true;
    } catch (err) {
      checks.github_live = false;
      checks.github_error = err.message;
    }
  }
  res.json(checks);
});

// Guard the admin page, its static HTML, and the admin API — BEFORE static serving.
app.use(['/admin', '/admin.html'], requireAdminAuth);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Storage: Railway Postgres when DATABASE_URL is set, else local JSON ─
// Both submissions and accounts are stored as whole-collection JSON documents
// in a single key/value table. This mirrors the original JSON-file semantics
// (read the whole array, mutate, write the whole array) so the request
// handlers stay identical — only the backend swaps.
const DB_FILE = path.join(__dirname, 'submissions.json');
const ACCT_FILE = path.join(__dirname, 'accounts.json');
const DRAFTS_FILE = path.join(__dirname, 'drafts.json');
const USE_PG = !!process.env.DATABASE_URL;
let pgPool = null;
if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });
}

async function getStore(key, file, defaultValue = []) {
  if (USE_PG) {
    const { rows } = await pgPool.query('SELECT value FROM forge_kv WHERE key = $1', [key]);
    return rows.length ? rows[0].value : defaultValue;
  }
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultValue));
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return defaultValue; }
}
async function setStore(key, file, data) {
  if (USE_PG) {
    await pgPool.query(
      'INSERT INTO forge_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(data)]
    );
    return;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const readDB        = ()  => getStore('submissions', DB_FILE);
const writeDB       = (d) => setStore('submissions', DB_FILE, d);
const readAccounts  = ()  => getStore('accounts', ACCT_FILE);
const writeAccounts = (d) => setStore('accounts', ACCT_FILE, d);
// Drafts are stored as a single JSON object keyed by email — one row per user's
// in-progress brief. Allows us to update each user's draft independently from
// the rest of the funnel without race conditions on busy projects.
const readDrafts    = ()  => getStore('drafts', DRAFTS_FILE, {});
const writeDrafts   = (d) => setStore('drafts', DRAFTS_FILE, d);
const genRef = () => 'SOW-' + Date.now().toString(36).toUpperCase();

// Patch individual fields on a submission row without rewriting the whole DB.
async function updateSubmissionField(refCode, fields) {
  try {
    const db = await readDB();
    const idx = db.findIndex(r => r.ref_code === refCode);
    if (idx === -1) return;
    Object.assign(db[idx], fields);
    await writeDB(db);
  } catch (err) { console.error('updateSubmissionField error:', err); }
}

// Create the table on boot and, if it's empty, seed from any existing JSON files.
async function initStorage() {
  if (!USE_PG) { console.log('Storage: local JSON files (set DATABASE_URL for Railway Postgres)'); return; }
  await pgPool.query("CREATE TABLE IF NOT EXISTS forge_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '[]')");
  // Each KV row has its own appropriate default (array for collections, object for drafts).
  const seeds = [
    ['submissions', DB_FILE,    () => []],
    ['accounts',    ACCT_FILE,  () => []],
    ['drafts',      DRAFTS_FILE, () => ({})],
  ];
  for (const [key, file, defaultFactory] of seeds) {
    const { rows } = await pgPool.query('SELECT 1 FROM forge_kv WHERE key = $1', [key]);
    if (!rows.length) {
      let seed = defaultFactory();
      if (fs.existsSync(file)) { try { seed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
      await pgPool.query('INSERT INTO forge_kv (key, value) VALUES ($1, $2)', [key, JSON.stringify(seed)]);
    }
  }
  console.log('Storage: Railway Postgres (persistent across deploys)');
}

const normEmail = e => String(e || '').trim().toLowerCase();

// Password hashing via built-in scrypt (no native deps)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Sessions (signed httpOnly cookie, no extra deps) ────────────
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('⚠ SESSION_SECRET not set — using a random secret; logins will reset on restart. Set SESSION_SECRET in Railway.');
const SESSION_DAYS = 30;
function signSession(email) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = Buffer.from(`${normEmail(email)}|${exp}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [email, exp] = Buffer.from(payload, 'base64url').toString().split('|');
  if (Date.now() > Number(exp)) return null;
  return email;
}
function setSessionCookie(res, email) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Set-Cookie', `forge_session=${signSession(email)}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${secure}`);
}
function clearSessionCookie(res) {
  res.set('Set-Cookie', 'forge_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}
function requireCustomer(req, res, next) {
  const email = verifySession(req.cookies.forge_session);
  if (!email) return res.status(401).json({ error: 'Not logged in' });
  req.customerEmail = email;
  next();
}

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
  },
  // Optional recurring monthly maintenance/upkeep plan (billed separately from the one-time build)
  carePlan: { label: 'Care Plan', price: 199, desc: 'Managed hosting, uptime monitoring, security patches, bug fixes & priority support. Cancel anytime.' }
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
  const monthly = d.care_plan ? PRICING.carePlan.price : 0;
  return { items, total, deposit: Math.round(total * 0.5), monthly, isCustom: d.package && d.package.startsWith('Custom') };
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
${quote.monthly ? `\nONGOING CARE PLAN\n─────────────────\n  ${'Care Plan'.padEnd(28)} $${quote.monthly.toLocaleString()}/mo\n  Managed hosting, monitoring, security patches, bug fixes & priority support.\n  Billed monthly after launch. Cancel anytime.\n` : ''}
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

  // Create a customer account on first submit if a password was provided, then log them in.
  // Strip the raw password BEFORE persisting so it never lands in submissions.json.
  const rawPassword = data.password;
  delete data.password;
  if (rawPassword && data.client_email) {
    const accts = await readAccounts();
    const email = normEmail(data.client_email);
    if (!accts.find(a => a.email === email)) {
      accts.push({ email, name: data.client_name || '', password: hashPassword(rawPassword), created_at: new Date().toISOString() });
      await writeAccounts(accts);
    }
    setSessionCookie(res, email);
  }

  const db = await readDB();
  db.push({ id: Date.now(), ref_code: ref, client_name: data.client_name, client_email: data.client_email,
    company_name: data.company_name, project_name: data.project_name, quote_total: quote.total,
    status: 'new', created_at: new Date().toISOString(), data });
  await writeDB(db);

  // Promote the in-progress draft to a finalized submission: mark it submitted
  // and stop reminder emails. We keep the draft row for audit but flag it so
  // it stops appearing in the "abandoned" admin view.
  if (data.client_email) {
    try {
      const drafts = await readDrafts();
      const key = normEmail(data.client_email);
      if (drafts[key]) {
        drafts[key].status = 'submitted';
        drafts[key].submitted_at = new Date().toISOString();
        drafts[key].ref_code = ref;
        await writeDrafts(drafts);
      }
    } catch (err) { console.error('Draft promotion failed (non-fatal):', err); }
  }

  // ── Fire-and-forget deploy pipeline ─────────────────────────────────────────
  // Reads the customer's generated files from their draft (saved by the wizard)
  // and deploys them: GitHub repo → Netlify → screenshot → back-fills the row.
  if (process.env.NETLIFY_TOKEN && data.client_email) {
    (async () => {
      try {
        await updateSubmissionField(ref, { deploy_status: 'deploying' });
        const drafts = await readDrafts();
        const draft = drafts[normEmail(data.client_email)];
        const files = draft && draft.generatedFiles;
        if (!files || Object.keys(files).length === 0) {
          await updateSubmissionField(ref, { deploy_status: 'no_files' });
          console.log(`[Deploy ${ref}] No generated files — skipping deploy`);
          return;
        }
        const result = await deployProject({
          refCode: ref,
          projectName: data.project_name || ref,
          files,
        });
        await updateSubmissionField(ref, {
          deploy_status:   'ready',
          deploy_url:      result.deployUrl,
          repo_url:        result.repoUrl,
          screenshot_url:  result.screenshotUrl,
          site_id:         result.siteId || null,
        });
      } catch (err) {
        console.error(`[Deploy ${ref}] Pipeline failed:`, err.message);
        await updateSubmissionField(ref, { deploy_status: 'failed', deploy_error: err.message });
      }
    })();
  }

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

// ─── Email helpers (reusable) ───────────────────────────────────
function emailShell(title, bodyHtml, ref) {
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#0d0d0d;color:#fff;padding:40px;border-radius:12px;">
      <div style="margin-bottom:28px;"><span style="color:#7C3AED;font-size:20px;font-weight:800;">Arrowtrack</span><span style="color:#fff;font-size:20px;font-weight:800;"> Solutions</span></div>
      <h2 style="color:#22C55E;margin-bottom:20px;">${title}</h2>${bodyHtml}
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #333;font-size:12px;color:#555;">Arrowtrack Solutions LLC · Carpinteria, CA${ref ? ' · Ref: ' + ref : ''}</div></div>`;
}
async function sendEmail(to, subject, html, from = 'Arrowtrack Solutions <hello@delib.io>') {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html })
    });
    return r.ok;
  } catch (err) { console.error('sendEmail error:', err); return false; }
}

// ─── Admin API ──────────────────────────────────────────────────
app.get('/admin/api/submissions', async (req, res) => {
  const db = await readDB();
  res.json(db.map(r => ({ id:r.id, ref_code:r.ref_code, client_name:r.client_name, client_email:r.client_email, company_name:r.company_name, project_name:r.project_name, quote_total:r.quote_total, status:r.status, created_at:r.created_at, deploy_status:r.deploy_status||null })).reverse());
});

// Abandoned-draft list for the admin dashboard. Returns one row per user with
// an in-progress draft (not yet submitted), most-recently-touched first, so the
// owner can see who's mid-funnel and follow up.
app.get('/admin/api/drafts', async (req, res) => {
  const drafts = await readDrafts();
  const rows = Object.entries(drafts)
    .filter(([_, d]) => d && d.status === 'in_progress')
    .map(([email, d]) => {
      const fd = d.formData || {};
      const q = (typeof computeQuote === 'function') ? computeQuote(fd) : { total: 0 };
      return {
        email,
        name: fd.client_name || fd.first_name || '',
        company_name: fd.company_name || '',
        project_name: fd.project_name || '',
        currentStep: d.currentStep || null,
        last_saved_at: d.last_saved_at,
        created_at: d.created_at,
        quote_total: q.total || 0,
        reminders_sent: d.reminders_sent || {},
      };
    })
    .sort((a, b) => new Date(b.last_saved_at) - new Date(a.last_saved_at));
  res.json(rows);
});

// CRON-triggered reminder mailer. Protected by CRON_SECRET so only a real cron
// (Railway scheduled job, cron-job.org, etc.) can hit it. Sends a single email
// at each interval bucket (24h, 72h, 7d) per draft and tracks what's been sent.
app.post('/api/cron/draft-reminders', async (req, res) => {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET || (req.headers['x-cron-secret'] !== CRON_SECRET && req.query.secret !== CRON_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.json({ skipped: true, reason: 'RESEND_API_KEY not configured' });
  const drafts = await readDrafts();
  const origin = `${req.protocol}://${req.get('host')}`;
  const now = Date.now();
  const buckets = [
    { id: '24h', minHours: 24,  maxHours: 72,  subject: 'You started a project brief — pick up where you left off' },
    { id: '72h', minHours: 72,  maxHours: 168, subject: 'Still interested? Your saved Forge brief is waiting' },
    { id: '7d',  minHours: 168, maxHours: 720, subject: 'Final reminder — your Forge project brief' },
  ];
  let sent = 0, considered = 0;
  for (const [email, d] of Object.entries(drafts)) {
    if (!d || d.status !== 'in_progress') continue;
    considered++;
    const ageHours = (now - new Date(d.last_saved_at || d.created_at).getTime()) / 3.6e6;
    d.reminders_sent = d.reminders_sent || {};
    for (const b of buckets) {
      if (ageHours >= b.minHours && ageHours < b.maxHours && !d.reminders_sent[b.id]) {
        const proj = (d.formData && d.formData.project_name) || 'your project';
        const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#0d0d0d;color:#fff;padding:40px;border-radius:12px;">
          <div style="margin-bottom:28px;"><span style="color:#7C3AED;font-size:20px;font-weight:800;">Arrowtrack</span><span style="color:#fff;font-size:20px;font-weight:800;"> Forge</span></div>
          <h2 style="color:#22C55E;margin-bottom:20px;">Your project brief is waiting</h2>
          <p style="color:#aaa;margin-bottom:18px;">Hi ${(d.formData && d.formData.first_name) || 'there'} — you started a brief for <strong style="color:#fff;">${proj}</strong> and saved partway through. Your progress is safe.</p>
          <p style="margin:26px 0;"><a href="${origin}/build" style="background:#7C3AED;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;display:inline-block;">Resume Your Project →</a></p>
          <p style="color:#777;font-size:13px;">Log in with the same email and password you used to start. We auto-save every step, so you can pick up exactly where you left off.</p>
        </div>`;
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'Arrowtrack Forge <hello@delib.io>', to: email, subject: b.subject, html }),
          });
          if (r.ok) {
            d.reminders_sent[b.id] = new Date().toISOString();
            sent++;
          }
        } catch (err) { console.error('Reminder send failed for', email, err); }
        break; // only one bucket per draft per run
      }
    }
  }
  await writeDrafts(drafts);
  res.json({ considered, sent });
});
app.get('/admin/api/submissions/:id', async (req, res) => {
  const row = (await readDB()).find(r => r.id == req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
app.put('/admin/api/submissions/:id', async (req, res) => {
  const db = await readDB(); const idx = db.findIndex(r => r.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db[idx].status = req.body.status; await writeDB(db); res.json({ success: true });
});
app.delete('/admin/api/submissions/:id', async (req, res) => {
  const db = await readDB(); const idx = db.findIndex(r => r.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = db.splice(idx, 1);
  await writeDB(db);
  // Remove the customer's account too if they have no other submissions left.
  const email = normEmail(removed.client_email);
  if (email && !db.some(r => normEmail(r.client_email) === email)) {
    const accts = await readAccounts();
    const filtered = accts.filter(a => a.email !== email);
    if (filtered.length !== accts.length) await writeAccounts(filtered);
  }
  res.json({ success: true });
});
// Approve a brief and email the customer a link to pay their deposit in the portal.
app.post('/admin/api/submissions/:id/send-payment-link', async (req, res) => {
  const db = await readDB(); const idx = db.findIndex(r => r.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const row = db[idx];
  const quote = computeQuote(row.data || {});
  if (quote.isCustom || quote.deposit === 0) return res.status(400).json({ error: 'Custom quote — no fixed deposit to bill. Contact the client directly.' });
  row.status = 'approved';
  await writeDB(db);
  const origin = `${req.protocol}://${req.get('host')}`;
  const portalUrl = `${origin}/project`;
  const body = `<p style="color:#aaa;margin-bottom:16px;">Hi ${row.client_name || 'there'}, your project brief has been reviewed and <strong style="color:#22C55E;">approved</strong>. 🎉</p>
    <p style="color:#aaa;margin-bottom:16px;">To lock in your build, please pay your <strong style="color:#22C55E;">50% deposit of $${quote.deposit.toLocaleString()}</strong> (project total $${quote.total.toLocaleString()}).</p>
    <p style="margin:26px 0;"><a href="${portalUrl}" style="background:#7C3AED;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;display:inline-block;">Review &amp; Pay Deposit →</a></p>
    <p style="color:#777;font-size:13px;">Log in with the email and password you used when submitting your brief. The remaining 50% is due on delivery.</p>`;
  const emailSent = await sendEmail(row.client_email, `Your project is approved — pay your deposit · ${row.ref_code}`, emailShell('Your Project is Approved', body, row.ref_code));
  res.json({ success: true, status: 'approved', emailSent, deposit: quote.deposit, portalUrl });
});

// ─── Domain assignment ──────────────────────────────────────────────────────
// Admin assigns a custom domain to a deployed Netlify site.
// Netlify provisions the domain link; we hand back DNS records for the customer.
app.post('/admin/api/submissions/:id/assign-domain', requireAdminAuth, async (req, res) => {
  const rawDomain = String(req.body.domain || '').trim();
  if (!rawDomain) return res.status(400).json({ error: 'Domain is required.' });

  // Normalise: strip protocol + trailing path, lowercase
  const domain = rawDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!domain.includes('.') || domain.length < 4) {
    return res.status(400).json({ error: 'Please enter a valid domain (e.g. www.yourbusiness.com).' });
  }

  const db = await readDB();
  const idx = db.findIndex(r => r.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Submission not found.' });
  const row = db[idx];

  if (!row.site_id) return res.status(400).json({ error: 'No Netlify site linked to this submission. Deploy the app first.' });
  if (!process.env.NETLIFY_TOKEN) return res.status(500).json({ error: 'NETLIFY_TOKEN not configured on the server.' });

  const token = process.env.NETLIFY_TOKEN;
  const base  = 'https://api.netlify.com/api/v1';
  const auth  = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // Tell Netlify to link this custom domain to the site
    const r = await fetch(`${base}/sites/${row.site_id}/domains`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ hostname: domain }),
    });
    if (!r.ok) {
      const body = await r.text();
      let msg = 'Failed to assign domain on Netlify.';
      try { msg = JSON.parse(body).message || msg; } catch {}
      return res.status(r.status).json({ error: msg });
    }

    // Fetch the site to get the netlify subdomain for DNS instructions
    const siteRes = await fetch(`${base}/sites/${row.site_id}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const site = siteRes.ok ? await siteRes.json() : null;
    const netlifyHost = site
      ? (site.ssl_url || site.url || '').replace(/^https?:\/\//, '')
      : (row.deploy_url || '').replace(/^https?:\/\//, '');

    // Build DNS records based on domain type
    const parts = domain.split('.');
    const isApex = parts.length === 2; // e.g. "mybusiness.com" — no subdomain
    const dnsRecords = isApex
      ? [
          { type: 'A',     host: '@',   value: '75.2.60.5',  ttl: '3600', note: 'Apex domain → Netlify load balancer' },
          { type: 'CNAME', host: 'www', value: netlifyHost,  ttl: '3600', note: 'www → Netlify site' },
        ]
      : [
          { type: 'CNAME', host: parts.slice(0, -2).join('.') || '@', value: netlifyHost, ttl: '3600', note: 'Subdomain → Netlify site' },
        ];

    // Persist to submission row
    db[idx].custom_domain     = domain;
    db[idx].domain_status     = 'pending_dns';
    db[idx].domain_dns_records = dnsRecords;
    await writeDB(db);

    console.log(`[Domain] Assigned ${domain} → site ${row.site_id} for ${row.ref_code}`);
    res.json({ success: true, domain, dns_records: dnsRecords, netlify_host: netlifyHost });
  } catch (err) {
    console.error('assign-domain error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark a custom domain as active (admin confirms DNS has propagated)
app.post('/admin/api/submissions/:id/domain-active', requireAdminAuth, async (req, res) => {
  const db = await readDB();
  const idx = db.findIndex(r => r.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found.' });
  db[idx].domain_status = 'active';
  await writeDB(db);
  res.json({ success: true });
});

// ─── Customer auth API ──────────────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const email = normEmail(req.body.email);
  // Always return 200 — never reveal whether the email exists.
  res.json({ success: true });
  if (!email) return;
  try {
    const accts = await readAccounts();
    const acct = accts.find(a => a.email === email);
    if (!acct) return; // silent — no account for this email
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 60 * 60 * 1000; // 1 hour
    acct.reset_token = token;
    acct.reset_token_expiry = expiry;
    await writeAccounts(accts);
    const resetUrl = `${process.env.APP_URL || `https://${req.get('host')}`}/reset-password?token=${token}`;
    await sendEmail(
      email,
      'Reset your Arrowtrack Forge password',
      emailShell('Reset Your Password',
        `<p style="color:#aaa;margin-bottom:20px;">We received a request to reset the password for your account.</p>
         <p style="margin:26px 0;"><a href="${resetUrl}" style="background:#7C3AED;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;display:inline-block;">Reset My Password →</a></p>
         <p style="color:#777;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>`,
        'reset')
    );
  } catch (err) { console.error('forgot-password error:', err); }
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  try {
    const accts = await readAccounts();
    const acct = accts.find(a => a.reset_token === token);
    if (!acct) return res.status(400).json({ error: 'Reset link is invalid or has already been used.' });
    if (Date.now() > acct.reset_token_expiry) return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    acct.password = hashPassword(password);
    delete acct.reset_token;
    delete acct.reset_token_expiry;
    await writeAccounts(accts);
    res.json({ success: true });
  } catch (err) { console.error('reset-password error:', err); res.status(500).json({ error: 'Server error. Please try again.' }); }
});

app.post('/api/login', async (req, res) => {
  const email = normEmail(req.body.email);
  const acct = (await readAccounts()).find(a => a.email === email);
  if (!acct || !verifyPassword(req.body.password, acct.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  setSessionCookie(res, email);
  res.json({ success: true, name: acct.name, email });
});

// ─── Progressive app generation ─────────────────────────────────────────────
// Called after each wizard step. No session required — anonymous users get
// files back in the response; signed-in users also get them saved to their draft.
app.post('/api/draft/generate', requireCustomer, async (req, res) => {
  const step = Number(req.body.step);
  const formData = req.body.formData || {};
  const clientFiles = req.body.existingFiles || {}; // client sends back what it has

  if (!GENERATION_STEPS.includes(step)) {
    return res.json({ skipped: true, step });
  }

  try {
    const result = await generateStep(step, formData, clientFiles);

    // If signed in, persist generated files to the server draft too
    const email = verifySession(req.cookies.forge_session);
    if (email) {
      try {
        const drafts = await readDrafts();
        const key = normEmail(email);
        if (!drafts[key]) drafts[key] = {};
        drafts[key].generatedFiles = result.files;
        drafts[key].generationStep = step;
        await writeDrafts(drafts);
      } catch (e) { /* non-fatal — client already has the files */ }
    }

    res.json({ success: true, files: result.files, summary: result.summary, step });
  } catch (err) {
    console.error('Generation error step', step, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Preview: serve a specific generated file from the signed-in user's draft
// (fallback — anonymous users render via blob URL client-side)
app.get('/preview/:filename', requireCustomer, async (req, res) => {
  try {
    const drafts = await readDrafts();
    const draft = drafts[normEmail(req.customerEmail)];
    const files = draft && draft.generatedFiles;
    const content = files && files[req.params.filename];
    if (!content) return res.status(404).send('Not generated yet.');
    const ext = req.params.filename.split('.').pop();
    const types = { html: 'text/html', css: 'text/css', js: 'application/javascript' };
    res.set('Content-Type', types[ext] || 'text/plain');
    res.send(content);
  } catch (err) { res.status(500).send('Error loading preview.'); }
});

// ─── Draft funnel: progressive save so half-finished briefs aren't lost ─
// Flow:
//   POST /api/draft/start   — Step-1 gate: name + email + password →
//                             creates account (or rejects if email already exists with diff password)
//                             creates empty draft, sets session
//   POST /api/draft/resume  — returning user: email + password → log in,
//                             load existing draft if any
//   GET  /api/draft/load    — auth'd: fetch the current user's draft
//   POST /api/draft/save    — auth'd: persist formData + currentStep on every Continue
// /api/submit later finds the user's draft and promotes it to a submission.

app.post('/api/draft/start', async (req, res) => {
  const email = normEmail(req.body.email);
  const firstName = String(req.body.first_name || '').trim();
  const password = String(req.body.password || '');
  if (!email || !firstName || !password) {
    return res.status(400).json({ error: 'Name, email, and password are all required.' });
  }
  if (!email.includes('@') || password.length < 6) {
    return res.status(400).json({ error: 'Please enter a valid email and a password of at least 6 characters.' });
  }
  const accts = await readAccounts();
  const existing = accts.find(a => a.email === email);
  if (existing) {
    // Treat as a login attempt — if the password matches, log them in. If not, reject.
    if (!verifyPassword(password, existing.password)) {
      return res.status(409).json({ error: 'An account with that email already exists. Please use Resume to log in, or pick a different email.' });
    }
    setSessionCookie(res, email);
  } else {
    accts.push({ email, name: firstName, password: hashPassword(password), created_at: new Date().toISOString() });
    await writeAccounts(accts);
    setSessionCookie(res, email);
  }
  // Initialize (or reuse) their draft.
  const drafts = await readDrafts();
  if (!drafts[email]) {
    drafts[email] = {
      formData: { first_name: firstName, client_email: email, client_name: firstName },
      currentStep: 2,            // they've completed the gate, ready for step 2 of wizard
      status: 'in_progress',
      created_at: new Date().toISOString(),
      last_saved_at: new Date().toISOString(),
      reminders_sent: {},
    };
    await writeDrafts(drafts);
  }
  res.json({ success: true, email, name: firstName, draft: drafts[email] });
});

app.post('/api/draft/resume', async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  const acct = (await readAccounts()).find(a => a.email === email);
  if (!acct || !verifyPassword(password, acct.password)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  setSessionCookie(res, email);
  const drafts = await readDrafts();
  res.json({ success: true, email, name: acct.name, draft: drafts[email] || null });
});

app.get('/api/draft/load', requireCustomer, async (req, res) => {
  const drafts = await readDrafts();
  res.json({ draft: drafts[req.customerEmail] || null });
});

app.post('/api/draft/save', requireCustomer, async (req, res) => {
  const drafts = await readDrafts();
  const existing = drafts[req.customerEmail] || {
    status: 'in_progress',
    created_at: new Date().toISOString(),
    reminders_sent: {},
  };
  drafts[req.customerEmail] = {
    ...existing,
    formData: req.body.formData || existing.formData || {},
    currentStep: Number(req.body.currentStep) || existing.currentStep || 2,
    last_saved_at: new Date().toISOString(),
  };
  await writeDrafts(drafts);
  res.json({ success: true, last_saved_at: drafts[req.customerEmail].last_saved_at });
});

app.post('/api/logout', (req, res) => { clearSessionCookie(res); res.json({ success: true }); });

app.get('/api/me', async (req, res) => {
  const email = verifySession(req.cookies.forge_session);
  if (!email) return res.status(401).json({ error: 'Not logged in' });
  const acct = (await readAccounts()).find(a => a.email === email);
  res.json({ email, name: acct ? acct.name : '' });
});

// All projects belonging to the logged-in customer
app.get('/api/my-projects', requireCustomer, async (req, res) => {
  const mine = (await readDB()).filter(r => normEmail(r.client_email) === req.customerEmail)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(mine.map(r => {
    const q = computeQuote(r.data || {});
    return {
      ref_code: r.ref_code, project_name: r.project_name, company_name: r.company_name,
      status: r.status, created_at: r.created_at,
      quote_total: q.total, quote_deposit: q.deposit, balance_due: Math.max(0, q.total - q.deposit),
      quote_monthly: q.monthly,
      deposit_paid: !!r.deposit_paid, balance_paid: !!r.balance_paid,
      deploy_status:      r.deploy_status || null,
      deploy_url:         r.deploy_url || null,
      custom_domain:      r.custom_domain || null,
      domain_status:      r.domain_status || null,
      domain_dns_records: r.domain_dns_records || null,
      data: r.data
    };
  }));
});

// Pay the remaining balance on a delivered project (customer's own Stripe checkout)
app.post('/api/pay-balance', requireCustomer, async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const row = (await readDB()).find(r => r.ref_code === req.body.ref_code && normEmail(r.client_email) === req.customerEmail);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  const q = computeQuote(row.data || {});
  const balance = Math.max(0, q.total - q.deposit);
  if (balance === 0) return res.json({ demo: true, message: 'No balance due on this project.' });
  if (!STRIPE_SECRET_KEY) {
    return res.json({ demo: true, message: `Remaining balance of $${balance.toLocaleString()} would be charged here once Stripe is connected.` });
  }
  try {
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${origin}/project?balance_paid=1`);
    params.append('cancel_url', `${origin}/project`);
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', `${row.project_name || 'Project'} — Final Balance`);
    params.append('line_items[0][price_data][unit_amount]', String(balance * 100));
    params.append('line_items[0][quantity]', '1');
    params.append('customer_email', req.customerEmail);
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const session = await r.json();
    if (session.url) res.json({ url: session.url });
    else { console.error('Stripe error:', session); res.status(500).json({ error: 'Checkout failed' }); }
  } catch (err) { console.error('Balance checkout error:', err); res.status(500).json({ error: 'Server error' }); }
});

// Pay the 50% deposit on an approved project (customer's own Stripe checkout)
app.post('/api/pay-deposit', requireCustomer, async (req, res) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const db = await readDB();
  const row = db.find(r => r.ref_code === req.body.ref_code && normEmail(r.client_email) === req.customerEmail);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  if (row.status !== 'approved') return res.status(400).json({ error: 'This project has not been approved for payment yet.' });
  if (row.deposit_paid) return res.json({ demo: true, message: 'Your deposit has already been paid.' });
  const q = computeQuote(row.data || {});
  if (q.isCustom || q.deposit === 0) return res.status(400).json({ error: 'This is a custom quote — we will invoice you directly.' });
  if (!STRIPE_SECRET_KEY) {
    return res.json({ demo: true, message: `Deposit of $${q.deposit.toLocaleString()} would be charged here once Stripe is connected.` });
  }
  try {
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${origin}/project?deposit_paid=1`);
    params.append('cancel_url', `${origin}/project`);
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', `${row.project_name || 'Project'} — 50% Deposit`);
    params.append('line_items[0][price_data][unit_amount]', String(q.deposit * 100));
    params.append('line_items[0][quantity]', '1');
    params.append('customer_email', req.customerEmail);
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const session = await r.json();
    if (session.url) res.json({ url: session.url });
    else { console.error('Stripe error:', session); res.status(500).json({ error: 'Checkout failed' }); }
  } catch (err) { console.error('Deposit checkout error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Routes ─────────────────────────────────────────────────────
app.get('/build', (req, res) => res.sendFile(path.join(__dirname, 'public', 'build.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));
app.get('/project', (req, res) => res.sendFile(path.join(__dirname, 'public', 'project.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initStorage()
  .catch(err => console.error('Storage init failed:', err))
  .finally(() => app.listen(PORT, () => console.log(`Arrowtrack Dev Services running on port ${PORT}`)));
