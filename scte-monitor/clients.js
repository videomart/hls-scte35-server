'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Armazenamento de clientes: arquivo JSON com escrita atômica (write em
// tmp + rename), suficiente para o volume esperado (dezenas de clientes,
// escritas raras via painel admin). Nome de usuário = nome do path SRT/HLS
// e também o segmento da URL pública (streaming.tvtupi.com.br/<usuario>).
const CLIENTS_FILE = process.env.CLIENTS_FILE || path.join(__dirname, 'logs', 'clients.json');

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
// Cada cliente tem uma porta SRT dedicada (o TVPlay conecta aqui, não mais
// direto no MediaMTX): o MediaMTX descarta silenciosamente qualquer track de
// codec desconhecido (inclui SCTE-35) já na recepção -- "skipping track N
// (unsupported codec)" -- então o SCTE-35 precisa passar por um relay tsp
// bruto (bytes crus, sem demux) antes de chegar no MediaMTX.
const SRT_PORT_BASE = Number(process.env.SRT_PORT_BASE || 8900);
const SRT_PORT_MAX = Number(process.env.SRT_PORT_MAX || 8930);

let clients = new Map(); // username -> { username, passphrase, srtPort, createdAt }

function allocPort() {
  const used = new Set([...clients.values()].map((c) => c.srtPort).filter(Boolean));
  for (let p = SRT_PORT_BASE; p <= SRT_PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(`Sem portas SRT disponíveis (limite: ${SRT_PORT_MAX - SRT_PORT_BASE + 1} clientes)`);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    clients = new Map(raw.map((c) => [c.username, c]));
  } catch (e) {
    clients = new Map();
  }
}

function persist() {
  fs.mkdirSync(path.dirname(CLIENTS_FILE), { recursive: true });
  const tmp = CLIENTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Array.from(clients.values()), null, 2));
  fs.renameSync(tmp, CLIENTS_FILE);
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new Error('Usuário inválido: use 3-32 caracteres, letras minúsculas, números e hífen, começando e terminando com letra/número.');
  }
  // Reservado: caminhos internos usados pelo próprio servidor.
  const reserved = ['admin', 'events', 'history', 'hls-live', 'api'];
  if (reserved.includes(username)) {
    throw new Error(`"${username}" é um nome reservado.`);
  }
}

function generatePassphrase() {
  // SRT exige passphrase entre 10 e 79 caracteres.
  return crypto.randomBytes(12).toString('base64url'); // 16 chars
}

// Inclui a passphrase -- só chamado atrás de auth do painel admin
// (checkBasicAuth em server.js), não é exposto em nenhuma rota pública.
function list() {
  return Array.from(clients.values()).map(({ username, passphrase, srtPort, createdAt }) => ({
    username,
    passphrase,
    srtPort,
    createdAt,
  }));
}

function get(username) {
  return clients.get(username) || null;
}

function create(username, passphrase) {
  validateUsername(username);
  if (clients.has(username)) {
    throw new Error(`Usuário "${username}" já existe.`);
  }
  const record = {
    username,
    passphrase: passphrase || generatePassphrase(),
    srtPort: allocPort(),
    createdAt: new Date().toISOString(),
  };
  clients.set(username, record);
  persist();
  return record;
}

function remove(username) {
  const existed = clients.delete(username);
  if (existed) persist();
  return existed;
}

function updatePassphrase(username, passphrase) {
  const record = clients.get(username);
  if (!record) {
    throw new Error(`Usuário "${username}" não encontrado.`);
  }
  const newPassphrase = passphrase || generatePassphrase();
  if (newPassphrase.length < 10 || newPassphrase.length > 79) {
    throw new Error('Senha SRT precisa ter entre 10 e 79 caracteres.');
  }
  record.passphrase = newPassphrase;
  persist();
  return record;
}

load();

// Migração: clientes cadastrados antes da porta SRT dedicada existir
// recebem uma na próxima carga (também precisam ser reprovisionados no
// MediaMTX com srtReadPassphrase -- ver server.js/mediamtx-api.js).
let migratedOnLoad = false;
for (const c of clients.values()) {
  if (!c.srtPort) {
    try {
      c.srtPort = allocPort();
      migratedOnLoad = true;
    } catch (e) {
      console.warn(`[${c.username}] Falha ao migrar srtPort:`, e.message);
    }
  }
}
if (migratedOnLoad) persist();

module.exports = { list, get, create, remove, updatePassphrase, generatePassphrase, validateUsername };
