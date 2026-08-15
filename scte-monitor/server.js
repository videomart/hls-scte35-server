'use strict';

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const clients = require('./clients');
const mediamtxApi = require('./mediamtx-api');

const HTTP_PORT = process.env.HTTP_PORT || 8095;
// Host:porta do MediaMTX (rede interna Docker) para SRT local (relay de
// leitura, usado pelos processos tsp por-cliente) e para o proxy HLS.
const MEDIAMTX_HOST = process.env.MEDIAMTX_HOST || 'mediamtx';
const MEDIAMTX_SRT_PORT = process.env.MEDIAMTX_SRT_PORT || 8890;
const MEDIAMTX_HLS_PORT = process.env.MEDIAMTX_HLS_PORT || 8888;
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'logs', 'scte-events.log');
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(__dirname, 'logs', 'history');
const MAX_HISTORY = 100;
// Evita que scte-events.log cresça sem limite: quando passar disso, mantém só
// a metade mais recente (checado a cada gravação, custo desprezível).
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB

// Credenciais do painel administrativo (cadastro de clientes) -- distintas
// da antiga auth da página de visualização, que agora é pública.
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });

// --- Estado por cliente: histórico de cues, clientes SSE conectados, e o
// processo tsp de detecção ativo (um por cliente com stream ao vivo). ---
const perClientState = new Map(); // username -> { history, sseClients, tspProc, udpSocket, udpPort }

function getState(username) {
  let state = perClientState.get(username);
  if (!state) {
    state = { history: [], sseClients: new Set(), tspProc: null, udpSocket: null, udpPort: null };
    perClientState.set(username, state);
    loadHistory(username, state);
  }
  return state;
}

function historyFile(username) {
  return path.join(HISTORY_DIR, `${username}.json`);
}

function loadHistory(username, state) {
  try {
    state.history = JSON.parse(fs.readFileSync(historyFile(username), 'utf8'));
  } catch (e) {
    state.history = [];
  }
}

function persistHistory(username, state) {
  fs.writeFile(historyFile(username), JSON.stringify(state.history), (err) => {
    if (err) console.error(`[${username}] Falha ao gravar histórico:`, err.message);
  });
}

let logSizeCheckCounter = 0;

function rotateLogIfNeeded() {
  fs.stat(LOG_FILE, (err, stats) => {
    if (err || stats.size < MAX_LOG_BYTES) return;
    fs.readFile(LOG_FILE, 'utf8', (readErr, content) => {
      if (readErr) return;
      const lines = content.split('\n').filter(Boolean);
      const kept = lines.slice(-Math.floor(lines.length / 2));
      fs.writeFile(LOG_FILE, kept.join('\n') + '\n', (writeErr) => {
        if (writeErr) console.error('Falha ao rotacionar log:', writeErr.message);
      });
    });
  });
}

function appendLog(line) {
  fs.appendFile(LOG_FILE, line + '\n', (err) => {
    if (err) console.error('Falha ao gravar log:', err.message);
  });
  logSizeCheckCounter++;
  if (logSizeCheckCounter % 20 === 0) rotateLogIfNeeded();
}

function broadcast(state, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.sseClients) {
    res.write(payload);
  }
}

function handleSpliceEvent(username, evt) {
  const state = getState(username);
  const record = {
    receivedAt: new Date().toISOString(),
    eventId: evt['event-id'],
    type: evt['event-type'], // "in" ou "out"
    progress: evt['progress'],
    splicePid: evt['splice-pid'],
  };
  state.history.unshift(record);
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  persistHistory(username, state);

  const logLine = `[${record.receivedAt}] [${username}] CUE-${record.type.toUpperCase()} event-id=${record.eventId} pid=${record.splicePid} progress=${record.progress}`;
  console.log(logLine);
  appendLog(logLine);
  broadcast(state, record);
}

// --- Processo tsp por cliente: lê o SRT de volta do MediaMTX (não do
// publisher direto -- o MediaMTX já é quem recebe o ingest multi-cliente) e
// detecta splice events via splicemonitor. Iniciado sob demanda quando o
// MediaMTX sinaliza runOnAvailable, encerrado em runOnUnavailable. ---
let nextUdpPort = 9900;

function startCueDetector(username) {
  const state = getState(username);
  if (state.tspProc) return; // já rodando

  const client = clients.get(username);
  if (!client) {
    console.warn(`[${username}] startCueDetector: cliente não encontrado, abortando`);
    return;
  }

  const udpPort = nextUdpPort++;
  state.udpPort = udpPort;

  const udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', (msg) => {
    let parsed;
    try {
      parsed = JSON.parse(msg.toString('utf8'));
    } catch (e) {
      return; // datagrama incompleto/fragmentado, ignora
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (item && item['#name'] === 'event') handleSpliceEvent(username, item);
    }
  });
  udpSocket.on('error', (err) => console.error(`[${username}] Erro no socket UDP:`, err.message));
  udpSocket.bind(udpPort, '127.0.0.1');
  state.udpSocket = udpSocket;

  // O stream publicado no MediaMTX é criptografado com a passphrase do
  // cliente (SRT encryption) -- qualquer leitor, inclusive este detector de
  // cues, precisa da mesma passphrase para decriptar, não só o publisher.
  const readPassphraseArgs = client.passphrase ? ['--passphrase', client.passphrase] : [];
  const args = [
    '-I', 'srt', '--caller', `${MEDIAMTX_HOST}:${MEDIAMTX_SRT_PORT}`, '--streamid', `read:${username}`, ...readPassphraseArgs,
    '-P', 'splicemonitor', '--json-udp', `127.0.0.1:${udpPort}`,
    '-O', 'drop',
  ];
  console.log(`[${username}] Iniciando detector de cues:`, args.join(' '));
  const proc = spawn('tsp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  state.tspProc = proc;

  proc.stdout.on('data', (d) => process.stdout.write(`[tsp:${username}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[tsp:${username}] ${d}`));
  proc.on('exit', (code, signal) => {
    console.log(`[${username}] Detector de cues encerrou (code=${code}, signal=${signal})`);
    state.tspProc = null;
    if (state.udpSocket) {
      state.udpSocket.close();
      state.udpSocket = null;
    }
  });
}

