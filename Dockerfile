FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./

ARG DEPENDENCY_CACHE_BUST=2026-07-16-02

RUN npm install -g npm@11.7.0 \
    && npm ci --omit=dev \
    && npm ls express \
    && node -e "require('express'); require('ws'); require('firebase-admin/app'); require('@google-cloud/speech'); console.log('Runtime dependencies verified')"

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
