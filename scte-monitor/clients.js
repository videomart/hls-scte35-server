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

let clients = new Map(); // username -> { username, passphrase, createdAt }

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

function list() {
  return Array.from(clients.values()).map(({ username, createdAt }) => ({ username, createdAt }));
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

load();

module.exports = { list, get, create, remove, generatePassphrase, validateUsername };
