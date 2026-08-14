# rtmp-hls

Servidor de transmissão ao vivo com **RTMP (entrada)** e **HLS (saída)** usando Nginx, empacotado em Docker.

Transmita com qualquer software de streaming (OBS Studio, ffmpeg) e assista pela web no player Video.js.

## Como funciona

- **Porta 1935** — recebe o stream via RTMP (`rtmp://SEU_IP/live/CHAVE`).
- **Porta 8085** — página web com o player HLS (`http://SEU_IP:8085/`), também exposta
  via HTTPS em `https://rtmp.tvtupi.com.br/` (ver **HTTPS via domínio** abaixo).
  Sem transmissão ativa, o player tenta recarregar sozinho a cada 5s — não precisa F5.
- **Porta 8890 (SRT)** — recebe transmissão SRT multi-cliente com SCTE-35 embutido
  (ex: TVPlay/SDK Medialooks). Cada cliente é um path próprio no `mediamtx`, com
  streamid e passphrase individuais, cadastrado via painel admin. Ver seção
  **SRT + monitor de cues SCTE-35 (multi-cliente)** abaixo.
- **Porta 8095** — painel admin (`/admin`, protegido por Basic Auth) e páginas
  públicas por cliente (`/​<usuario>`, sem autenticação) com player + tabela de cues
  SCTE-35 em tempo real. Também exposta via HTTPS em `https://streaming.tvtupi.com.br/`.

RTMP **não carrega SCTE-35** (limitação do protocolo, não deste servidor) — para
receber cue points use sempre a porta SRT (8890), não a RTMP (1935).

## Requisitos

- Docker Engine + Docker Compose

## Instalação do Docker Engine (em novos servidores)

Para servidores **Ubuntu/Debian** (com usuário com `sudo`):

```bash
# 1. Instalar pré-requisitos
sudo apt-get update
sudo apt-get install -y ca-certificates curl git

# 2. Adicionar o repositório oficial do Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 3. Instalar o Docker Engine + Compose
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# 4. Adicionar seu usuário ao grupo docker (evita usar sudo em todo comando)
sudo usermod -aG docker "$USER"
```

> **Importante:** depois do passo 4, **saia e entre novamente** na sessão (ou reinicie)
> para o grupo `docker` valer.

