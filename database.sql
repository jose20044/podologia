-- Base de datos de Podología
CREATE DATABASE IF NOT EXISTS podologia_db;
USE podologia_db;

-- Tabla de usuarios (profesionales)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de pacientes
CREATE TABLE IF NOT EXISTS pacientes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  rut VARCHAR(20) UNIQUE NOT NULL,
  edad INT DEFAULT 0,
  email VARCHAR(100) DEFAULT '',
  telefono VARCHAR(20) DEFAULT '',
  direccion VARCHAR(200) DEFAULT '',
  alergias VARCHAR(200) DEFAULT '',
  diagnostico VARCHAR(500) DEFAULT '',
  estado VARCHAR(50) DEFAULT 'Activo',
  fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_rut (rut)
);

-- Tabla de historial clínico
CREATE TABLE IF NOT EXISTS historial_clinico (
  id INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id INT NOT NULL,
  tratamiento VARCHAR(150) DEFAULT '',
  diagnostico VARCHAR(500) DEFAULT '',
  observaciones LONGTEXT,
  proxima_cita DATE DEFAULT NULL,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE,
  INDEX idx_paciente_id (paciente_id),
  INDEX idx_fecha (fecha)
);

-- Tabla de citas
CREATE TABLE IF NOT EXISTS citas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  paciente_id INT NOT NULL,
  fecha DATE NOT NULL,
  hora TIME NOT NULL,
  duracion INT DEFAULT 30,
  tratamiento VARCHAR(150) DEFAULT '',
  notas LONGTEXT,
  estado VARCHAR(50) DEFAULT 'Pendiente',
  creada_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_paciente_id (paciente_id),
  INDEX idx_fecha (fecha)
);

-- Tabla de tratamientos (ofertas - valores fijos)
CREATE TABLE IF NOT EXISTS tratamientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  icono VARCHAR(5) DEFAULT '💅',
  precio DECIMAL(10,2) NOT NULL DEFAULT 0,
  descripcion VARCHAR(500) DEFAULT '',
  activo BOOLEAN DEFAULT TRUE
);

-- Tabla de ingresos/pagos
CREATE TABLE IF NOT EXISTS pagos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  paciente_id INT NOT NULL,
  cita_id INT DEFAULT NULL,
  monto DECIMAL(10,2) NOT NULL DEFAULT 0,
  metodo VARCHAR(50) DEFAULT 'Efectivo',
  estado VARCHAR(50) DEFAULT 'Pendiente',
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE,
  FOREIGN KEY (cita_id) REFERENCES citas(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_fecha (fecha)
);

-- Insertar tratamientos predefinidos (ofertas)
INSERT INTO tratamientos (nombre, icono, precio, descripcion) VALUES
('Quiropodia básica', '💅', 15000, 'Corte y limado de uñas, eliminación de callosidades superficiales, hidratación plantar.'),
('Micosis ungueal', '🦠', 25000, 'Tratamiento de hongos en uñas. Fresado, aplicación de antimicótico tópico y/o sistémico.'),
('Uña encarnada', '🩹', 30000, 'Onicocriptosis. Técnica conservadora o fenolización según grado de afectación.'),
('Plantillas ortopédicas', '🦶', 80000, 'Plantillas personalizadas termoplásticas. Incluye molde, fabricación y 1 ajuste.'),
('Pie diabético', '💉', 35000, 'Control integral: sensitivo, vascular, cuidado de piel y uñas. Evaluación de riesgo ulcerativo.'),
('Electroestimulación', '⚡', 20000, 'Terapia con corrientes para dolor plantar, fascitis plantar y recuperación deportiva.'),
('Verruga plantar', '🔬', 28000, 'Tratamiento de papiloma plantar. Crioterapia o tratamiento químico con ácido salicílico.'),
('Estudio biomecánico', '🏃', 50000, 'Análisis de marcha y pisada, huella plantar digital, prescripción de corrección postural.'),
('Quiropodia premium', '🌿', 25000, 'Quiropodia completa + exfoliación, masaje relajante, parafina y cuidado estético.');

-- Crear índices adicionales para optimización
CREATE INDEX idx_pacientes_user ON pacientes(user_id);
CREATE INDEX idx_historial_paciente ON historial_clinico(paciente_id);
CREATE INDEX idx_citas_user ON citas(user_id);
CREATE INDEX idx_citas_paciente ON citas(paciente_id);

-- Mostrar tablas
SHOW TABLES;
EXIT;
