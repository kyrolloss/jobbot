import crypto from 'node:crypto';
export function apiKeyProvider(request, { config = {} } = {}) {
  const expected = config.API_KEY || '';
  const suppliedValue = request.headers?.['x-api-key'];
  if (!expected || expected.length < 24 || typeof suppliedValue !== 'string') return null;
  const supplied = Buffer.from(suppliedValue, 'utf8'), secret = Buffer.from(expected, 'utf8');
  if (supplied.length !== secret.length || !crypto.timingSafeEqual(supplied, secret)) return null;
  return { userId: 1, role: 'owner', planId: 'owner' };
}
export async function resolvePrincipal(request, deps = {}) {
  const providers = deps.providers || [apiKeyProvider];
  for (const provider of providers) { const principal = await provider(request, deps); if (principal) return principal; }
  return null;
}
