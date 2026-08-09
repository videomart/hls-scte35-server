# rtmp-hls

Servidor de transmissão ao vivo com **RTMP (entrada)** e **HLS (saída)** usando Nginx, empacotado em Docker.

Transmita com qualquer software de streaming (OBS Studio, ffmpeg) e assista pela web no player Video.js.

## Como funciona

- **Porta 1935** — recebe o stream via RTMP (`rtmp://SEU_IP/live/CHAVE`).
- **Porta 8080** — página web com o player HLS (`http://SEU_IP:8080/`).

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
sudo ufw allow 8080/tcp
# Acesse http://SEU_IP:8080/
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
  -p 1935:1935 -p 8080:8080 \
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

Depois acesse `http://SEU_IP:8080/` para assistir.

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

## Publicação no GitHub

```bash
git init
git add .
git commit -m "Servidor RTMP/HLS com Docker"
git branch -M main
git remote add origin git@github.com:videomart/rtmp-servidor.git
git push -u origin main
```
