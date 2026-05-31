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
  return `You are a senior product designer AND front-end engineer generating award-winning web-app demos for small businesses via Arrowtrack Forge. Your output is the thing that convinces a client to spend thousands — it must look like a top agency built it.

OUTPUT RULES:
- Clean, modern, semantic HTML5 + CSS3 + vanilla JavaScript. No frameworks. No external images or CDNs except Google Fonts (the environment has no image assets — build all visuals with CSS gradients, inline SVG, and tasteful emoji).
- All styles go in styles.css. All interactivity in app.js. index.html is the entry point.
- NEVER use placeholder text ([INSERT], TODO, Lorem ipsum). Write real, specific, on-brand copy for THIS business.
- When updating files: preserve what already works and keep the design language identical across every page. Only change what the step requires.

DESIGN LANGUAGE — make it genuinely impressive ("wow"):
- Drive everything from a design system in :root — CSS custom properties for colors, spacing, radius, shadows, and a FLUID type scale using clamp().
- Dark theme by default: base #0D0D0D, elevated surfaces #15151B / #1C1C24, brand #7C3AED, accent #22C55E, muted text ~#9AA0AC, hairline borders rgba(255,255,255,0.06).
- Depth & polish: soft layered shadows, 1px translucent borders, 14–20px radii, and glassmorphism (backdrop-filter: blur) on the sticky nav and key cards.
- Hero that lands: near-full-viewport, a rich GRADIENT MESH background (layered radial gradients in brand + accent at low opacity over the dark base, optional subtle grid/noise), an eyebrow label, an OVERSIZED headline (clamp up to ~64px, tight line-height) with ONE gradient-filled keyword, a punchy sub-headline, two CTAs (primary gradient button + ghost button), and a small trust line.
- Premium typography: load a modern Google Font (Inter / Sora / Space Grotesk; Poppins if "friendly" is requested). Big confident headings, uppercase letter-spaced eyebrows/labels, body line-height 1.6–1.7.
- Buttons: gradient fill, bold, pill or 12px radius, hover lift (translateY) + soft glow shadow, smooth transitions.
- Sections & cards: centered max-width container (~1100–1200px), generous whitespace, consistent vertical rhythm, feature cards with an inline-SVG/emoji icon + hover lift.
- Motion (subtle, never gaudy): scroll-reveal entrance animations (fade + slight translateY) via IntersectionObserver in app.js; hover micro-interactions; smooth-scroll for anchor links.
- Mobile-first and fully responsive, real focus states, a working mobile nav toggle, readable contrast.
- Every page shares the SAME nav, footer, and stylesheet so the product feels cohesive and finished.

Target the quality bar of a top Webflow/Framer template — clearly worth $3,500+.`;
}

