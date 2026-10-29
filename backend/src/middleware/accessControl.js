import { createRemoteJWKSet, jwtVerify } from 'jose';

const readOidcConfig = (env) => ({
  issuer: env.OIDC_ISSUER_URL?.trim(),
  audience: env.OIDC_AUDIENCE?.trim(),
  jwksUrl: env.OIDC_JWKS_URL?.trim(),
  allowedSubject: env.OIDC_ALLOWED_SUBJECT?.trim(),
});

export const createAccessControl = ({ env = process.env, verifyAccessToken } = {}) => {
  const config = readOidcConfig(env);
  const configuredValues = Object.values(config);
  const hasAnyConfiguration = configuredValues.some(Boolean);
  const isComplete = configuredValues.every(Boolean);

  if (!hasAnyConfiguration && ['development', 'test'].includes(env.NODE_ENV)) {
    return (_req, _res, next) => next();
  }
  if (!isComplete) {
    throw new Error('Production API access requires OIDC issuer, audience, JWKS URL, and allowed subject configuration.');
  }

  let verify = verifyAccessToken;
  if (!verify) {
    const issuerUrl = new URL(config.issuer);
    const jwksUrl = new URL(config.jwksUrl);
    const allowInsecureLocalUrls = ['development', 'test'].includes(env.NODE_ENV);
    if (
      !['https:', 'http:'].includes(issuerUrl.protocol)
      || !['https:', 'http:'].includes(jwksUrl.protocol)
      || (!allowInsecureLocalUrls && (issuerUrl.protocol !== 'https:' || jwksUrl.protocol !== 'https:'))
    ) {
      throw new Error('OIDC issuer and JWKS URLs must use HTTPS outside development and tests.');
    }
    const jwks = createRemoteJWKSet(jwksUrl);
    verify = async (token) => {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
      });
      return payload;
    };
  }

  return async (req, res, next) => {
    const authorization = req.get('authorization') ?? '';
    const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/);
    if (!match) {
      return res.status(401).json({
        success: false,
        error: 'Sign in with the authorized demo account to use plan generation.',
        code: 'AUTHENTICATION_REQUIRED',
      });
    }

    let claims;
    try {
      claims = await verify(match[1]);
    } catch {
      return res.status(401).json({
        success: false,
        error: 'The access token is invalid or expired. Sign in again.',
        code: 'ACCESS_TOKEN_INVALID',
      });
    }
    if (!claims || claims.sub !== config.allowedSubject) {
      return res.status(403).json({
        success: false,
        error: 'This account is not authorized to use the demo.',
        code: 'DEMO_ACCESS_DENIED',
      });
    }

    req.auth = { subject: claims.sub };
    return next();
  };
};
