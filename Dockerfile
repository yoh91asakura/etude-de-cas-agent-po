FROM node:24-slim
WORKDIR /app
COPY . .
RUN npm ci
EXPOSE 3000
CMD ["npx", "tsx", "apps/api/src/serveur.ts"]
