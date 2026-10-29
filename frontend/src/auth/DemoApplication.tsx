import { useCallback } from 'react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import App from '../App';
import { AccessTokenContext } from './accessToken';

const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim();
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim();
const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim();
const authConfigured = Boolean(domain && clientId && audience);

function AuthenticationRequired() {
  const { error, isAuthenticated, isLoading, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
  const getToken = useCallback(async () => {
    const token = await getAccessTokenSilently({ authorizationParams: { audience } });
    if (!token) throw new Error('Auth0 did not return an access token. Sign in again.');
    return token;
  }, [getAccessTokenSilently]);

  if (isLoading) return <main className="demo-auth-state" role="status">Checking demo access…</main>;
  if (error) {
    return (
      <main className="demo-auth-state" role="alert">
        <h1>Unable to verify demo access</h1>
        <p>Check the Auth0 application configuration or sign in again.</p>
        <button className="primary-btn" onClick={() => loginWithRedirect()}>Try signing in</button>
      </main>
    );
  }
  if (!isAuthenticated) {
    return (
      <main className="demo-auth-state">
        <h1>Planora AI demo</h1>
        <p>Sign in with the authorized demo account to generate plans.</p>
        <button className="primary-btn" onClick={() => loginWithRedirect()}>Sign in</button>
      </main>
    );
  }

  return (
    <AccessTokenContext.Provider value={getToken}>
      <App />
      <button
        className="demo-logout"
        onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
      >
        Sign out
      </button>
    </AccessTokenContext.Provider>
  );
}

function AuthConfigurationRequired() {
  return (
    <main className="demo-auth-state" role="alert">
      <h1>Demo sign-in is not configured</h1>
      <p>Set the public Auth0 domain, client ID, and API audience before building the frontend.</p>
    </main>
  );
}

export function DemoApplication() {
  if (!authConfigured) {
    return import.meta.env.PROD ? <AuthConfigurationRequired /> : <App />;
  }
  return (
    <Auth0Provider
      domain={domain!}
      clientId={clientId!}
      cacheLocation="memory"
      useRefreshTokens
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
      }}
    >
      <AuthenticationRequired />
    </Auth0Provider>
  );
}
