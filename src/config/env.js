require("dotenv").config();

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: process.env.PORT || 5000,
  FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:5173",
  DATABASE_URL: process.env.DATABASE_URL,
  DB_HOST: process.env.DB_HOST || "127.0.0.1",
  DB_PORT: Number(process.env.DB_PORT || 5432),
  DB_NAME: process.env.DB_NAME || "school_erp",
  DB_USER: process.env.DB_USER || "postgres",
  DB_PASSWORD: process.env.DB_PASSWORD,
  JWT_SECRET: process.env.JWT_SECRET || "REPLACE_WITH_A_LONG_RANDOM_SECRET_KEY",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "REPLACE_WITH_A_LONG_RANDOM_REFRESH_SECRET_KEY",
  JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY || "15m",
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || "7d",
  REDIS_URL: process.env.REDIS_URL,
};

module.exports = env;
