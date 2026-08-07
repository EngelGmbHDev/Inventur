FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY schema.sql ./
COPY src ./src
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data
ENV PORT=8080 DB_PATH=/app/data/inventur.db
EXPOSE 8080
CMD ["node", "server/index.js"]
