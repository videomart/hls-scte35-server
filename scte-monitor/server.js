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

// --- Processo tsp por cliente: escuta SRT numa porta dedicada e detecta
// splice events via splicemonitor.
//
// O MediaMTX descarta silenciosamente qualquer track de codec desconhecido
// já na recepção SRT ("skipping track N (unsupported codec)"), incluindo o
// PID de SCTE-35 -- então ler de volta do MediaMTX nunca veria os cues,
// mesmo com a passphrase de leitura certa. Por isso o TVPlay não conecta
// mais direto no MediaMTX (porta 8890): conecta numa porta SRT dedicada
// deste detector (client.srtPort), que faz splicemonitor (detecta cues) E
// relay bruto (bytes crus, sem demux) para o MediaMTX -- preservando o PID
// SCTE-35 no caminho, mesmo que o MediaMTX descarte na hora de reexibir.
//
// Processo permanente por cliente (não mais sob demanda via hook): inicia
// no boot para todo cliente cadastrado, e auto-reinicia se cair (o listener
// precisa estar sempre de pé esperando o TVPlay conectar/reconectar). ---
let nextUdpPort = 9900;

function startCueDetector(username) {
  const state = getState(username);
  if (state.tspProc) return; // já rodando

  const client = clients.get(username);
  if (!client || !client.srtPort) {
    console.warn(`[${username}] startCueDetector: cliente sem srtPort, abortando`);
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

  const passphraseArgs = client.passphrase ? ['--passphrase', client.passphrase] : [];
  const args = [
    // Input: listener SRT na porta dedicada do cliente -- o TVPlay conecta aqui.
    '-I', 'srt', '--listener', `0.0.0.0:${client.srtPort}`, ...passphraseArgs,
    // Detecta os cues e emite o JSON via UDP local.
    '-P', 'splicemonitor', '--json-udp', `127.0.0.1:${udpPort}`,
    // Relay bruto (bytes crus, sem remux) para o MediaMTX -- preserva o PID
    // SCTE-35 no caminho até lá, mesmo que o MediaMTX o descarte ao exibir.
    '-O', 'srt', '--caller', `${MEDIAMTX_HOST}:${MEDIAMTX_SRT_PORT}`, '--streamid', `publish:${username}`, ...passphraseArgs,
  ];
  console.log(`[${username}] Iniciando detector+relay (SRT :${client.srtPort} -> mediamtx:${MEDIAMTX_SRT_PORT}):`, args.join(' '));
  const proc = spawn('tsp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  state.tspProc = proc;

  proc.stdout.on('data', (d) => process.stdout.write(`[tsp:${username}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[tsp:${username}] ${d}`));
  proc.on('exit', (code, signal) => {
    console.log(`[${username}] Detector+relay encerrou (code=${code}, signal=${signal})`);
    state.tspProc = null;
    if (state.udpSocket) {
      state.udpSocket.close();
      state.udpSocket = null;
    }
    // O listener precisa estar sempre de pé para aceitar a próxima conexão
    // do TVPlay. Delay evita loop apertado se o MediaMTX estiver indisponível.
    setTimeout(() => {
      if (clients.get(username) && !getState(username).tspProc) startCueDetector(username);
    }, 3000);
  });
}

function stopCueDetector(username) {
  const state = perClientState.get(username);
  if (!state || !state.tspProc) return;
  state.tspProc.removeAllListeners('exit'); // não reiniciar: remoção intencional do cliente
  state.tspProc.kill('SIGTERM');
}

// --- HTTP: pagina + SSE + historico + admin ---
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
      startCueDetector(record.username);
      sendJson(res, 201, {
        username: record.username,
        passphrase: record.passphrase,
        srtPort: record.srtPort,
        createdAt: record.createdAt,
      });
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

// O MediaMTX não persiste paths criados via Control API entre reinícios (não
// ficam salvos no mediamtx.yml) -- todo boot precisa reprovisionar cada
// cliente cadastrado, ou o relay é rejeitado ("passphrase is missing"/path
// inexistente) mesmo com o cliente existindo localmente. Como os dois
// containers sobem em paralelo, o DNS de "mediamtx" pode não estar pronto
// ainda no primeiro boot (EAI_AGAIN) -- tenta de novo em vez de desistir.
async function reprovisionAndStart(username, attempt = 1) {
  const client = clients.get(username);
  if (!client) return;
  try {
    await mediamtxApi.addOrReplacePath(client.username, client.passphrase);
  } catch (err) {
    console.error(`[${username}] Falha ao reprovisionar path no MediaMTX (tentativa ${attempt}):`, err.message);
    if (attempt < 10) {
      setTimeout(() => reprovisionAndStart(username, attempt + 1), 3000);
      return;
    }
    console.error(`[${username}] Desistindo de reprovisionar após ${attempt} tentativas -- cliente pode não transmitir corretamente.`);
  }
  startCueDetector(username);
}

server.listen(HTTP_PORT, () => {
  console.log(`scte-monitor HTTP em http://0.0.0.0:${HTTP_PORT}`);
  // Cada cliente cadastrado tem um listener SRT permanente dedicado -- sobe
  // no boot para todos, não só sob demanda (o TVPlay pode reconectar a
  // qualquer momento, o listener precisa estar sempre esperando).
  for (const c of clients.list()) reprovisionAndStart(c.username);
});