Para **CentOS/RHEL**: [docs.docker.com](https://docs.docker.com/engine/install/) tem
o passo a passo de cada distribuição.

## Como executar (instalação nos servidores)

```bash
# 1. Clonar o repositório
git clone git@github.com:videomart/rtmp-servidor.git
cd rtmp-servidor

# 2. Build da imagem e subir o container
docker compose up -d --build

# 3. Verificar se está rodando
docker ps

# 4. Abrir o firewall (se ativo) e conferir no navegador
sudo ufw allow 1935/tcp
sudo ufw allow 8085/tcp
# Acesse http://SEU_IP:8085/
```

Comandos úteis do serviço:

```bash
docker compose up -d --build    # iniciar (ou reiniciar) o serviço
docker compose ps               # ver o status
docker compose logs -f          # acompanhar os logs
docker compose stop             # parar o serviço
docker compose down             # parar e remover o container
docker compose restart          # reiniciar o serviço
```

> Para rodar **com Docker puro** (sem compose):

```bash
# Build da imagem
docker build -t rtmp-hls:latest .

# Subir o container
docker run -d --name rtmp_hls_server \
  -p 1935:1935 -p 8085:8085 \
  -v "$(pwd)/hls:/tmp/hls" \
  --restart always \
  rtmp-hls:latest
```

## Como transmitir (OBS Studio)

1. Abra o OBS Studio.
2. Em **Configurações → Transmissão**:
   - **Servidor**: `rtmp://SEU_IP:1935/live`
   - **Chave de transmissão**: `teste`
3. Inicie a transmissão.

Depois acesse `http://SEU_IP:8085/` para assistir.

### Com ffmpeg (exemplo)

```bash
ffmpeg -re -i seu_video.mp4 \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -c:a aac -f flv \
  rtmp://SEU_IP:1935/live/teste
```

## Configuração

- `nginx.conf` — configuração do Nginx (RTMP + HLS). A chave de stream (`teste`)
  pode ser trocada em `index.html` (campo `streamUrl`).
- `index.html` — página do player; monta a URL do stream dinamicamente.

## HTTPS via domínio (rtmp.tvtupi.com.br / streaming.tvtupi.com.br)

Dois domínios, dois pipelines distintos, ambos via HTTPS sem IP/porta visíveis,
usando o `nginx-proxy` + `acme-companion` (Let's Encrypt) que já roda neste servidor
para outros serviços:

- `https://rtmp.tvtupi.com.br/` → player RTMP legado (`rtmp-server`, `:8085`). Sem
  SCTE-35 (limitação do protocolo RTMP).
- `https://streaming.tvtupi.com.br/` → player + tabela de cues SCTE-35 em tempo real
  (`scte-monitor`, `:8095`, recebe via SRT). Continua protegido por HTTP Basic Auth
  mesmo atrás do domínio.

Isso funciona automaticamente porque cada serviço no `docker-compose.yml` declara seu
próprio par `VIRTUAL_HOST`/`LETSENCRYPT_HOST` e se conecta à rede Docker externa do
proxy (`PROXY_NETWORK` no `.env`, padrão `tvplay-web_default`) — o `nginx-proxy`
detecta essas variáveis e roteia/emite certificado sozinho, sem configuração manual
de nginx.

Pré-requisitos (já atendidos no servidor de produção atual):
- Registros DNS (`A`) de `rtmp.tvtupi.com.br` e `streaming.tvtupi.com.br` apontando
  para o IP do servidor.
- `nginx-proxy` + `acme-companion` já rodando e escutando `:80`/`:443`.
- A rede Docker externa referenciada em `PROXY_NETWORK` já existe (`docker network ls`).

Em um servidor **sem** essa infraestrutura (ex: ambiente novo, só este projeto), remova
o bloco `networks: proxy` e as variáveis `VIRTUAL_HOST`/`LETSENCRYPT_*` do
`docker-compose.yml` — o acesso local via `:8085` continua funcionando normalmente sem
elas.

## SRT + monitor de cues SCTE-35 (multi-cliente)

Antes de subir, copie `.env.example` para `.env` e preencha:

```bash
cp .env.example .env
# edite SCTE_ADMIN_USER, SCTE_ADMIN_PASS, MEDIAMTX_API_PASS
```

- `SCTE_ADMIN_USER` / `SCTE_ADMIN_PASS` — credenciais do painel admin (`/admin`),
  onde se cadastra/remove clientes.
- `MEDIAMTX_API_PASS` — senha interna (rede Docker, nunca exposta externamente) que o
  `scte-monitor` usa para provisionar paths no `mediamtx` via Control API. Gere um
  valor aleatório qualquer (ex: `openssl rand -base64 16`).

### Cadastrando um cliente

Acesse `https://streaming.tvtupi.com.br/admin` (login `SCTE_ADMIN_USER`/`SCTE_ADMIN_PASS`),
informe um nome de usuário (ex: `videomart`) e, opcionalmente, uma senha SRT — se
deixar em branco, uma é gerada automaticamente. Isso:

1. Cria o cliente (arquivo `scte-monitor/logs/clients.json`).
2. Provisiona um path dedicado no `mediamtx` (via Control API, sem reiniciar nada),
   com `srtPublishPassphrase` própria daquele cliente.

O cadastro devolve as credenciais de transmissão — **anote na hora**, a senha não é
mostrada de novo (mas pode ser trocada recriando o cliente).

### Como o cliente transmite (TVPlay ou qualquer encoder com SRT + embed SCTE-35)

```
srt://streaming.tvtupi.com.br:8890?streamid=publish:<usuario>&passphrase=<senha_do_cliente>
```

### Como assistir

`https://streaming.tvtupi.com.br/<usuario>` — página **pública, sem login** (serve
como vitrine/demonstração), com o player HLS e a tabela de cues daquele cliente em
tempo real.

### Arquitetura interna

- `mediamtx` recebe o SRT de todos os clientes diretamente (multi-stream nativo, um
  path por cliente/streamid) e gera o HLS correspondente.
- `scte-monitor` não fica mais no caminho do ingest. Quando o `mediamtx` sinaliza
  (`runOnAvailable`/`runOnUnavailable`) que um cliente começou/parou de transmitir, o
  `scte-monitor` inicia/encerra um processo `tsp` dedicado àquele cliente, que lê o
  stream de volta do `mediamtx` (SRT local) só para detectar os cues via
  `splicemonitor` — sem tocar no vídeo em si.
- A imagem do `mediamtx` (`mediamtx.Dockerfile`) adiciona um binário `wget` estático
  (cópia do busybox), porque a imagem oficial não tem shell/cliente HTTP e os hooks
  precisam chamar o `scte-monitor`.
- Logs e histórico de cues (por cliente, persistem entre reinícios) ficam em
  `scte-monitor/logs/history/<usuario>.json`.

**Limitação atual:** a passphrase SRT é validada pelo `mediamtx` por path — cada
cliente já tem a sua, mas todos compartilham a mesma porta de ingest (`8890`) e o
mesmo domínio de visualização.

## Publicação no GitHub

```bash
git init
git add .
git commit -m "Servidor RTMP/HLS com Docker"
git branch -M main
git remote add origin git@github.com:videomart/rtmp-servidor.git
git push -u origin main
```
