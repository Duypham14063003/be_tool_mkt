FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate && npm run build

FROM mcr.microsoft.com/playwright:v1.54.1-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./
RUN mkdir -p reports playwright-artifacts && chown -R pwuser:pwuser /app
USER pwuser
CMD ["node", "dist/main.js"]
