import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessControl } from '../src/middleware/accessControl.js';

test('OIDC access control verifies RS256 signatures, issuer, audience, and owner subject', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = {
    ...await exportJWK(publicKey),
    kid: 'planora-test-key',
    alg: 'RS256',
    use: 'sig',
  };
  const jwksServer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  jwksServer.listen(0, '127.0.0.1');
  await new Promise((resolve) => jwksServer.once('listening', resolve));

  const issuer = 'https://planora-demo.auth0.com/';
  const audience = 'https://planora-api';
  const guard = createAccessControl({
    env: {
      NODE_ENV: 'test',
      OIDC_ISSUER_URL: issuer,
      OIDC_AUDIENCE: audience,
      OIDC_JWKS_URL: `http://127.0.0.1:${jwksServer.address().port}/.well-known/jwks.json`,
      OIDC_ALLOWED_SUBJECT: 'auth0|demo-owner',
    },
  });
  const createRequest = (token) => ({
    get: () => `Bearer ${token}`,
  });
  const createResponse = () => {
    const result = { status: 200, body: undefined };
    const res = {
      status(status) { result.status = status; return res; },
      json(body) { result.body = body; return res; },
    };
    return { res, result };
  };
  const signToken = (subject, tokenIssuer = issuer, tokenAudience = audience) => new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'planora-test-key' })
    .setIssuedAt()
    .setIssuer(tokenIssuer)
    .setAudience(tokenAudience)
    .setSubject(subject)
    .setExpirationTime('2m')
    .sign(privateKey);

  try {
    const ownerToken = await signToken('auth0|demo-owner');
    const owner = createResponse();
    let passed = false;
    await guard(createRequest(ownerToken), owner.res, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(owner.result.status, 200);

    const otherUserToken = await signToken('auth0|other-user');
    const otherUser = createResponse();
    await guard(createRequest(otherUserToken), otherUser.res, () => assert.fail('non-owner token must not pass'));
    assert.equal(otherUser.result.status, 403);
    assert.equal(otherUser.result.body.code, 'DEMO_ACCESS_DENIED');

    const wrongAudienceToken = await signToken('auth0|demo-owner', issuer, 'https://other-api');
    const wrongAudience = createResponse();
    await guard(createRequest(wrongAudienceToken), wrongAudience.res, () => assert.fail('wrong audience must not pass'));
    assert.equal(wrongAudience.result.status, 401);

    const wrongIssuerToken = await signToken('auth0|demo-owner', 'https://other-tenant.auth0.com/');
    const wrongIssuer = createResponse();
    await guard(createRequest(wrongIssuerToken), wrongIssuer.res, () => assert.fail('wrong issuer must not pass'));
    assert.equal(wrongIssuer.result.status, 401);

    const { privateKey: unrelatedKey } = await generateKeyPair('RS256');
    const invalidSignatureToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'planora-test-key' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('auth0|demo-owner')
      .setExpirationTime('2m')
      .sign(unrelatedKey);
    const invalidSignature = createResponse();
    await guard(createRequest(invalidSignatureToken), invalidSignature.res, () => assert.fail('invalid signature must not pass'));
    assert.equal(invalidSignature.result.status, 401);
  } finally {
    await new Promise((resolve) => jwksServer.close(resolve));
  }
});
