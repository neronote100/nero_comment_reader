FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
EXPOSE 8787
CMD ["sh","-c","npm run db:local && npx wrangler dev --ip 0.0.0.0 --port 8787 --test-scheduled"]
