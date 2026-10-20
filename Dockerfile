FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
COPY scripts ./scripts
RUN npm install --omit=dev
COPY *.mjs ./
ENV NODE_ENV=production
ENV DATA_DIR=/data/auth
EXPOSE 3000
CMD ["npm","start"]
