FROM node:20-slim

ENV NODE_ENV=production
ENV PORT=8000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 8000
CMD ["npm", "start"]
