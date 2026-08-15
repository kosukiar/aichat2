# Nova Sonic WebSocket relay server
# Runs on ECS Fargate behind an ALB (WebSocket / wss terminated at the ALB).
FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

# Install production dependencies only (express, ws, @aws-sdk/client-bedrock-runtime)
COPY nova-sonic-app/package.json nova-sonic-app/package-lock.json ./
RUN npm ci --omit=dev

# Relay server source
COPY nova-sonic-app/server ./server

ENV PORT=3001 \
    AWS_REGION=ap-northeast-1

EXPOSE 3001

# ALB health check hits /health; keep a container-level check too
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["node", "server/index.mjs"]
