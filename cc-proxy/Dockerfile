# Node 22+ com Chromium para suporte a renovação de auth headless
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.ts upstream.ts openai.ts anthropic.ts models.ts renew.ts renew-cli.ts ./

# Dentro do container precisa escutar em todas as interfaces; a exposição
# real fica a cargo do -p 127.0.0.1:8787 no host.
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787

# A key vem de COMMAND_CODE_API_KEY ou do /root/.commandcode/auth.json montado.
CMD ["node", "server.ts"]
