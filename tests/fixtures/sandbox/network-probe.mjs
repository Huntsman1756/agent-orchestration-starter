import { request } from 'node:http';
import { request as tlsRequest } from 'node:https';

function call(url, options = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const send = parsed.protocol === 'https:' ? tlsRequest : request;
    const operation = send(
      parsed,
      { method: options.method ?? 'POST', headers: options.headers, timeout: 1_500, rejectUnauthorized: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ ok: true, status: response.statusCode, body }));
      },
    );
    operation.once('timeout', () => operation.destroy(new Error('timeout')));
    operation.once('error', (error) => resolve({ ok: false, error: error.code ?? error.message }));
    operation.end(options.body ?? JSON.stringify({ model: 'synthetic' }));
  });
}

const gateway = process.argv[2];
const blockedOrigin = process.argv[3];
const directIp = process.argv[4];
const holdMs = Number(process.argv[5] ?? 0);
const result = {
  allowlisted: await call(`${gateway}/chat/completions`, {
    headers: { authorization: 'Bearer broker-gateway', 'content-type': 'application/json' },
  }),
  non_allowlisted: await call(`${gateway}/chat/completions`, {
    headers: { authorization: 'Bearer broker-gateway', 'x-target-origin': blockedOrigin, 'content-type': 'application/json' },
  }),
  direct_ip: await call(`${directIp}/v1/chat/completions`),
};
if (Number.isFinite(holdMs) && holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
process.stdout.write(`${JSON.stringify(result)}\n`);
