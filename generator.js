// ─── Arrowtrack Forge — Progressive App Generator ───────────────────────────
// Generates a working web app step-by-step as the wizard is filled out.
// Each step UPDATES the existing generated files rather than starting fresh.
// Claude returns structured file output via tool use — always valid JSON.

const Anthropic = require('@anthropic-ai/sdk');

// Steps that trigger generation (others are skipped — no meaningful visual change)
const GENERATION_STEPS = [1, 2, 3, 4, 5, 7];

const STEP_LABELS = {
  1: 'Building your app structure...',
  2: 'Adding platform components...',
  3: 'Wiring up features...',
  4: 'Laying out your screens...',
  5: 'Applying your brand...',
  7: 'Personalising your content...',
};

// ─── System prompt ──────────────────────────────────────────────────────────
function systemPrompt() {
  return `You are an expert web developer generating production-quality web apps for small businesses via Arrowtrack Forge.

Rules:
- Generate clean, modern, professional HTML/CSS/JavaScript
- NEVER use placeholder text like [INSERT HERE] or TODO — always write real, specific content
- Make the app look like a real, professionally designed product worth $3,500+
- All styles go in styles.css — no inline styles except for dynamic values
- app.js handles all interactivity
- index.html is the main entry point
- Content must be 100% relevant to the specific business described
- Dark theme default: background #0D0D0D, brand purple #7C3AED, accent green #22C55E, font Inter
- When updating existing files: preserve what's good, only change what's needed for this step`;
}

