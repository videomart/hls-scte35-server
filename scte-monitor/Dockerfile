FROM ubuntu:24.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    curl -fsSL -o /tmp/tsduck.deb \
      https://github.com/tsduck/tsduck/releases/download/v3.44-4676/tsduck_3.44-4676.ubuntu24_amd64.deb && \
    apt-get install -y --no-install-recommends /tmp/tsduck.deb && \
    rm -rf /tmp/tsduck.deb /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

EXPOSE 8095
CMD ["node", "server.js"]
