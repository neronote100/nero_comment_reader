export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_ORIGIN: string;
  ADMIN_EMAIL: string;
  NOTE_OWNER: string;
  MEMBERSHIP_NAME: string;
  GMAIL_FROM: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
  DISCORD_WEBHOOK_URL?: string;
  AUTO_AI_LIMIT: string;
}
