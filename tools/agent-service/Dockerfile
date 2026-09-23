FROM node:22-alpine
WORKDIR /app
COPY tools/agent-service ./tools/agent-service
COPY package.json ./
EXPOSE 8787
CMD ["node", "tools/agent-service/entrypoint.mjs"]
