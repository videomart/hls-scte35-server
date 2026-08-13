'use strict';

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HTTP_PORT = process.env.HTTP_PORT || 8095;
const UDP_PORT = process.env.UDP_PORT || 9999;
const SRT_LISTEN = process.env.SRT_LISTEN || '0.0.0.0:8890';
const SRT_STREAMID = process.env.SRT_STREAMID || '';
const SRT_PASSPHRASE = process.env.SRT_PASSPHRASE || '';
// Para onde o stream é retransmitido depois de monitorado (MediaMTX faz o remux pra HLS)
const FORWARD_SRT_CALLER = process.env.FORWARD_SRT_CALLER || 'mediamtx:8891';
const FORWARD_STREAMID = process.env.FORWARD_STREAMID || 'publish:teste';
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'logs', 'scte-events.log');
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'logs', 'scte-history.json');
const MAX_HISTORY = 200;

// HTTP Basic Auth da página do monitor -- obrigatório em produção.
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || '';

let history = [];
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch (e) {
  history = [];
}
const sseClients = new Set();

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function appendLog(line) {
  fs.appendFile(LOG_FILE, line + '\n', (err) => {
    if (err) console.error('Falha ao gravar log:', err.message);
  });
}

function persistHistory() {
  fs.writeFile(HISTORY_FILE, JSON.stringify(history), (err) => {
    if (err) console.error('Falha ao gravar histórico:', err.message);
  });
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function handleSpliceEvent(evt) {
  const record = {
    receivedAt: new Date().toISOString(),
    eventId: evt['event-id'],
    type: evt['event-type'], // "in" ou "out"
    progress: evt['progress'],
    splicePid: evt['splice-pid'],
  };
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  persistHistory();

  const logLine = `[${record.receivedAt}] CUE-${record.type.toUpperCase()} event-id=${record.eventId} pid=${record.splicePid} progress=${record.progress}`;
  console.log(logLine);
  appendLog(logLine);
  broadcast(record);
}

// --- Recebe o JSON do tsp/splicemonitor via UDP ---
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
    if (item && item['#name'] === 'event') {
      handleSpliceEvent(item);
    }
  }
});
udpSocket.on('error', (err) => {
  console.error('Erro no socket UDP:', err.message);
});
udpSocket.bind(UDP_PORT, '127.0.0.1', () => {
  console.log(`Escutando eventos SCTE-35 (JSON/UDP) em 127.0.0.1:${UDP_PORT}`);
});

// --- Processo tsp: le o SRT, detecta splice events (--json-udp) e
// retransmite o TS completo para o MediaMTX, que faz o remux pra HLS. ---
function startTsp() {
  const streamIdArgs = SRT_STREAMID ? ['--streamid', SRT_STREAMID] : [];
  const passphraseArgs = SRT_PASSPHRASE ? ['--passphrase', SRT_PASSPHRASE] : [];
  const args = [
    '-I', 'srt', '--listener', SRT_LISTEN, ...streamIdArgs, ...passphraseArgs,
    '-P', 'splicemonitor', '--json-udp', `127.0.0.1:${UDP_PORT}`,
    '-O', 'srt', '--caller', FORWARD_SRT_CALLER, '--streamid', FORWARD_STREAMID,
  ];
  console.log('Iniciando tsp:', args.join(' '));
  const proc = spawn('tsp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout.on('data', (d) => process.stdout.write(`[tsp] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[tsp] ${d}`));
  proc.on('exit', (code, signal) => {
    console.error(`tsp encerrou (code=${code}, signal=${signal}). Reiniciando em 3s...`);
    setTimeout(startTsp, 3000);
  });
}
startTsp();

// --- HTTP: pagina + SSE + historico ---
const PUBLIC_DIR = path.join(__dirname, 'public');

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(req, res) {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return true; // auth desligada (dev local)

  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${BASIC_AUTH_USER}:${BASIC_AUTH_PASS}`).toString('base64');
  if (header && timingSafeEqual(header, expected)) return true;

  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="scte-monitor"' });
  res.end('Autenticação necessária');
  return false;
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
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

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', history })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.url === '/history') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(history));
    return;
  }

  serveStatic(req, res);
});

server.listen(HTTP_PORT, () => {
  console.log(`scte-monitor HTTP em http://0.0.0.0:${HTTP_PORT}`);
});
