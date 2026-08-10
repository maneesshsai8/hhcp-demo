# HHCP gateway — thin BE_SERVER / NODE_ROUTES reverse proxy.
# Single file + one dependency (http-proxy), so it installs standalone (no
# workspace needed). BUILD FROM THE REPO ROOT:
#   docker build -f apps/gateway/Dockerfile -t hhcp-gateway .

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV GATEWAY_PORT=8080

COPY apps/gateway/package.json ./
RUN npm install --omit=dev

COPY apps/gateway/src ./src

EXPOSE 8080
CMD ["node", "src/index.js"]
