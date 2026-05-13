-- ============================================================
-- MIGRACIÓN: Agregar soporte para roles (médico / paciente)
-- Ejecuta esto en MySQL si ya tienes la BD creada
-- ============================================================

USE podologia_db;

-- Agregar columna role a users (si no existe)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'doctor';

-- Los usuarios ya creados son médicos (comportamiento anterior)
UPDATE users SET role = 'doctor' WHERE role IS NULL OR role = '';

-- ============================================================
-- CREACIÓN COMPLETA (si empiezas desde cero)
-- Puedes usar este bloque en lugar de database.sql
-- ============================================================

-- CREATE DATABASE IF NOT EXISTS podologia_db;
-- USE podologia_db;

-- CREATE TABLE IF NOT EXISTS users (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   name VARCHAR(100) NOT NULL,
--   email VARCHAR(100) UNIQUE NOT NULL,
--   password VARCHAR(255) NOT NULL,
--   role VARCHAR(20) DEFAULT 'doctor',   -- 'doctor' | 'patient' | 'admin'
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- (El resto de las tablas son idénticas a database.sql original)

-- ============================================================
-- CREAR CUENTA DE MÉDICO DE PRUEBA
-- Contraseña: medico123
-- (Hash bcrypt generado externamente)
-- ============================================================
-- INSERT INTO users (name, email, password, role) VALUES
-- ('Dr. Prueba', 'medico@clinic.com', '$2b$10$...hash...', 'doctor');

-- ============================================================
-- VERIFICAR
-- ============================================================
SELECT id, name, email, role, created_at FROM users;
