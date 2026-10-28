import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env before anything reads process.env (the app module reads configuration at creation time).
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env'), quiet: true });

const { createApp } = await import('./app.js');

const PORT = Number(process.env.PORT) || 5000;
const app = createApp();
const server = app.listen(PORT, () => {
  console.log(`Planora API running at http://localhost:${PORT}`);
});

// Long-lived SSE responses must not be cut by Node's default request/keep-alive timeouts.
server.requestTimeout = 0;
server.headersTimeout = 65_000;

const shutdown = (signal) => {
  console.log(`${signal} received; shutting down.`);
  server.close(() => process.exit(0));
  // Do not wait indefinitely on open streams.
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection.', reason instanceof Error ? reason.name : 'UnknownReason');
});
