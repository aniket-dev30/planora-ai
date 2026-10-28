export const apiNotFound = (_req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found.', code: 'NOT_FOUND' });
};

/** Final error handler: always JSON, never a stack trace, path, or provider detail. */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (error, _req, res, _next) => {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'The request body is not valid JSON.', code: 'INVALID_JSON' });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'The request is too large.', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (error?.message?.startsWith?.('CORS:')) {
    return res.status(403).json({ success: false, error: 'This origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
  }
  console.error('Unhandled API error.', error instanceof Error ? error.name : 'UnknownError');
  return res.status(500).json({
    success: false,
    error: 'An unexpected error occurred. Please try again.',
    code: 'INTERNAL_ERROR',
  });
};
