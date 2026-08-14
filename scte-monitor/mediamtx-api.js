'use strict';

const http = require('http');

const API_HOST = process.env.MEDIAMTX_API_HOST || 'mediamtx';
const API_PORT = process.env.MEDIAMTX_API_PORT || 9997;
const API_USER = process.env.MEDIAMTX_API_USER || '';
const API_PASS = process.env.MEDIAMTX_API_PASS || '';

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};
    if (API_USER) {
      headers.Authorization = 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64');
    }
    const req = http.request(
      {
        host: API_HOST,
        port: API_PORT,
        path: apiPath,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : null);
          } else {
            reject(new Error(`MediaMTX API ${method} ${apiPath} -> ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Cria (ou substitui) um path dedicado ao cliente, com passphrase SRT própria.
// Idempotente: se o path já existir, replace sobrescreve com a config atual.
function addOrReplacePath(username, passphrase) {
  return request('POST', `/v3/config/paths/replace/${encodeURIComponent(username)}`, {
    source: 'publisher',
    srtPublishPassphrase: passphrase,
  });
}

function deletePath(username) {
  return request('DELETE', `/v3/config/paths/delete/${encodeURIComponent(username)}`).catch((err) => {
    // Path pode já não existir (nunca transmitiu) -- não é erro fatal ao remover cliente.
    if (!/-> 404/.test(err.message)) throw err;
  });
}

module.exports = { addOrReplacePath, deletePath };
