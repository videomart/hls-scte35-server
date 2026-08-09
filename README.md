# rtmp-hls

Servidor de transmissão ao vivo com **RTMP (entrada)** e **HLS (saída)** usando Nginx, empacotado em Docker.

Transmita com qualquer software de streaming (OBS Studio, ffmpeg) e assista pela web no player Video.js.

## Como funciona

- **Porta 1935** — recebe o stream via RTMP (`rtmp://SEU_IP/live/CHAVE`).
- **Porta 8080** — página web com o player HLS (`http://SEU_IP:8080/`).

## Requisitos

- Docker (ou Podman com compatibilidade com `docker compose`)

## Como executar

```bash
# 1. Build da imagem
docker build -t rtmp-hls:latest .

# 2. Subir o container
docker run -d --name rtmp_hls_server \
  -p 1935:1935 -p 8080:8080 \
  -v "$(pwd)/hls:/tmp/hls" \
  --restart always \
  rtmp-hls:latest
```

Ou, usando o docker-compose:

```bash
docker compose up -d --build
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
git remote add origin git@github.com:SEU_USUARIO/rtmp-hls.git
git push -u origin main
```
