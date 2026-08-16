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
    state = {
      history: [],
      sseClients: new Set(),
      tspProc: null,
      udpSocket: null,
      udpPort: null,
      pendingTables: new Map(),
      // Breaks (cue-out/cue-in) usados pelo proxy HLS para anotar o manifest
      // com EXT-X-DATERANGE/CUE-OUT/CUE-IN -- ver updateActiveBreak/rewriteManifest.
      breaks: [],
    };
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
  const eventId = evt['event-id'];
  // A tabela SCTE-35 bruta (com o splice_info_section em base64) chega via
  // um datagrama JSON separado, tipicamente antes ou junto do evento --
  // guardamos as últimas por splice_event_id para anexar ao registro do cue
  // (usado depois para popular EXT-X-DATERANGE SCTE35-OUT/IN no HLS).
  const pending = state.pendingTables && state.pendingTables.get(eventId);
  const record = {
    receivedAt: new Date().toISOString(),
    eventId,
    type: evt['event-type'], // "in" ou "out"
    progress: evt['progress'],
    splicePid: evt['splice-pid'],
    spliceInfoHex: pending ? pending.hex : null,
    durationMs: pending ? pending.durationMs : null,
  };
  if (state.pendingTables) state.pendingTables.delete(eventId);
  state.history.unshift(record);
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  persistHistory(username, state);

  const logLine = `[${record.receivedAt}] [${username}] CUE-${record.type.toUpperCase()} event-id=${record.eventId} pid=${record.splicePid} progress=${record.progress}`;
  console.log(logLine);
  appendLog(logLine);
  broadcast(state, record);
  updateActiveBreak(username, record);
}

// Extrai splice_event_id, o base64 do splice_info_section bruto, e a duração
// (segmentation_duration/break_duration, unidade 90kHz) de um datagrama de
// tabela SCTE-35 completa (emitido pelo splicemonitor com -a
// --meta-base64-sections, ao lado dos datagramas de "event").
function handleSpliceTable(username, tableObj) {
  const state = getState(username);
  if (!state.pendingTables) state.pendingTables = new Map();

  const nodes = tableObj['#nodes'] || [];
  let base64Section = null;
  let eventId = null;
  let durationPts = null;
  for (const node of nodes) {
    if (node['#name'] === 'metadata') {
      const section = (node['#nodes'] || []).find((n) => n['#name'] === 'section');
      if (section && section.base64) base64Section = section.base64;
    } else if (node['#name'] === 'splice_insert') {
      eventId = node.splice_event_id;
      const bd = (node['#nodes'] || []).find((n) => n['#name'] === 'break_duration');
      if (bd && typeof bd.duration === 'number') durationPts = bd.duration;
    } else if (node['#name'] === 'time_signal') {
      const segDesc = (tableObj['#nodes'] || []).find((n) => n['#name'] === 'splice_segmentation_descriptor');
      if (segDesc) {
        eventId = segDesc.segmentation_event_id;
        if (typeof segDesc.segmentation_duration === 'number') durationPts = segDesc.segmentation_duration;
      }
    }
  }
  if (eventId === null || !base64Section) return;

  state.pendingTables.set(eventId, {
    hex: Buffer.from(base64Section, 'base64').toString('hex'),
    // duration_pts está em unidades de 90kHz, igual PTS.
    durationMs: durationPts !== null ? Math.round(durationPts / 90) : null,
  });
  // Não deixa acumular indefinidamente se algum evento nunca chegar a
  // handleSpliceEvent (ex: comando cancelado antes do processEvent final).
  if (state.pendingTables.size > 20) {
    const oldestKey = state.pendingTables.keys().next().value;
    state.pendingTables.delete(oldestKey);
  }
}

// Duração default de um break quando o cue-out não veio com duration_pts
// (ex: splice_immediate sem break_duration) -- usada só como teto de
// segurança para não deixar EXT-X-DATERANGE aberto indefinidamente caso o
// cue-in correspondente nunca chegue.
const DEFAULT_BREAK_MS = 4 * 60 * 1000;
const MAX_BREAKS_TRACKED = 20;