// ─── Per-step prompts ────────────────────────────────────────────────────────
function stepPrompt(step, d, existing) {
  const hasExisting = existing && Object.keys(existing).length > 0;

  // Truncate existing files to stay within context window
  const existingCtx = hasExisting
    ? '\n\nEXISTING FILES (update these, do not start from scratch):\n' +
      Object.entries(existing)
        .map(([name, content]) => `\n=== ${name} ===\n${content.slice(0, 3000)}`)
        .join('\n')
    : '';

  const platforms = [
    d.platform_web && 'Web App',
    d.platform_ios && 'iOS',
    d.platform_android && 'Android',
  ].filter(Boolean).join(', ') || 'Web';

  const deliverables = [
    d.del_admin && 'Admin Dashboard',
    d.del_payments && 'Payments',
    d.del_ai && 'AI Features',
    d.del_push && 'Push Notifications',
    d.del_email && 'Email Notifications',
    d.del_maps && 'Maps / Location',
    d.del_analytics && 'Analytics',
    d.del_cms && 'CMS',
  ].filter(Boolean).join(', ');

  const features = [
    d.feat_auth && 'Email/Password Auth',
    d.feat_oauth && 'Social Login (Google/Apple)',
    d.feat_roles && 'User Roles & Permissions',
    d.feat_magic && 'Magic Link Login',
    d.feat_stripe && 'Stripe Payments',
    d.feat_subscriptions && 'Subscriptions',
    d.feat_freemium && 'Freemium Model',
    d.feat_iap && 'In-App Purchases',
    d.feat_ai_content && 'AI Content Generation',
    d.feat_ai_chat && 'AI Chat Assistant',
    d.feat_ai_analysis && 'AI Data Analysis',
    d.feat_automation && 'Workflow Automation',
  ].filter(Boolean).join(', ');

  // screens_list is the canonical field from the wizard; fall back to screens for legacy submissions
  const screensList = (Array.isArray(d.screens_list) && d.screens_list.length > 0)
    ? d.screens_list
    : Array.isArray(d.screens) ? d.screens.filter(Boolean)
    : (d.screens ? [d.screens] : ['Home', 'Contact', 'Terms & Privacy']);

  // Map screen names → filenames
  function screenToFile(name) {
    const map = {
      'home': 'index.html', 'landing': 'index.html',
      'about': 'about.html', 'about us': 'about.html',
      'contact': 'contact.html', 'contact us': 'contact.html',
      'terms': 'terms.html', 'terms & privacy': 'terms.html', 'privacy': 'terms.html',
      'terms and privacy': 'terms.html', 'terms of service': 'terms.html',
      'pricing': 'pricing.html', 'prices': 'pricing.html',
      'services': 'services.html', 'faq': 'faq.html',
      'login': 'login.html', 'sign up': 'signup.html', 'signup': 'signup.html',
      'dashboard': 'dashboard.html',
    };
    return map[name.toLowerCase()] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.html';
  }

  // Always include contact + terms; add everything else from the user's list
  const pageFiles = {};
  const corePages = ['Home', 'Contact', 'Terms & Privacy'];
  [...corePages, ...screensList].forEach(name => {
    const file = screenToFile(name);
    if (!pageFiles[file]) pageFiles[file] = name; // filename → display name
  });
  // index.html is always the Home page
  pageFiles['index.html'] = pageFiles['index.html'] || 'Home';

  const pageList = Object.entries(pageFiles)
    .map(([file, name]) => `- ${file} (${name})`)
    .join('\n');

  const navLinks = Object.entries(pageFiles)
    .map(([file, name]) => `<a href="${file}">${name}</a>`)
    .join(' | ');

  const prompts = {
    1: `Generate a complete, professional multi-page web app for this business.

BUSINESS:
- Company: ${d.company_name || 'Company'}
- Project: ${d.project_name || 'App'}
- Industry: ${d.business_type || 'Business'}
- Goal: ${d.business_goal || 'Build a great app'}
- Target Users: ${d.target_users || 'General users'}

Generate these files:
1. index.html — Home/landing page: sticky nav with links to contact.html and terms.html, hero (bold headline + CTA), 3-feature section, how-it-works (3 steps), testimonials or stats, final CTA, footer
2. contact.html — Contact page: same nav + footer as index.html, contact form (name, email, phone, message fields), submit button, business contact details
3. terms.html — Terms & Privacy page: same nav + footer, Terms of Service section, Privacy Policy section, all content relevant to the business
4. styles.css — ONE shared stylesheet used by all pages: dark theme (#0D0D0D bg), Inter font via Google Fonts, responsive, smooth animations, mobile-first. All pages must look consistent.
5. app.js — Shared interactivity: mobile nav toggle, smooth scroll, contact form validation + fake submit success

IMPORTANT: Every page must link <link rel="stylesheet" href="styles.css"> and <script src="app.js"></script>.
Nav must be identical across all pages. Make EVERY piece of content specific to this business.`,

    2: `Update the app for these platform and deliverable requirements.

PLATFORMS: ${platforms}
DELIVERABLES: ${deliverables || 'None selected yet'}

Changes needed:
${d.platform_ios || d.platform_android ? '- Add "Available on iOS & Android" badge/section and app store CTA buttons to index.html\n' : ''}${d.del_payments ? '- Add a pricing section with 3 tiers to index.html\n' : ''}${d.del_admin ? '- Add an "Admin Dashboard" feature card/section to index.html\n' : ''}${d.del_ai ? '- Add an AI-powered features section to index.html\n' : ''}${d.del_maps ? '- Add a location/map section to index.html\n' : ''}
Return only the files that need updating.${existingCtx}`,

    3: `Update the app to showcase these features.

FEATURES: ${features || 'None selected yet'}

${features ? `Add UI elements for: ${features}
- For Auth: add a sign-up/login modal or section to index.html
- For Payments/Stripe: add payment or pricing UI to index.html
- For AI: add an AI feature showcase section to index.html
- For Roles: mention user types in the hero or features
Return only files that change.` : 'No features selected yet — return existing files unchanged.'}${existingCtx}`,

    4: `Create or update individual HTML pages for each screen the client needs.

PAGES NEEDED:
${pageList}

USER FLOWS: ${d.user_flows || 'Not specified'}

Rules:
- index.html = Home page (update if it exists, create if not)
- contact.html = Contact page with a contact form (name, email, message), submit button, and business contact details
- terms.html = Terms & Privacy page with Terms of Service + Privacy Policy relevant to this business
- For any other page: create a full page matching the screen name, relevant content for the business
- ALL pages MUST share the same nav: ${navLinks}
- ALL pages MUST use <link rel="stylesheet" href="styles.css"> and <script src="app.js"></script>
- Nav links must correctly point to the right filename (e.g. href="contact.html")
- Footer must be identical across all pages

Return ALL page files (index.html, contact.html, terms.html, and any extras). Return styles.css only if nav/footer styles need updating.${existingCtx}`,

    5: `Apply this exact design system to the app.

DESIGN SPEC:
- Color Mode: ${d.color_mode || 'Dark Mode'}
- Primary Brand Color: ${d.color_primary || '#7C3AED'}
- Accent Color: ${d.color_secondary || '#22C55E'}
- Typography Style: ${d.font_style || 'Modern & Clean (Inter, SF Pro)'}
- Design References: ${d.design_reference || 'None'}
- Brand Assets: ${d.brand_assets || 'None yet'}
- Design Notes: ${d.design_notes || 'None'}

Update styles.css to apply these exact colors and typography throughout.
Replace the default #7C3AED with ${d.color_primary || '#7C3AED'} and #22C55E with ${d.color_secondary || '#22C55E'}.
${d.font_style && d.font_style.includes('Poppins') ? "Load Poppins from Google Fonts instead of Inter." : ''}
${d.color_mode === 'Light Mode' ? 'Switch to light theme: white background (#FFFFFF), dark text (#111111).' : ''}
Return only styles.css.${existingCtx}`,

    7: `Personalize all content with the real business information.

CLIENT:
- Name: ${d.first_name || ''} ${d.last_name || ''}
- Email: ${d.client_email || ''}
- Phone: ${d.phone || ''}
- Website: ${d.company_url || ''}
- Company: ${d.company_name || ''}
- Project: ${d.project_name || ''}

Update ALL HTML files:
- Replace any placeholder contact details with the real ones above
- Update footer across all pages: real email, phone, website
- contact.html form action: use mailto:${d.client_email || 'contact@example.com'}
- Make all CTAs link to the real email (mailto:) if no website yet
- Ensure every page feels finished, consistent, ready to show to this client

Return ALL HTML files that exist (index.html, contact.html, terms.html, and any others).${existingCtx}`,
  };

  return prompts[step] || `Step ${step} — current data: ${JSON.stringify(d)}${existingCtx}`;
}

