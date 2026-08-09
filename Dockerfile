FROM docker.io/tiangolo/nginx-rtmp:latest

COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /tmp/index.html

RUN mkdir -p /tmp/hls

EXPOSE 1935 8080