// Mantém a lista de breaks (cue-out .. cue-in) usada pelo proxy HLS para
// decidir em quais segmentos do manifest inserir EXT-X-DATERANGE/CUE-OUT/
// CUE-IN. Um cue-out abre um break (fim estimado por duração, se conhecida);
// o cue-in seguinte com o mesmo eventId fecha esse break com o horário real.
function updateActiveBreak(username, record) {
  const state = getState(username);
  const startAt = new Date(record.receivedAt).getTime();

  if (record.type === 'out') {
    state.breaks.push({
      eventId: record.eventId,
      startAt,
      endAt: record.durationMs ? startAt + record.durationMs : startAt + DEFAULT_BREAK_MS,
      plannedDurationMs: record.durationMs || null,
      spliceInfoHexOut: record.spliceInfoHex,
      spliceInfoHexIn: null,
      closed: false,
    });
    if (state.breaks.length > MAX_BREAKS_TRACKED) state.breaks.shift();
  } else if (record.type === 'in') {
    const brk = [...state.breaks].reverse().find((b) => b.eventId === record.eventId && !b.closed);
    if (brk) {
      brk.endAt = startAt;
      brk.spliceInfoHexIn = record.spliceInfoHex;
      brk.closed = true;
    }
  }
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
      if (!item) continue;
      if (item['#name'] === 'event') handleSpliceEvent(username, item);
      else if (item['#name'] === 'splice_information_table') handleSpliceTable(username, item);
    }
  });
  udpSocket.on('error', (err) => console.error(`[${username}] Erro no socket UDP:`, err.message));
  udpSocket.bind(udpPort, '127.0.0.1');
  state.udpSocket = udpSocket;

  const passphraseArgs = client.passphrase ? ['--passphrase', client.passphrase] : [];
  const args = [
    // Input: listener SRT na porta dedicada do cliente -- o TVPlay conecta aqui.
    '-I', 'srt', '--listener', `0.0.0.0:${client.srtPort}`, ...passphraseArgs,
    // Detecta os cues e emite o JSON via UDP local. -a + --meta-base64-sections
    // fazem o plugin também emitir a tabela SCTE-35 bruta (splice_info_section
    // completo em base64), usada para popular EXT-X-DATERANGE SCTE35-OUT/IN
    // no manifest HLS (ver handleSpliceTable).
    '-P', 'splicemonitor', '-a', '--meta-base64-sections', '--json-udp', `127.0.0.1:${udpPort}`,
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

// kill('SIGTERM') não mata o processo instantaneamente -- se o chamador for
// reiniciar o detector logo em seguida (ex: troca de senha), precisa esperar
// a morte de fato ou startCueDetector encontra state.tspProc ainda
// preenchido (apontando pro processo antigo) e não faz nada.
function stopCueDetector(username) {
  return new Promise((resolve) => {
    const state = perClientState.get(username);
    if (!state || !state.tspProc) {
      resolve();
      return;
    }
    const proc = state.tspProc;
    proc.removeAllListeners('exit'); // não reiniciar sozinho: paramos por um motivo explícito
    proc.once('exit', () => {
      state.tspProc = null;
      if (state.udpSocket) {
        state.udpSocket.close();
        state.udpSocket = null;
      }
      resolve();
    });
    proc.kill('SIGTERM');
  });
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

// Formata um Date no formato de EXT-X-DATERANGE (ISO8601 com milissegundos).
function isoNoMs(date) {
  return date.toISOString();
}

// Reescreve um manifest .m3u8 (mpegts, com EXT-X-PROGRAM-DATE-TIME por
// segmento) inserindo EXT-X-DATERANGE (SCTE35-OUT/IN em hex, formato mais
// aceito por SSAI de mercado como MediaTailor/MediaPackage) e, para
// compatibilidade com players/SSAI legados, EXT-X-CUE-OUT/CUE-OUT-CONT/
// CUE-IN -- ancorados no segmento cujo PDT é o mais próximo (>=) do início
// de cada break conhecido.
//
// Limitação conhecida e aceita: o corte de segmento em si não muda -- a tag
// fica anotada no segmento de ~2s mais próximo do timestamp real do cue, não
// exatamente no frame do splice. Ver rtmp_servidor_api_contract (memória)
// para o racional dessa escolha.
function rewriteManifest(text, breaks) {
  if (!breaks || breaks.length === 0) return text;

  const lines = text.split('\n');
  const segments = []; // { pdtLineIndex, uriLineIndex, pdt }
  let pendingPdt = null;
  let pendingPdtIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingPdt = new Date(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim());
      pendingPdtIndex = i;
    } else if (line.startsWith('#EXTINF:') && pendingPdt) {
      segments.push({ insertBeforeIndex: pendingPdtIndex, pdt: pendingPdt });
      pendingPdt = null;
    }
  }
  if (segments.length === 0) return text; // sem PDT, não há como ancorar as tags

  const insertions = new Map(); // insertBeforeIndex -> [linhas a inserir antes]

  for (const brk of breaks) {
    // Só considera breaks cuja janela toca o intervalo coberto pela playlist
    // atual (segmento mais antigo até o mais novo) -- evita reanotar breaks
    // já totalmente fora da janela deslizante.
    const playlistStart = segments[0].pdt.getTime();
    const playlistEnd = segments[segments.length - 1].pdt.getTime();
    if (brk.endAt < playlistStart || brk.startAt > playlistEnd + 10000) continue;

    // Segmento de início: o primeiro cujo PDT já alcançou o startAt do break.
    const startSeg = segments.find((s) => s.pdt.getTime() >= brk.startAt) || segments[segments.length - 1];
    const startDate = isoNoMs(new Date(brk.startAt));
    const scte35Out = brk.spliceInfoHexOut ? `0x${brk.spliceInfoHexOut}` : null;
    const scte35In = brk.spliceInfoHexIn ? `0x${brk.spliceInfoHexIn}` : null;
    // Duração real só é conhecida quando veio no cue-out (plannedDurationMs)
    // ou quando o break já foi fechado por um cue-in. Sem isso, não inventa
    // número -- SSAI de mercado usa PLANNED-DURATION para pré-buscar
    // anúncios, e um valor errado (o teto interno DEFAULT_BREAK_MS) é pior
    // que omitir o atributo.
    const knownDurationMs = brk.closed ? brk.endAt - brk.startAt : brk.plannedDurationMs;
    const durationSec = knownDurationMs !== null ? Math.round(knownDurationMs / 1000) : null;

    const daterangeAttrs = [`ID="${brk.eventId}"`, `START-DATE="${startDate}"`];
    if (durationSec !== null) {
      daterangeAttrs.push(brk.closed ? `DURATION=${durationSec}` : `PLANNED-DURATION=${durationSec}`);
    }
    daterangeAttrs.push(`CLASS="com.tvtupi.scte35"`);
    if (scte35Out) daterangeAttrs.push(`SCTE35-OUT=${scte35Out}`);
    if (scte35In) daterangeAttrs.push(`SCTE35-IN=${scte35In}`);

    const linesToInsert = [`#EXT-X-DATERANGE:${daterangeAttrs.join(',')}`];
    linesToInsert.push(durationSec !== null ? `#EXT-X-CUE-OUT:${durationSec}` : '#EXT-X-CUE-OUT');

    const existing = insertions.get(startSeg.insertBeforeIndex) || [];
    insertions.set(startSeg.insertBeforeIndex, existing.concat(linesToInsert));

    // Segmentos intermediários dentro do break recebem CUE-OUT-CONT (prática
    // padrão para players/SSAI legados que dependem de anotação contínua,
    // não só do marcador inicial). Sem duração conhecida, não há como que
    // calcular o fim do break ainda -- não emite CONT/CUE-IN até o cue-in
    // real ou uma duração chegar (a próxima carga do manifest resolve isso).
    if (knownDurationMs === null) continue;

    const endSeg = segments.find((s) => s.pdt.getTime() >= brk.endAt);
    const startIdx = segments.indexOf(startSeg);
    const endIdx = endSeg ? segments.indexOf(endSeg) : segments.length;
    for (let idx = startIdx + 1; idx < endIdx; idx++) {
      const seg = segments[idx];
      const elapsedSec = Math.round((seg.pdt.getTime() - brk.startAt) / 1000);
      const contExisting = insertions.get(seg.insertBeforeIndex) || [];
      insertions.set(
        seg.insertBeforeIndex,
        contExisting.concat([`#EXT-X-CUE-OUT-CONT:${elapsedSec}/${durationSec}`])
      );
    }

    // CUE-IN no primeiro segmento cujo PDT alcança o fim do break (só quando
    // o break já foi fechado por um cue-in real -- senão ainda está em curso).
    if (brk.closed && endSeg && endSeg !== startSeg) {
      const endExisting = insertions.get(endSeg.insertBeforeIndex) || [];
      insertions.set(endSeg.insertBeforeIndex, endExisting.concat(['#EXT-X-CUE-IN']));
    }
  }

  if (insertions.size === 0) return text;

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const toInsert = insertions.get(i);
    if (toInsert) out.push(...toInsert);
    out.push(lines[i]);
  }
  return out.join('\n');
}

