// The browser suite's preview server port. Override with PLAYWRIGHT_PORT when
// 4173 is already taken by another local server.
const configuredPort = process.env.PLAYWRIGHT_PORT || '4173';

if (!/^\d+$/.test(configuredPort) || Number(configuredPort) < 1 || Number(configuredPort) > 65535) {
  throw new Error(`PLAYWRIGHT_PORT must be a TCP port number, got "${configuredPort}".`);
}

export const appPort = Number(configuredPort);
export const appOrigin = `http://127.0.0.1:${appPort}`;
