FROM oven/bun:1.3.13 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY services/api/package.json ./services/api/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.13
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates git docker-cli docker.io ripgrep && rm -rf /var/lib/apt/lists/*
ARG POCKETBASE_VERSION=0.26.5
ARG TARGETARCH
RUN curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_${TARGETARCH}.zip" -o /tmp/pb.zip && unzip /tmp/pb.zip -d /usr/local/bin && rm /tmp/pb.zip
COPY package.json bun.lock* ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY services/api/package.json ./services/api/package.json
RUN bun install --production --frozen-lockfile
COPY --from=build /app/apps/web/dist ./dist
COPY services/api/src ./services/api/src
COPY packages/runtime/src ./packages/runtime/src
COPY docker/mcp-fixture.ts ./docker/mcp-fixture.ts
COPY docker/start.sh /usr/local/bin/subpolar-start
RUN chmod +x /usr/local/bin/subpolar-start
ENV NODE_ENV=production PB_URL=http://127.0.0.1:8090
EXPOSE 3000
VOLUME ["/app/pb_data"]
ENTRYPOINT ["/usr/local/bin/subpolar-start"]