function proxyHls(req, res) {
  const targetPath = req.url.slice(HLS_PROXY_PREFIX.length - 1); // mantém a barra inicial
  const isManifest = targetPath.endsWith('.m3u8');
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

      if (!isManifest || proxyRes.statusCode !== 200) {
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
        return;
      }

      // Manifest: buferiza (pequeno, texto) para poder reescrever com as
      // tags SCTE-35 antes de responder.
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const original = Buffer.concat(chunks).toString('utf8');
        const username = targetPath.split('/').filter(Boolean)[0] || '';
        const state = perClientState.get(username);
        const rewritten = state ? rewriteManifest(original, state.breaks) : original;
        const body = Buffer.from(rewritten, 'utf8');
        headers['content-length'] = body.length;
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
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

  const patchMatch = urlPath.match(/^\/admin\/api\/clients\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const username = decodeURIComponent(patchMatch[1]);
    try {
      const body = await readJsonBody(req);
      const record = clients.updatePassphrase(username, body.passphrase);
      await mediamtxApi.addOrReplacePath(record.username, record.passphrase);
      // O detector antigo está rodando com a passphrase velha -- precisa
      // reiniciar com a nova, senão o TVPlay nunca mais consegue conectar.
      await stopCueDetector(username);
      startCueDetector(username);
      sendJson(res, 200, { username: record.username, passphrase: record.passphrase, srtPort: record.srtPort });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  const deleteMatch = urlPath.match(/^\/admin\/api\/clients\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const username = decodeURIComponent(deleteMatch[1]);
    try {
      await stopCueDetector(username);
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
