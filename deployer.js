// ─── Arrowtrack Forge — Auto-Deploy Pipeline ──────────────────────────────────
// On submission: GitHub repo (private) → Netlify site deploy → poll until live
// → screenshot via Microlink → write URLs back to the submission row in DB.
// All functions are async; the caller fires them with fire-and-forget (no await).

const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');

// ─── Helper ───────────────────────────────────────────────────────────────────
function sha1(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

// Sanitise ref code into a valid GitHub/Netlify name: lowercase, hyphens only.
function toSlug(refCode) {
  return `forge-${refCode.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
}

// ─── GitHub: create private repo + initial commit ─────────────────────────────
async function createGitHubRepo(refCode, projectName, files) {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const org = process.env.GITHUB_ORG || 'arrowtrack-forge-builds';
  const repoName = toSlug(refCode);

  // Create the repo (private, no auto-init — we push a tree ourselves)
  const { data: repo } = await octokit.repos.createInOrg({
    org,
    name: repoName,
    description: `Arrowtrack Forge — ${projectName || refCode}`,
    private: true,
    auto_init: false,
  });

  // Create a blob for every generated file in parallel
  const treeItems = await Promise.all(
    Object.entries(files).map(async ([filename, content]) => {
      const { data: blob } = await octokit.git.createBlob({
        owner: org, repo: repoName,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      });
      return { path: filename, mode: '100644', type: 'blob', sha: blob.sha };
    })
  );

  // Single tree → single commit → main branch
  const { data: tree }   = await octokit.git.createTree({ owner: org, repo: repoName, tree: treeItems });
  const { data: commit } = await octokit.git.createCommit({
    owner: org, repo: repoName,
    message: `Initial app — Arrowtrack Forge (${refCode})`,
    tree: tree.sha,
    parents: [],
  });
  await octokit.git.createRef({ owner: org, repo: repoName, ref: 'refs/heads/main', sha: commit.sha });

  return repo.html_url;
}

// ─── Netlify: create site → create deploy with SHA1 manifest → upload files ──
async function netlifyCreateSiteAndDeploy(refCode, files) {
  const token = process.env.NETLIFY_TOKEN;
  const base  = 'https://api.netlify.com/api/v1';
  const auth  = { 'Authorization': `Bearer ${token}` };
  const siteName = toSlug(refCode);

  // 1. Create a new Netlify site (one per project = one URL per customer)
  const siteRes = await fetch(`${base}/sites`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: siteName }),
  });
  if (!siteRes.ok) {
    const msg = await siteRes.text();
    throw new Error(`Netlify site creation failed (${siteRes.status}): ${msg}`);
  }
  const site = await siteRes.json();

  // 2. Build SHA1 manifest — keys must start with /
  const manifest = {};
  for (const [filename, content] of Object.entries(files)) {
    const key = filename.startsWith('/') ? filename : `/${filename}`;
    manifest[key] = sha1(content);
  }

  // 3. Create deploy with manifest — Netlify returns which files it still needs
  const deployRes = await fetch(`${base}/sites/${site.id}/deploys`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: manifest }),
  });
  if (!deployRes.ok) {
    const msg = await deployRes.text();
    throw new Error(`Netlify deploy creation failed (${deployRes.status}): ${msg}`);
  }
  const deploy = await deployRes.json();

  // 4. Upload every file Netlify says it needs
  const hashToFile = {};
  for (const [filename, content] of Object.entries(files)) {
    const key = filename.startsWith('/') ? filename : `/${filename}`;
    hashToFile[manifest[key]] = { path: key, content };
  }

  await Promise.all(
    (deploy.required || []).map(async (hash) => {
      const file = hashToFile[hash];
      if (!file) return;
      // URL must NOT double up the leading slash — strip it before appending
      const urlPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
      const r = await fetch(`${base}/deploys/${deploy.id}/files/${urlPath}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: file.content,
      });
      if (!r.ok) console.warn(`[Deploy] File upload failed for ${file.path}: ${r.status}`);
    })
  );

  return {
    deployId: deploy.id,
    siteId: site.id,
    siteUrl: site.ssl_url || `https://${siteName}.netlify.app`,
  };
}

// ─── Poll until Netlify state === 'ready' (max 2 min @ 5s intervals) ─────────
async function pollDeploy(deployId, maxAttempts = 24, intervalMs = 5000) {
  const token = process.env.NETLIFY_TOKEN;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const res = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const d = await res.json();
      if (d.state === 'ready') return d.ssl_url || d.url || d.deploy_url;
      if (d.state === 'error') throw new Error(`Netlify deploy error: ${d.error_message || 'unknown'}`);
    } catch (err) {
      if (err.message.startsWith('Netlify deploy error:')) throw err;
      // transient network error — keep polling
    }
  }
  throw new Error('Netlify deploy timed out after 2 minutes');
}

