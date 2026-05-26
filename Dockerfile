FROM node:22-bookworm-slim

ENV NODE_ENV=production

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

EXPOSE 3000

USER node

CMD ["pnpm", "start"]
