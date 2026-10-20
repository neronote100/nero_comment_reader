FROM node:24-bookworm-slim
WORKDIR /app/recommend
COPY recommend/package.json recommend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY recommend/ /app/recommend/
COPY index.html app.js styles.css /app/
COPY data/ /app/data/
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
EXPOSE 8787
CMD ["sh","-c","npm run db:local && npx wrangler dev --ip 0.0.0.0 --port 8787 --test-scheduled"]
