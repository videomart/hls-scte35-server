# rtmp-hls

Servidor de transmissão ao vivo com **RTMP (entrada)** e **HLS (saída)** usando Nginx, empacotado em Docker.

Transmita com qualquer software de streaming (OBS Studio, ffmpeg) e assista pela web no player Video.js.

## Como funciona

- **Porta 1935** — recebe o stream via RTMP (`rtmp://SEU_IP/live/CHAVE`).
- **Porta 8085** — página web com o player HLS (`http://SEU_IP:8085/`), também exposta
  via HTTPS em `https://rtmp.tvtupi.com.br/` (ver **HTTPS via domínio** abaixo).
  Sem transmissão ativa, o player tenta recarregar sozinho a cada 5s — não precisa F5.
- **Porta 8890 (SRT)** — recebe transmissão SRT com SCTE-35 embutido (ex: TVPlay/SDK
  Medialooks). O serviço `scte-monitor` detecta os cues (cue-in/cue-out) em tempo real,
  loga cada evento e retransmite o stream para o `mediamtx`, que gera o HLS
  correspondente. Ver seção **SRT + monitor de cues SCTE-35** abaixo.
- **Porta 8095** — página web com player + tabela de cues SCTE-35 recebidos em tempo
  real (`http://SEU_IP:8095/`), também exposta via HTTPS em
  `https://streaming.tvtupi.com.br/`, protegida por HTTP Basic Auth.

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

## SRT + monitor de cues SCTE-35

Antes de subir, copie `.env.example` para `.env` e preencha:

```bash
cp .env.example .env
# edite SCTE_SRT_PASSPHRASE, SCTE_WEB_USER, SCTE_WEB_PASS
```

- `SCTE_SRT_PASSPHRASE` — senha SRT (10-79 caracteres) exigida do lado de quem
  transmite (TVPlay). Sem isso, qualquer um na rede pode publicar no streamid.
- `SCTE_WEB_USER` / `SCTE_WEB_PASS` — credenciais HTTP Basic Auth da página do
  monitor (`:8095`).

Como transmitir (TVPlay ou qualquer encoder com saída SRT + embed SCTE-35):

```
srt://SEU_IP:8890?streamid=publish:teste&passphrase=SUA_PASSPHRASE
```

Acesse `http://SEU_IP:8095/` (login com `SCTE_WEB_USER`/`SCTE_WEB_PASS`) para ver o
player e a tabela de cues recebidos em tempo real (mais recente no topo).

Arquitetura interna: `scte-monitor` recebe o SRT, usa TSDuck (`tsp` +
`splicemonitor`) para detectar os cues e retransmite o stream completo para o
`mediamtx` (porta interna 8891), que faz o remux para HLS servido em `:8888`
(consumido pela página do monitor, não exposto diretamente para uso externo).

Logs e histórico de cues (persistem entre reinícios) ficam em `scte-monitor/logs/`.

**Limitação atual:** suporta 1 transmissão por vez (streamid fixo `teste`). Para
múltiplos clientes simultâneos, veja `scte-monitor/server.js` (`SRT_STREAMID`,
`FORWARD_STREAMID`) — cada cliente precisaria de uma instância própria do serviço
com portas/streamid distintos.

## Publicação no GitHub

```bash
git init
git add .
git commit -m "Servidor RTMP/HLS com Docker"
git branch -M main
git remote add origin git@github.com:videomart/rtmp-servidor.git
git push -u origin main
```
