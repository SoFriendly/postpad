# Self-hosted PostPad API: the same Hono app as the Worker, on Node + a SQLite file.
# Node 24 runs the TypeScript directly (type stripping), so there's no build step.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NODE_NO_WARNINGS=1 DB_PATH=/data/postpad.db PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/node.ts"]
