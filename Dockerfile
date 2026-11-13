FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
# NODE_ENV=production tek başına devDependencies'i (typescript) atlardı — build için gerekli.
RUN npm ci --include=dev

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/server.js"]
