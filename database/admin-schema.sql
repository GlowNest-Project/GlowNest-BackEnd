CREATE DATABASE IF NOT EXISTS glownest_admin_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE glownest_admin_db;

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
);

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX
  ON glownest_admin_db.*
  TO 'glownest_app'@'localhost';

FLUSH PRIVILEGES;
