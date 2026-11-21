// Core Forge — entrypoint: bind an ephemeral port, register with the suite
// env, long-poll /done, exit 0 when the suite is finished.
// Without MAKEFUN_ENV_URL (local development) it just serves forever.
import { createApp } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();
const server = createApp(store, TOKEN);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<boolean> {
  let delay = 250;
  const deadline = Date.now() + 120000;
  while (true) {
    try {
      const res = await fetch(ENV_URL + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 200 || res.status === 201 || res.status === 204) return true;
      if (res.status === 409) {
        console.error('core-forge: register got 409 (another program registered first)');
        return false;
      }
      console.error('core-forge: register answered HTTP ' + res.status);
    } catch (e) {
      console.error('core-forge: register failed: ' + (e as Error).message);
    }
    if (Date.now() > deadline) return false;
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitDone(): Promise<void> {
  while (true) {
    try {
      const res = await fetch(ENV_URL + '/done', { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // The env answers at once with {done:false} while the suite runs;
      // a transient failure just means poll again.
    }
    await sleep(250);
  }
}

server.listen(0, '0.0.0.0', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log('core-forge listening on ' + port);
  if (!ENV_URL) return;
  void (async () => {
    const ok = await register(port);
    if (!ok) {
      console.error('core-forge: could not register; exiting');
      process.exit(1);
    }
    await waitDone();
    server.close(() => process.exit(0));
    // If connections linger, exit anyway after a short grace period.
    setTimeout(() => process.exit(0), 2000).unref();
  })();
});
