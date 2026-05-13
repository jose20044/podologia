-- ============================================================
-- PodoClinic - Schema MySQL para Railway
-- NO incluir CREATE DATABASE ni USE (Railway ya lo provee)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'doctor',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pacientes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  rut VARCHAR(20) NOT NULL,
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

CREATE TABLE IF NOT EXISTS tratamientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  icono VARCHAR(10) DEFAULT '💅',
  precio DECIMAL(10,2) NOT NULL DEFAULT 0,
  descripcion VARCHAR(500) DEFAULT '',
  activo BOOLEAN DEFAULT TRUE
);

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
