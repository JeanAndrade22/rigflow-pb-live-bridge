FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
ENV NODE_ENV=production PORT=8787 POLL_MS=30000
EXPOSE 8787
CMD ["npm","start"]
