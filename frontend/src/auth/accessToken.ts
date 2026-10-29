import { createContext, useContext } from 'react';

export type TokenProvider = () => Promise<string>;

export const AccessTokenContext = createContext<TokenProvider | null>(null);

export const useDemoAccessToken = () => useContext(AccessTokenContext);
