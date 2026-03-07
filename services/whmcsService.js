/**
 * WHMCS Service for MCP Server
 * Handles all WHMCS API calls
 */

const axios = require('axios');
const { normalizePhone, phonesMatch, maskPhone } = require('../utils/phoneNormalizer');

const WHMCS_URL = process.env.WHMCS_URL;
const WHMCS_IDENTIFIER = process.env.WHMCS_IDENTIFIER || process.env.WHMCS_API_IDENTIFIER;
const WHMCS_SECRET = process.env.WHMCS_SECRET || process.env.WHMCS_API_SECRET;
const WHMCS_ACCESS_KEY = process.env.WHMCS_ACCESS_KEY;
const WHMCS_CACHE_TTL = Number(process.env.WHMCS_CACHE_TTL || 0);

function ensureConfig() {
  if (!WHMCS_URL || !WHMCS_IDENTIFIER || !WHMCS_SECRET) {
    throw new Error('Missing WHMCS configuration. Set WHMCS_URL, WHMCS_IDENTIFIER, WHMCS_SECRET');
  }
}

function serializeParams(params) {
  const out = {};
  const walk = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      out[prefix] = value;
    } else if (typeof value === 'object') {
      Object.entries(value).forEach(([k, v]) => {
        walk(`${prefix}[${k}]`, v);
      });
    } else {
      out[prefix] = value;
    }
  };
  Object.entries(params).forEach(([k, v]) => walk(k, v));
  return out;
}

async function callApi(action, params = {}) {
  ensureConfig();
  const url = /includes\/api\.php$/.test(WHMCS_URL)
    ? WHMCS_URL
    : `${WHMCS_URL.replace(/\/$/, '')}/includes/api.php`;
  const base = {
    action,
    responsetype: 'json',
    identifier: WHMCS_IDENTIFIER,
    secret: WHMCS_SECRET,
    ...(WHMCS_ACCESS_KEY ? { accesskey: WHMCS_ACCESS_KEY } : {}),
  };
  const flat = serializeParams(params);
  
  const payload = new URLSearchParams();
  Object.entries({ ...base, ...flat }).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(v => payload.append(key, v));
    } else {
      payload.append(key, value);
    }
  });

  try {
    const { data } = await axios.post(url, payload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (data && data.result === 'success') return data;
    const message = (data && (data.message || data.error)) || 'Unknown WHMCS error';
    const code = data && data.errorcode ? Number(data.errorcode) : undefined;
    const err = new Error(message);
    err.code = code;
    err.response = data;
    throw err;
  } catch (e) {
    if (e.response && e.response.data) {
      const data = e.response.data;
      const err = new Error(data.message || data.error || 'WHMCS request failed');
      err.code = data.errorcode ? Number(data.errorcode) : undefined;
      err.response = data;
      throw err;
    }
    throw e;
  }
}

const cache = new Map();

function stable(obj) {
  if (Array.isArray(obj)) return obj.map(stable);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = stable(obj[k]); return acc; }, {});
  }
  return obj;
}

function cacheKey(action, params) {
  return JSON.stringify({ action, params: stable(params) });
}

async function cached(action, params, fn) {
  if (!WHMCS_CACHE_TTL) return fn();
  const key = cacheKey(action, params);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) {
    console.log(`[CACHE HIT] ${action}`);
    return hit.val;
  }
  console.log(`[CACHE MISS] ${action}`);
  const val = await fn();
  cache.set(key, { val, exp: now + WHMCS_CACHE_TTL * 1000 });
  return val;
}

async function getInvoice(invoiceId) {
  const params = { invoiceid: invoiceId };
  return cached('GetInvoice', params, () => callApi('GetInvoice', params));
}

async function getInvoices(params = {}) {
  return cached('GetInvoices', params, () => callApi('GetInvoices', params));
}

async function getClientsProducts(clientId, params = {}) {
  const p = { clientid: clientId, ...params };
  return cached('GetClientsProducts', p, () => callApi('GetClientsProducts', p));
}

async function getClientsDomains(clientId, params = {}) {
  const p = { clientid: clientId, ...params };
  return cached('GetClientsDomains', p, () => callApi('GetClientsDomains', p));
}

async function getClientsDetails(params = {}) {
  return cached('GetClientsDetails', params, () => callApi('GetClientsDetails', params));
}

module.exports = {
  callApi,
  getInvoice,
  getInvoices,
  getClientsProducts,
  getClientsDomains,
  getClientsDetails
};
