
import { validateEnquiry } from '../src/validate-enquiry.mjs';

const requests = new Map();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const {
    FORMS_ENABLED,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY,
    ENQUIRY_FROM,
    ENQUIRY_TO,
    SITE_URL,
    NTFY_TOPIC,
  } = process.env;

  if (
    FORMS_ENABLED !== 'true' ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !RESEND_API_KEY ||
    !ENQUIRY_FROM ||
    !ENQUIRY_TO ||
    !SITE_URL
  ) {
    return res.status(503).json({
      error: 'Online enquiries are temporarily unavailable.',
    });
  }

  let origin;

  try {
    origin = new URL(SITE_URL).origin;
  } catch {
    return res.status(503).json({
      error: 'Enquiries are temporarily unavailable.',
    });
  }

  if (req.headers.origin !== origin) {
    return res.status(403).json({
      error: 'Request origin not allowed.',
    });
  }

  if (!req.headers['content-type']?.includes('application/json')) {
    return res.status(415).json({ error: 'JSON required.' });
  }

  if (Number(req.headers['content-length'] || 0) > 12000) {
    return res.status(413).json({ error: 'Request too large.' });
  }

  let data;

  try {
    data = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;

    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      JSON.stringify(data).length > 12000
    ) {
      return res.status(413).json({
        error: 'Invalid or oversized request.',
      });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const error = validateEnquiry(data);

  if (error) {
    return res.status(400).json({ error });
  }

  // Best-effort per-instance request throttling.
  const now = Date.now();

  for (const [key, value] of requests) {
    if (value.until < now) requests.delete(key);
  }

  const ip = String(
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    'unknown'
  ).split(',')[0];

  const record = requests.get(ip) || {
    count: 0,
    until: now + 600000,
  };

  if (record.count >= 5) {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
    });
  }

  record.count++;
  requests.set(ip, record);

  const supabaseUrl = SUPABASE_URL.replace(/\/+$/, '');

  const enquiry = {
    name: data.name,
    organization: data.organization,
    designation: data.designation || '',
    email: data.email,
    phone: data.phone || '',
    industry: data.industry,
    service: data.service,
    topic: data.topic || '',
    date: data.date || '',
    time: data.time || '',
    mode: data.mode || '',
    message: data.message,
  };

  // Save enquiry first.
  try {
    const dbResponse = await fetch(
      `${supabaseUrl}/rest/v1/mdk_enquiries`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(enquiry),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!dbResponse.ok) {
      console.error(
        'MDK Supabase insert failed:',
        dbResponse.status,
        await dbResponse.text()
      );

      return res.status(502).json({
        error: 'Your enquiry could not be saved. Please try again later.',
      });
    }
  } catch (err) {
    console.error('MDK database connection failed:', err);

    return res.status(502).json({
      error: 'Your enquiry could not be saved. Please try again later.',
    });
  }

  // Prepare notification details.
  const labels = {
    name: 'Name',
    organization: 'Organization',
    designation: 'Designation',
    email: 'Email',
    phone: 'Phone',
    industry: 'Industry',
    service: 'Service',
    topic: 'Topic',
    date: 'Preferred date',
    time: 'Preferred time (IST)',
    mode: 'Mode',
    message: 'Requirement',
  };

  const emailText = Object.entries(labels)
    .map(([key, label]) =>
      `${label}: ${data[key] || 'Not provided'}`
    )
    .join('\n\n');

  // Send email notification.
  let emailDelivered = false;

  try {
    const emailResponse = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: ENQUIRY_FROM,
          to: [ENQUIRY_TO],
          reply_to: data.email,
          subject: 'New MDK consultation enquiry',
          text: emailText,
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    emailDelivered = emailResponse.ok;

    if (!emailDelivered) {
      console.error(
        'MDK email notification failed:',
        emailResponse.status,
        await emailResponse.text()
      );
    }
  } catch (err) {
    console.error('MDK email request failed:', err);
  }

  // Send direct Android push notification using ntfy.
  let pushDelivered = false;

  if (NTFY_TOPIC) {
    try {
      const pushResponse = await fetch(
        `https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            Title: 'New MDK Enquiry',
            Priority: 'high',
            Tags: 'bell',
          },
          body:
            `New consultation enquiry!\n\n` +
            `Name: ${data.name}\n` +
            `Organization: ${data.organization}\n` +
            `Service: ${data.service}\n\n` +
            `Check the MDK admin inbox for full details.`,
          signal: AbortSignal.timeout(10000),
        }
      );

      pushDelivered = pushResponse.ok;

      if (!pushDelivered) {
        console.error(
          'MDK ntfy notification failed:',
          pushResponse.status,
          await pushResponse.text()
        );
      }
    } catch (err) {
      console.error('MDK ntfy request failed:', err);
    }
  }

  return res.status(200).json({
    ok: true,
    saved: true,
    emailDelivered,
    pushDelivered,
    smsDelivered: false,
  });
}