function stopCueDetector(username) {
  const state = perClientState.get(username);
  if (!state || !state.tspProc) return;
  state.tspProc.kill('SIGTERM');
}

// --- HTTP: pagina + SSE + historico + admin + endpoints internos ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkBasicAuth(req, res, user, pass, realm) {
  if (!user || !pass) return true; // auth desligada (dev local sem credenciais configuradas)

  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  if (header && timingSafeEqual(header, expected)) return true;

  res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${realm}"` });
  res.end('Autenticação necessária');
  return false;
}

const HLS_PROXY_PREFIX = '/hls-live/';

function proxyHls(req, res) {
  const targetPath = req.url.slice(HLS_PROXY_PREFIX.length - 1); // mantém a barra inicial
  const proxyReq = http.request(
    {
      host: MEDIAMTX_HOST,
      port: MEDIAMTX_HLS_PORT,
      path: targetPath,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };
      // O MediaMTX responde redirects (ex: cookieCheck) com Location absoluto
      // sem o prefixo do proxy -- sem isso o browser tenta acessar a origem
      // errada (fora de /hls-live/) e recebe 404.
      if (headers.location && headers.location.startsWith('/')) {
        headers.location = HLS_PROXY_PREFIX.slice(0, -1) + headers.location;
      }
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Erro ao contactar o servidor de vídeo: ' + err.message);
  });
  req.pipe(proxyReq);
}

function serveFile(baseDir, urlPath, req, res) {
  const filePath = path.join(baseDir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// --- Endpoints internos, chamados pelos hooks runOnAvailable/runOnUnavailable
// do MediaMTX (rede interna Docker, não exposto externamente) ---
async function handleInternalRoutes(req, res, urlPath) {
  if (urlPath === '/internal/stream-available' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (body.path && clients.get(body.path)) startCueDetector(body.path);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (urlPath === '/internal/stream-unavailable' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (body.path) stopCueDetector(body.path);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

// --- Endpoints do painel admin (cadastro de clientes), protegidos por
// Basic Auth com credenciais de administrador. ---
async function handleAdminApi(req, res, urlPath) {
  if (!checkBasicAuth(req, res, ADMIN_USER, ADMIN_PASS, 'scte-monitor-admin')) return true;

  if (urlPath === '/admin/api/clients' && req.method === 'GET') {
    sendJson(res, 200, clients.list());
    return true;
  }

  if (urlPath === '/admin/api/clients' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const record = clients.create(body.username, body.passphrase);
      try {
        await mediamtxApi.addOrReplacePath(record.username, record.passphrase);
      } catch (mtxErr) {
        clients.remove(record.username); // rollback: não deixa cliente "meio criado"
        throw mtxErr;
      }
      sendJson(res, 201, { username: record.username, passphrase: record.passphrase, createdAt: record.createdAt });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  const deleteMatch = urlPath.match(/^\/admin\/api\/clients\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const username = decodeURIComponent(deleteMatch[1]);
    try {
      stopCueDetector(username);
      await mediamtxApi.deletePath(username);
      const removed = clients.remove(username);
      sendJson(res, removed ? 200 : 404, { ok: removed });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://internal');
  const urlPath = urlObj.pathname;

  if (urlPath.startsWith('/internal/')) {
    if (await handleInternalRoutes(req, res, urlPath)) return;
  }

  if (urlPath === '/admin' || urlPath === '/admin/') {
    if (!checkBasicAuth(req, res, ADMIN_USER, ADMIN_PASS, 'scte-monitor-admin')) return;
    serveFile(ADMIN_DIR, '/index.html', req, res);
    return;
  }

  if (urlPath.startsWith('/admin/api/')) {
    if (await handleAdminApi(req, res, urlPath)) return;
  }

  if (urlPath === '/events') {
    const username = urlObj.searchParams.get('client') || '';
    if (!clients.get(username)) {
      res.writeHead(404);
      res.end('Cliente não encontrado');
      return;
    }
    const state = getState(username);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', history: state.history })}\n\n`);
    state.sseClients.add(res);
    req.on('close', () => state.sseClients.delete(res));
    return;
  }

  if (urlPath === '/history') {
    const username = urlObj.searchParams.get('client') || '';
    if (!clients.get(username)) {
      res.writeHead(404);
      res.end('Cliente não encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getState(username).history));
    return;
  }

  if (urlPath.startsWith(HLS_PROXY_PREFIX)) {
    proxyHls(req, res);
    return;
  }

  // Página pública por cliente: streaming.tvtupi.com.br/<usuario>. Sem
  // autenticação -- serve como vitrine/demonstração para outros clientes.
  const clientMatch = urlPath.match(/^\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\/?$/);
  if (clientMatch && clients.get(clientMatch[1])) {
    serveFile(PUBLIC_DIR, '/index.html', req, res);
    return;
  }

  serveFile(PUBLIC_DIR, urlPath === '/' ? '/index.html' : urlPath, req, res);
});

server.listen(HTTP_PORT, () => {
  console.log(`scte-monitor HTTP em http://0.0.0.0:${HTTP_PORT}`);
});