// ─── Per-step prompts ────────────────────────────────────────────────────────
function stepPrompt(step, d, existing) {
  const hasExisting = existing && Object.keys(existing).length > 0;

  // Truncate existing files to stay within context window
  // Show a generous slice of each existing file so update steps preserve the
  // full design system instead of regenerating a plainer version from a stub.
  const existingCtx = hasExisting
    ? '\n\nEXISTING FILES (update these, do not start from scratch — keep the existing design language intact):\n' +
      Object.entries(existing)
        .map(([name, content]) => `\n=== ${name} ===\n${content.slice(0, 8000)}`)
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

  // Restaurant detection + menu content
  const isRestaurant = !!(d.industry_preset === 'restaurant' ||
    (d.business_type || '').toLowerCase().match(/restaurant|food service|café|cafe|empanada|pizza|sushi|diner|bistro|bar & grill|food truck/));
  // Universal content the customer provided (pasted text or transcribed uploads).
  // content_material is the new general field; menu_content is the legacy restaurant field.
  const providedContent = (d.content_material || d.menu_content || '').trim();
  const menuContent = providedContent;
  const menuCtx = (isRestaurant && menuContent)
    ? `\n\nMENU / PRODUCT LIST (use EXACT items, descriptions, prices — never invent or change items):\n${menuContent}`
    : '';
  // For ALL industries: feed the real content so the AI writes specifics, not filler.
  const contentCtx = (!isRestaurant && providedContent)
    ? `\n\nPROVIDED CONTENT (the business gave us this real material — use it verbatim where relevant; weave their actual products/services/copy/pricing into the pages; NEVER replace it with generic placeholder text):\n${providedContent}`
    : '';
  const bizPhone = d.phone || d.business_phone || '';

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
    1: `Generate a complete, PREMIUM multi-page web app for this business. This is a paid demo the client will judge on first impression — make it look like a top-tier agency built it.

BUSINESS:
- Company: ${d.company_name || 'Company'}
- Project: ${d.project_name || 'App'}
- Industry: ${d.business_type || 'Business'}
- Goal: ${d.business_goal || 'Build a great app'}
- Target Users: ${d.target_users || 'General users'}

Generate these files:
1. index.html — a rich, scroll-worthy landing page with these sections IN ORDER:
   - Sticky glassmorphic nav (backdrop blur): wordmark left, page links + a primary CTA button right, working mobile hamburger.
   - Hero: gradient-mesh background (brand + accent radial gradients at low opacity over the dark base), an eyebrow label, an OVERSIZED headline with ONE gradient-filled keyword, a punchy sub-headline, two CTAs (primary gradient + ghost), and a trust line of 3 quick stats/badges.
   - Social-proof stats band: 3–4 big numbers with labels.
   - Features: 3–4 cards in a responsive grid, each with an inline-SVG or emoji icon, title, and specific benefit copy, with a hover lift.
   - How it works: 3 numbered steps with a connecting line.
   - Highlight/benefits block: alternating text + a CSS-built visual panel (gradient/mockup, no external image).
   - Testimonials: 2–3 quote cards with names/roles believable for this business.
   - Final CTA band: bold gradient panel with headline + button.
   - Rich footer: brand blurb, link columns, contact line.
2. contact.html — same nav + footer, a polished contact form (name, email, phone, message) on a card, plus business contact details and hours.
3. terms.html — same nav + footer, well-formatted Terms of Service + Privacy Policy sections relevant to the business.
4. styles.css — ONE shared stylesheet implementing the full DESIGN LANGUAGE from your system instructions: :root design tokens, fluid clamp() type scale, gradient hero mesh, glass nav, gradient buttons with hover glow, card depth, .reveal scroll-animation classes, fully responsive + mobile nav styles.
5. app.js — shared interactivity: mobile nav toggle, smooth scroll for anchors, contact-form validation + fake success state, and SCROLL-REVEAL entrance animations via IntersectionObserver (elements with class "reveal" fade + slide in as they enter the viewport).

IMPORTANT: Every page must <link rel="stylesheet" href="styles.css"> and <script src="app.js" defer></script>. Nav and footer must be IDENTICAL across all pages. Make EVERY piece of copy specific to this business — no filler.${menuCtx}${contentCtx}${isRestaurant ? `\n\nIMPORTANT: This is a restaurant/food business. Add nav links to menu.html, order.html, takeout.html. Make the hero warm, appetising and food-forward — not tech-flavoured.` : ''}`,

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

    4: isRestaurant ? `Generate the restaurant pages for this food business.

RESTAURANT: ${d.company_name || 'Restaurant'}
PHONE: ${bizPhone || 'Not provided'}
${menuContent ? `\nFULL MENU (use EXACTLY — do not change names, descriptions, or prices):\n${menuContent}` : ''}

Generate these files:

1. menu.html — Full menu display
- Same sticky nav + footer as index.html. Link stylesheet + app.js.
- Hero: restaurant name, "— Empanadas Argentinas —" style subtitle, price per item
- Numbered menu cards in a responsive grid: bold number badge, item name (bold), description, price tag
- Badges: green "🌱 VEGAN" for vegan items, purple "✨ NEW" for new items
- Add-ons section: chimichurri / extras at bottom
- "Order Now →" CTA linking to order.html

2. order.html — Interactive digital order form
- Same nav + footer. Link stylesheet + app.js.
- Intro: "Order at your table or counter — we'll bring it right to you."
- Compact order table — one row per menu item: [#] [Name] [qty: <input type=number min=0 value=0 class=qty-input data-price=7 data-name="...">]
- Add-ons section: chimichurri radio: None / 4oz +$6 / 8oz +$12
- Table/seat field: <input> "Table # or Counter"
- Special requests: <textarea>
- Live order summary box (updates as qty changes): lists selected items + running $total
- "Place Order" button: shows a confirmation modal/div with the full order details
- Subtext: "Or text your order to ${bizPhone || '[phone]'}"
- app.js must handle qty change → recalculate total → update summary div

3. takeout.html — Frozen / pickup order form
- Same nav + footer. Link stylesheet + app.js.
- Headline: "Frozen Empanadas for Takeout"
- Subtitle: "Take our empanadas home — ready to bake in 18 minutes at 375°F"
- Same item list with qty inputs
- Customer name, phone number fields
- Pickup date input + preferred time (select: Morning / Afternoon / Evening)
- Special requests textarea
- Submit button → thank you confirmation message with order summary

Update index.html nav to ensure it has links to menu.html and order.html.
Update app.js with the qty-change event listeners and total calculator.

Return ALL of: menu.html, order.html, takeout.html, updated index.html (nav only if needed), updated app.js.${existingCtx}`

: /* default non-restaurant step 4 */
`Update the app to match these screens/pages.

SCREENS NEEDED: ${screensList.join(', ') || 'Not specified yet'}
USER FLOWS: ${d.user_flows || 'Not specified'}

${screensList.length > 0 ? `Create a separate HTML file for each screen listed (except Home = index.html which already exists).
Each file must: use the same nav, same footer, link styles.css and app.js.
Filename mapping: About → about.html, Contact → contact.html, Terms & Privacy → terms.html, Pricing → pricing.html, etc.
Nav links must point to correct filenames. Return ALL page files.` : 'No screens listed yet — return existing files unchanged.'}${existingCtx}`,

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

Return ALL HTML files (index.html${isRestaurant ? ', menu.html, order.html, takeout.html' : ', contact.html, terms.html, and any others'}).${contentCtx}${existingCtx}`,
  };

  return prompts[step] || `Step ${step} — current data: ${JSON.stringify(d)}${existingCtx}`;
}

// ─── Main generation function ────────────────────────────────────────────────
async function generateStep(stepNumber, formData, existingFiles = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured in Railway environment variables.');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Use the streaming API: with a high max_tokens the SDK refuses non-streaming
  // requests (they could exceed its 10-minute guard). stream().finalMessage()
  // assembles the same complete Message while keeping the larger token budget.
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5',
    // The rich "wow" prompt produces a large index.html + styles.css + app.js.
    // 16k truncated the deliver_files tool-call mid-JSON → "no files". Sonnet 4.5
    // supports up to 64k output; 32k gives ample headroom without truncation.
    // The long per-step runtime is safe because generation is driven through the
    // FIRE-AND-FORGET regenerate-all/regenerate endpoints (which return immediately
    // and run server-side), so Railway's HTTP gateway timeout never applies.
    max_tokens: 32000,
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

  const response = await stream.finalMessage();

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
