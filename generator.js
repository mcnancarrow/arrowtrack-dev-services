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
        .map(([name, content]) => `\n=== ${name} ===\n${content.slice(0, 4000)}`)
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

  const screens = Array.isArray(d.screens)
    ? d.screens.filter(Boolean).join(', ')
    : d.screens || '';

  const prompts = {
    1: `Generate a complete, professional web app for this business.

BUSINESS:
- Company: ${d.company_name || 'Company'}
- Project: ${d.project_name || 'App'}
- Industry: ${d.business_type || 'Business'}
- Goal: ${d.business_goal || 'Build a great app'}
- Target Users: ${d.target_users || 'General users'}

Generate 3 complete files:
1. index.html — Full landing page: hero (bold headline + CTA button), 3-feature section, how-it-works (3 steps), testimonial or stats section, final CTA, footer with nav links
2. styles.css — Complete stylesheet: dark theme, Inter font via Google Fonts, responsive grid, smooth animations, mobile-first
3. app.js — Interactivity: mobile nav toggle, smooth scroll, any relevant UI

Make EVERY piece of content specific to this business. Not generic.`,

    2: `Update the app for these platform and deliverable requirements.

PLATFORMS: ${platforms}
DELIVERABLES: ${deliverables || 'None selected yet'}

Changes needed:
${d.platform_ios || d.platform_android ? '- Add "Available on iOS & Android" badge/section and app store CTA buttons\n' : ''}${d.del_payments ? '- Add a pricing section with 3 tiers relevant to the business\n' : ''}${d.del_admin ? '- Add an "Admin Dashboard" feature card/section\n' : ''}${d.del_ai ? '- Add an AI-powered features section\n' : ''}${d.del_maps ? '- Add a location/map section\n' : ''}
Return only the files that need updating.${existingCtx}`,

    3: `Update the app to showcase these features.

FEATURES: ${features || 'None selected yet'}

${features ? `Add UI elements for: ${features}
- For Auth: add a sign-up/login modal or section
- For Payments/Stripe: add payment or pricing UI
- For AI: add an AI feature showcase section
- For Roles: mention user types in the hero or features
Return only files that change.` : 'No features selected yet — return existing files unchanged.'}${existingCtx}`,

    4: `Update the app to match these screens/pages.

SCREENS NEEDED: ${screens || 'Not specified yet'}
USER FLOWS: ${d.user_flows || 'Not specified'}

${screens ? `Add navigation links and placeholder sections for each screen listed.
Keep index.html as the main landing page but add nav links to these sections/pages.` : 'No screens listed yet — return existing files unchanged.'}${existingCtx}`,

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

Update index.html:
- Replace any placeholder contact details with the real ones above
- Update footer with real email, phone, and website
- Make all CTAs link to the real email (mailto:) if no website yet
- Ensure the app feels finished, ready to show to this client

Return only index.html.${existingCtx}`,
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
    max_tokens: 8192,
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
