export class SourceError extends Error {
  constructor({ source, kind, status = null, message }) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.kind = kind;
    this.status = status;
  }
}

function statusError(source, status) {
  const kind = status === 429 ? 'rate_limit' : status >= 500 && status <= 599 ? 'server' : status >= 400 && status <= 499 ? 'client' : null;
  return kind ? new SourceError({ source, kind, status, message: `HTTP ${status}` }) : null;
}

function makeUrl(url, params) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) for (const item of value) parsed.searchParams.append(key, String(item));
    else if (value != null) parsed.searchParams.append(key, String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'false' ? String(value).toLowerCase() : String(value));
  }
  return parsed;
}

export async function requestJson(url, {
  source,
  params = {},
  headers = {},
  timeoutMs = 30_000,
  retries = 1,
  fetchImpl = globalThis.fetch,
  parseResponse = (response) => response.json(),
  acceptStatuses = [],
} = {}) {
  const target = makeUrl(url, params);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timeout;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Request timed out'));
        }, timeoutMs);
      });
      const response = await Promise.race([
        fetchImpl(target, { method: 'GET', headers, signal: controller.signal }),
        timeoutPromise,
      ]);
      clearTimeout(timeout);
      const responseError = statusError(source, response.status);
      if (responseError) {
        if (responseError.kind === 'server' && attempt < retries) { lastError = responseError; continue; }
        throw responseError;
      }
      if ((response.status < 200 || response.status >= 300) && !acceptStatuses.includes(response.status)) {
        throw new SourceError({ source, kind: 'client', status: response.status, message: `HTTP ${response.status}` });
      }
      try {
        return { data: await parseResponse(response), status: response.status, url: target };
      } catch {
        throw new SourceError({ source, kind: 'parse', status: response.status, message: 'Response was not valid JSON' });
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof SourceError) throw error;
      lastError = new SourceError({ source, kind: 'network', status: null, message: error?.message || 'Network request failed' });
      if (attempt >= retries) throw lastError;
    }
  }
  throw lastError || new SourceError({ source, kind: 'network', status: null, message: 'Network request failed' });
}

export class Source {
  constructor(name) { this.name = name; }
  async fetchJobs() { throw new Error('fetchJobs() must be implemented by a source'); }
  fetchDetails(job) { return job; }
  async fetchStats() { return {}; }
}
