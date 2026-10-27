const API = 'https://api.cloudflare.com/client/v4';

export class Cloudflare {
  constructor(token, fetcher = fetch) {
    if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN in GitHub Secrets.');
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(method, path, body, { optional = false, raw = false } = {}) {
    let response;
    try {
      response = await this.fetcher(API + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) })
      });
    } catch {
      // Never log request bodies, tokens, activation codes, or provider error echoes.
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} did not complete. Re-run to resume; no destructive retry was made.`);
    }
    if (optional && response.status === 404) return null;
    if (raw) {
      if (!response.ok) throw new Error(`Cloudflare ${method} failed (HTTP ${response.status}).`);
      return response.text();
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.success === false) {
      const codes = (data?.errors || []).map(error => error.code).join(',');
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}; codes ${codes || 'unknown'}).`);
    }
    return data;
  }

  async get(path, optional = false) {
    return (await this.request('GET', path, undefined, { optional }))?.result ?? null;
  }

  async list(path, params = {}) {
    const result = [];
    let page = 1;
    let cursor;
    for (let count = 0; count < 100; count++) {
      const query = new URLSearchParams({ per_page: '100', ...params });
      if (cursor) query.set('cursor', cursor);
      else query.set('page', String(page));
      const data = await this.request('GET', `${path}?${query}`);
      if (!Array.isArray(data.result)) throw new Error(`Unexpected list response: ${path}`);
      result.push(...data.result);
      const info = data.result_info || {};
      if (info.cursor) {
        if (info.cursor === cursor) throw new Error('Cloudflare returned a repeated pagination cursor.');
        cursor = info.cursor;
      } else if (page < (info.total_pages || 1)) page++;
      else return result;
    }
    throw new Error('Cloudflare pagination limit reached; refusing a partial inventory.');
  }

  async putValue(accountId, namespaceId, key, value) {
    await this.request('PUT', `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      JSON.stringify(value), { raw: true });
  }

  async value(accountId, namespaceId, key) {
    const text = await this.request('GET', `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      undefined, { optional: true, raw: true });
    return text === null ? null : JSON.parse(text);
  }

  async query(accountId, databaseId, sql, params = []) {
    const values = params.map(value => {
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw new Error('Invalid D1 query parameter.');
      return String(value);
    });
    const result = (await this.request('POST', `/accounts/${accountId}/d1/database/${databaseId}/query`, { sql, params: values })).result;
    if (!Array.isArray(result) || result.some(item => item.success === false)) throw new Error('D1 query failed.');
    return result;
  }
}
