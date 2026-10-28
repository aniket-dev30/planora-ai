/**
 * Conservative security headers for a JSON/SSE API (no HTML is served from here), so no
 * dependency is needed. The frontend is served separately and sets its own CSP.
 */
export const securityHeaders = (_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
  });
  res.removeHeader('X-Powered-By');
  next();
};

/** Parses FRONTEND_URL, which may be a comma-separated list of allowed origins. */
export const parseAllowedOrigins = (value) => {
  const origins = String(value || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return origins.length ? origins : ['http://localhost:5173'];
};
