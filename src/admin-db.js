import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const configuredDatabase = process.env.ADMIN_DB_NAME || "glownest_admin_db";
export const adminDatabaseName = /^[a-zA-Z0-9_]+$/.test(configuredDatabase)
  ? configuredDatabase
  : "glownest_admin_db";

const connectionOptions = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
  namedPlaceholders: true,
};

const bootstrapPool = mysql.createPool(connectionOptions);
const adminPool = mysql.createPool({
  ...connectionOptions,
  database: adminDatabaseName,
});

let setupPromise;

export function ensureAdminDatabase() {
  if (!setupPromise) {
    setupPromise = (async () => {
      await bootstrapPool.query(
        `CREATE DATABASE IF NOT EXISTS \`${adminDatabaseName}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await adminPool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          full_name VARCHAR(150) NOT NULL,
          phone VARCHAR(30) NULL,
          email VARCHAR(180) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          status ENUM('active', 'blocked') NOT NULL DEFAULT 'active',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY admin_users_email_unique (email),
          KEY admin_users_phone_index (phone)
        )
      `);
    })().catch((error) => {
      setupPromise = undefined;
      throw error;
    });
  }

  return setupPromise;
}

export async function adminQuery(sql, params) {
  await ensureAdminDatabase();
  const [rows] = await adminPool.query(sql, params);
  return rows;
}