// ─── Main generation function ────────────────────────────────────────────────
async function generateStep(stepNumber, formData, existingFiles = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured in Railway environment variables.');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    system: systemPrompt(),
    tools: [{
      name: 'deliver_files',
      description: 'Deliver the generated or updated web app files.',
      input_schema: {
        type: 'object',
        properties: {
          files: {
            type: 'object',
            description: 'Object where keys are filenames (e.g. "index.html") and values are the complete file contents as strings.',
            additionalProperties: { type: 'string' }
          },
          summary: {
            type: 'string',
            description: 'One sentence describing what was generated or changed in this step.'
          }
        },
        required: ['files', 'summary']
      }
    }],
    tool_choice: { type: 'any' },
    messages: [{
      role: 'user',
      content: stepPrompt(stepNumber, formData, existingFiles)
    }]
  });

  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'deliver_files');
  if (!toolUse || !toolUse.input || !toolUse.input.files) {
    throw new Error('Generator returned no files. Try again.');
  }

  // Merge: new output overrides existing, existing files not in new output are preserved
  const merged = { ...existingFiles, ...toolUse.input.files };

  return {
    files: merged,
    summary: toolUse.input.summary || STEP_LABELS[stepNumber] || 'Updated.'
  };
}

module.exports = { generateStep, GENERATION_STEPS, STEP_LABELS };
