# Sem deps de runtime: o Node 22+ roda os .ts direto (type stripping nativo).
FROM node:22-alpine

WORKDIR /app
COPY package.json server.ts upstream.ts openai.ts anthropic.ts models.ts ./

# Dentro do container precisa escutar em todas as interfaces; a exposição
# real fica a cargo do -p 127.0.0.1:8787 no host.
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787

# A key vem de COMMAND_CODE_API_KEY ou do /root/.commandcode/auth.json montado.
CMD ["node", "server.ts"]
