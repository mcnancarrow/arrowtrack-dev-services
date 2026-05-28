const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Contact form submission — sends to owner email via Resend
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
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Arrowtrack Services <hello@delib.io>',
        to: OWNER_EMAIL,
        subject: `New Project Inquiry — ${firstName} ${lastName} (${businessType || 'Unknown'})`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0d0d0d;color:#fff;padding:32px;border-radius:12px;">
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
            <p style="color:#444;font-size:12px;margin-top:24px;">Sent from Arrowtrack Solutions contact form</p>
          </div>
        `
      })
    });

    if (response.ok) {
      res.json({ success: true });
    } else {
      const err = await response.text();
      console.error('Resend error:', err);
      res.status(500).json({ error: 'Failed to send email' });
    }
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Arrowtrack Dev Services running on port ${PORT}`));
