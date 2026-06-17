FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY public ./public
COPY src ./src
COPY config ./config
COPY scripts ./scripts
RUN mkdir -p /app/data /app/logs
EXPOSE 3000
CMD ["npm", "start"]
