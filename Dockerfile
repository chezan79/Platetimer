FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./

ARG DEPENDENCY_CACHE_BUST=2026-07-16-05

RUN echo "Cache bust: ${DEPENDENCY_CACHE_BUST}" \
    && node --version \
    && npm --version

RUN npm ci --omit=dev --no-audit --no-fund --loglevel=verbose

RUN node -e "\
console.log('Express:', require('express/package.json').version); \
require('ws'); \
require('firebase-admin/app'); \
require('firebase-admin/firestore'); \
require('@google-cloud/speech'); \
console.log('Runtime dependencies verified');"

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