// ─── Screenshot via Microlink (free, no API key, ~1-3s) ──────────────────────
async function takeScreenshot(url) {
  try {
    // NOTE: no `embed=` param — that makes Microlink stream raw PNG bytes, which
    // breaks res.json() below. Plain JSON gives us data.screenshot.url (a hosted PNG).
    const api = `https://api.microlink.io?url=${encodeURIComponent(url)}&screenshot=true&meta=false`;
    const res = await fetch(api);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.screenshot?.url || null;
  } catch {
    return null; // never crash the pipeline over a screenshot
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
// Returns { repoUrl, deployUrl, screenshotUrl }
// GitHub failure is non-fatal; only Netlify is required.
async function deployProject({ refCode, projectName, files }) {
  if (!process.env.NETLIFY_TOKEN) throw new Error('NETLIFY_TOKEN not configured');
  if (!files || Object.keys(files).length === 0) throw new Error('No generated files to deploy');

  console.log(`[Deploy ${refCode}] Starting pipeline — ${Object.keys(files).length} file(s)`);

  // GitHub + Netlify deploy kick-off in parallel (independent)
  const [repoUrl, { deployId, siteId, siteUrl }] = await Promise.all([
    createGitHubRepo(refCode, projectName, files)
      .then(url => { console.log(`[Deploy ${refCode}] GitHub repo: ${url}`); return url; })
      .catch(err => { console.warn(`[Deploy ${refCode}] GitHub skipped: ${err.message}`); return null; }),
    netlifyCreateSiteAndDeploy(refCode, files)
      .then(r => { console.log(`[Deploy ${refCode}] Netlify queued deploy ${r.deployId}`); return r; }),
  ]);

  // Wait for Netlify CDN to flip the site to "ready"
  const liveUrl = await pollDeploy(deployId);
  console.log(`[Deploy ${refCode}] Live at ${liveUrl}`);

  // Brief warm-up then screenshot
  await new Promise(r => setTimeout(r, 5000));
  const screenshotUrl = await takeScreenshot(liveUrl);
  if (screenshotUrl) console.log(`[Deploy ${refCode}] Screenshot captured`);

  return { repoUrl, deployUrl: liveUrl || siteUrl, screenshotUrl, siteId };
}

// ─── Redeploy to an existing Netlify site (no new site creation) ─────────────
async function redeployToNetlify(siteId, files) {
  const token = process.env.NETLIFY_TOKEN;
  const base  = 'https://api.netlify.com/api/v1';
  const auth  = { 'Authorization': `Bearer ${token}` };

  const manifest = {};
  for (const [filename, content] of Object.entries(files)) {
    const key = filename.startsWith('/') ? filename : `/${filename}`;
    manifest[key] = sha1(content);
  }
  const deployRes = await fetch(`${base}/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: manifest }),
  });
  if (!deployRes.ok) {
    const msg = await deployRes.text();
    throw new Error(`Netlify redeploy failed (${deployRes.status}): ${msg}`);
  }
  const deploy = await deployRes.json();
  const hashToFile = {};
  for (const [filename, content] of Object.entries(files)) {
    const key = filename.startsWith('/') ? filename : `/${filename}`;
    hashToFile[manifest[key]] = { path: key, content };
  }
  await Promise.all(
    (deploy.required || []).map(async (hash) => {
      const file = hashToFile[hash];
      if (!file) return;
      const urlPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
      const r = await fetch(`${base}/deploys/${deploy.id}/files/${urlPath}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: file.content,
      });
      if (!r.ok) console.warn(`[Redeploy] Upload failed for ${file.path}: ${r.status}`);
    })
  );
  return { deployId: deploy.id };
}

// ─── Push updated files to existing GitHub repo as a new commit ───────────────
async function pushToGitHub(repoUrl, files, message) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/\s]+)/);
  if (!match) throw new Error(`Invalid GitHub repo URL: ${repoUrl}`);
  const owner = match[1];
  const repo  = match[2].replace(/\.git$/, '');
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const { data: ref }       = await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
  const { data: headCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: ref.object.sha });

  const treeItems = await Promise.all(
    Object.entries(files).map(async ([filename, content]) => {
      const { data: blob } = await octokit.git.createBlob({
        owner, repo,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      });
      return { path: filename, mode: '100644', type: 'blob', sha: blob.sha };
    })
  );
  const { data: tree }   = await octokit.git.createTree({ owner, repo, base_tree: headCommit.tree.sha, tree: treeItems });
  const { data: commit } = await octokit.git.createCommit({
    owner, repo,
    message: message || `Review update — ${new Date().toISOString().split('T')[0]}`,
    tree: tree.sha, parents: [ref.object.sha],
  });
  await octokit.git.updateRef({ owner, repo, ref: 'heads/main', sha: commit.sha });
  return commit.sha;
}

module.exports = { deployProject, redeployToNetlify, pushToGitHub, pollDeploy, takeScreenshot };
