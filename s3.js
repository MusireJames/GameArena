// Minimal S3-compatible client (AWS S3, Cloudflare R2, Backblaze B2, MinIO...) using AWS Signature V4. No dependencies.
// Config: BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY, BACKUP_S3_REGION (default "auto" works for Cloudflare R2; use e.g. us-east-1 for AWS)
const crypto = require('crypto');
const sha = d => crypto.createHash('sha256').update(d).digest('hex'), hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Returns the headers to send (including Authorization). Exported so it can be checked against AWS's published test vector. */
function sign({ method, url, region, accessKey, secretKey, body = '', headers = {}, now = new Date(), service = 's3' }) {
  const u = new URL(url), amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), date = amz.slice(0, 8), payload = sha(body);
  const h = { host: u.host, 'x-amz-content-sha256': payload, 'x-amz-date': amz };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const names = Object.keys(h).sort(), canonicalHeaders = names.map(k => k + ':' + String(h[k]).trim().replace(/\s+/g, ' ') + '\n').join('');
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1).map(([k, v]) => k + '=' + v).join('&');
  const path = u.pathname.split('/').map(s => enc(decodeURIComponent(s))).join('/');   // S3 encodes the path once
  const creq = [method, path, query, canonicalHeaders, names.join(';'), payload].join('\n'), scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(creq)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request'), sig = crypto.createHmac('sha256', key).update(sts).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${names.join(';')},Signature=${sig}`;
  return h;
}

const cfg = () => ({ endpoint: (process.env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''), bucket: process.env.BACKUP_S3_BUCKET || '', accessKey: process.env.BACKUP_S3_ACCESS_KEY || '', secretKey: process.env.BACKUP_S3_SECRET_KEY || '', region: process.env.BACKUP_S3_REGION || 'auto' });
const configured = () => { const c = cfg(); return !!(c.endpoint && c.bucket && c.accessKey && c.secretKey); };
const objUrl = (c, key) => `${c.endpoint}/${c.bucket}/${key.split('/').map(enc).join('/')}`;

async function put(key, body) {
  const c = cfg(), url = objUrl(c, key), h = sign({ method: 'PUT', url, region: c.region, accessKey: c.accessKey, secretKey: c.secretKey, body });
  delete h.host;   // fetch sets Host itself
  const r = await fetch(url, { method: 'PUT', headers: h, body, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`Backup upload failed (${r.status}) ${(await r.text().catch(() => '')).slice(0, 200)}`);
}
/** Returns a Buffer, or null if the object does not exist. Any other problem throws, so a network error is never mistaken for "no backup". */
async function get(key) {
  const c = cfg(), url = objUrl(c, key), h = sign({ method: 'GET', url, region: c.region, accessKey: c.accessKey, secretKey: c.secretKey });
  delete h.host;
  const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(300000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Backup download failed (${r.status}) ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
module.exports = { sign, put, get, configured };
