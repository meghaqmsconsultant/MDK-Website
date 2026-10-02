
const noStore = (res) => {
  res.setHeader('Cache-Control', 'no-store');
};

const sendError = (res, status, message) =>
  res.status(status).json({ error: message });

function getConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !serviceKey || !anonKey) {
    throw new Error('Supabase server configuration is incomplete.');
  }

  return { url, serviceKey, anonKey };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return JSON.parse(req.body);
  }

  return {};
}

async function supabaseAuth(url, anonKey, endpoint, options = {}) {
  const response = await fetch(`${url}/auth/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Invalid response from Supabase Auth.');
  }

  if (!response.ok) {
    throw new Error(
      data.msg || data.message || data.error_description ||
      data.error || 'Authentication failed.'
    );
  }

  return data;
}

async function getAdminUser(config, token) {
  if (!token) {
    throw new Error('Please sign in again.');
  }

  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error('Your session has expired. Please sign in again.');
  }

  const user = await response.json();

  if (!user?.id) {
    throw new Error('Unable to verify administrator.');
  }

  const params = new URLSearchParams({
    select: 'user_id',
    user_id: `eq.${user.id}`,
    limit: '1',
  });

  const membership = await fetch(
    `${config.url}/rest/v1/mdk_admins?${params}`,
    {
      headers: {
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
      },
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!membership.ok) {
    throw new Error('Unable to verify administrator access.');
  }

  const rows = await membership.json();

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('You are not authorized to access the MDK inbox.');
  }

  return user;
}

function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function csvCell(value) {
  const text = String(value ?? '');

  // Prevent spreadsheet formula injection.
  const safe = /^[\s]*[=+\-@]/.test(text)
    ? `'${text}`
    : text;

  return `"${safe.replace(/"/g, '""')}"`;
}

async function getEnquiries(config) {
  const params = new URLSearchParams({
    select: '*',
    order: 'created_at.desc',
    limit: '500',
  });

  const response = await fetch(
    `${config.url}/rest/v1/mdk_enquiries?${params}`,
    {
      headers: {
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
      },
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!response.ok) {
    throw new Error('Unable to retrieve enquiries from Supabase.');
  }

  return response.json();
}

export default async function handler(req, res) {
  noStore(res);

  let config;

  try {
    config = getConfig();
  } catch (error) {
    return sendError(res, 503, error.message);
  }

  const path = Array.isArray(req.query?.path)
    ? req.query.path.join('/')
    : String(req.query?.path || '');

  try {
    // ADMIN LOGIN
    if (path === 'login' && req.method === 'POST') {
      const body = await readBody(req);

      if (!body.email || !body.password) {
        return sendError(res, 400, 'Email and password are required.');
      }

      let auth;

      try {
        auth = await supabaseAuth(
          config.url,
          config.anonKey,
          'token?grant_type=password',
          {
            method: 'POST',
            body: JSON.stringify({
              email: body.email,
              password: body.password,
            }),
          }
        );
      } catch {
        return sendError(res, 401, 'Invalid email or password.');
      }

      try {
        await getAdminUser(config, auth.access_token);
      } catch (error) {
        // Revoke the newly issued session if the user is not an admin.
        await supabaseAuth(
          config.url,
          config.anonKey,
          'logout',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${auth.access_token}`,
            },
          }
        ).catch(() => {});

        return sendError(res, 403, error.message);
      }

      return res.status(200).json({
        access_token: auth.access_token,
        refresh_token: auth.refresh_token,
        token_type: auth.token_type,
        expires_in: auth.expires_in,
      });
    }

    // REFRESH ADMIN SESSION
    if (path === 'refresh' && req.method === 'POST') {
      const body = await readBody(req);

      if (!body.refresh_token) {
        return sendError(res, 400, 'Refresh token is required.');
      }

      let auth;

      try {
        auth = await supabaseAuth(
          config.url,
          config.anonKey,
          'token?grant_type=refresh_token',
          {
            method: 'POST',
            body: JSON.stringify({
              refresh_token: body.refresh_token,
            }),
          }
        );
      } catch {
        return sendError(res, 401, 'Session expired. Please sign in again.');
      }

      try {
        await getAdminUser(config, auth.access_token);
      } catch (error) {
        await supabaseAuth(
          config.url,
          config.anonKey,
          'logout',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${auth.access_token}`,
            },
          }
        ).catch(() => {});

        return sendError(res, 403, error.message);
      }

      return res.status(200).json({
        access_token: auth.access_token,
        refresh_token: auth.refresh_token,
        token_type: auth.token_type,
        expires_in: auth.expires_in,
      });
    }

    // ALL REMAINING ROUTES REQUIRE AN AUTHORIZED ADMIN
    if (!['enquiries', 'export.csv', 'logout'].includes(path)) {
      return sendError(res, 404, 'Admin endpoint not found.');
    }

    const token = getToken(req);

    try {
      await getAdminUser(config, token);
    } catch (error) {
      return sendError(res, 401, error.message);
    }

    // LIST ENQUIRIES
    if (path === 'enquiries' && req.method === 'GET') {
      const enquiries = await getEnquiries(config);
      return res.status(200).json(enquiries);
    }

    // EXPORT CSV
    if (path === 'export.csv' && req.method === 'GET') {
      const enquiries = await getEnquiries(config);

      const columns = [
        'id',
        'created_at',
        'name',
        'organization',
        'designation',
        'email',
        'phone',
        'industry',
        'service',
        'topic',
        'date',
        'time',
        'mode',
        'message',
        'status',
      ];

      const rows = [
        columns.map(csvCell).join(','),
        ...enquiries.map((entry) =>
          columns.map((column) => csvCell(entry[column])).join(',')
        ),
      ];

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="mdk-enquiries.csv"'
      );

      return res.status(200).send('\uFEFF' + rows.join('\r\n'));
    }

    // LOGOUT
    if (path === 'logout' && req.method === 'POST') {
      await supabaseAuth(
        config.url,
        config.anonKey,
        'logout',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return res.status(200).json({ ok: true });
    }

    return sendError(res, 405, 'Method not allowed.');
  } catch (error) {
    console.error('MDK admin API error:', error);
    return sendError(res, 500, 'Unable to complete the admin request.');
  }
}
