const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // confía en el proxy (Railway) para obtener la IP real
const PORT = process.env.PORT || 3001;

// JWT_SECRET DEBE ser fijo. Si cambia (p.ej. al reiniciar), todas las sesiones
// se invalidan y los usuarios son expulsados. En producción es obligatorio.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ FATAL: JWT_SECRET no está definido. Configúralo en las variables de entorno.');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET no definido: usando uno temporal (las sesiones se cerrarán al reiniciar). Solo para desarrollo.');
}
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

// ──────────────────────────────────────────
// SEGURIDAD: cabeceras HTTP
// ──────────────────────────────────────────
app.disable('x-powered-by'); // no revelar que es Express
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  // Content-Security-Policy: se permite 'unsafe-inline' porque las páginas usan
  // <style>/<script> embebidos. Restringe orígenes externos a las fuentes de Google.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self'"
  ].join('; '));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CORS: en producción restringe a CORS_ORIGIN; en local permite todo.
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map(s => s.trim()) } : {}));

// Límite de tamaño del body para evitar abusos
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  if (req.url.endsWith('.html')) res.type('text/html; charset=utf-8');
  next();
});

// Solo se sirven los archivos de public/ (NO el código fuente, .sql, .env, etc.)
// index:false → '/' lo maneja nuestra ruta (portal de pacientes), no index.html.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ──────────────────────────────────────────
// RATE LIMITER simple en memoria (anti fuerza bruta)
// Para una sola instancia es suficiente; si escalas a varias, usar Redis.
// ──────────────────────────────────────────
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const retry = Math.ceil((entry.reset - now) / 1000);
      res.setHeader('Retry-After', retry);
      return res.status(429).json({ error: message || 'Demasiadas peticiones, intenta más tarde.' });
    }
    next();
  };
}

// Máx 10 intentos de login/registro por IP cada 15 minutos
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.'
});

// Validación básica de email
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Limitador para endpoints públicos (consulta de RUT, agendar): más permisivo
// que el de auth pero evita scraping/enumeración masiva.
const publicLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: 'Demasiadas solicitudes. Espera un momento.'
});

// Normaliza un RUT: quita puntos/guiones/espacios y pasa a minúsculas
function normalizeRut(rut) {
  return String(rut || '').replace(/[.\-\s]/g, '').toLowerCase();
}

// Ofuscación de datos personales (autocompletado sin exponer PII completa)
function maskName(name) {
  return String(name || '').trim().split(/\s+/).map(w =>
    w.length <= 2 ? w[0] + '·' : w.slice(0, 2) + '·'.repeat(Math.min(w.length - 2, 4))
  ).join(' ');
}
function maskEmail(email) {
  const [u, d] = String(email || '').split('@');
  if (!d) return '';
  const uu = u.length <= 2 ? u[0] + '·' : u.slice(0, 2) + '·'.repeat(3);
  return `${uu}@${d}`;
}
function maskPhone(tel) {
  const digits = String(tel || '').replace(/\D/g, '');
  if (!digits) return '';
  return '·'.repeat(Math.max(0, digits.length - 3)) + digits.slice(-3);
}

// Pool de base de datos
// Soporta MYSQLHOST/MYSQLUSER/... (Railway) y DB_HOST/DB_USER/... (local)
const pool = mysql.createPool({
  host:     process.env.MYSQLHOST     || process.env.DB_HOST     || 'localhost',
  user:     process.env.MYSQLUSER     || process.env.DB_USER     || 'root',
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || process.env.DB_NAME || 'podologia_db',
  port:     parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306'),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ──────────────────────────────────────────
// AUTO-INICIALIZACIÓN DE BASE DE DATOS
// ──────────────────────────────────────────
async function waitForDatabase(maxRetries = 15, delayMs = 3000) {
  for (let intento = 1; intento <= maxRetries; intento++) {
    try {
      const conn = await pool.getConnection();
      conn.release();
      return true;
    } catch (err) {
      console.warn(`⏳ Esperando a MySQL (intento ${intento}/${maxRetries}): ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

async function initDatabase() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Conectado a MySQL');

    // Crear tablas una por una
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'doctor',
        especialidad VARCHAR(100) DEFAULT '',
        activo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
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
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS historial_clinico (
        id INT AUTO_INCREMENT PRIMARY KEY,
        paciente_id INT NOT NULL,
        tratamiento VARCHAR(150) DEFAULT '',
        diagnostico VARCHAR(500) DEFAULT '',
        observaciones LONGTEXT,
        proxima_cita DATE DEFAULT NULL,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE
      )
    `);

    await conn.execute(`
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
        FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS disponibilidad (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL DEFAULT 0,
        fecha DATE NOT NULL,
        hora TIME NOT NULL,
        duracion INT DEFAULT 30,
        estado VARCHAR(20) DEFAULT 'libre',
        cita_id INT DEFAULT NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_slot (user_id, fecha, hora),
        INDEX idx_disp_fecha (fecha)
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tratamientos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        icono VARCHAR(10) DEFAULT '💅',
        precio DECIMAL(10,2) NOT NULL DEFAULT 0,
        descripcion VARCHAR(500) DEFAULT '',
        activo BOOLEAN DEFAULT TRUE
      )
    `);

    // Poblar tratamientos solo si están vacíos
    const [[{ cnt }]] = await conn.execute('SELECT COUNT(*) AS cnt FROM tratamientos');
    if (cnt === 0) {
      const trats = [
        ['Quiropodia basica',     '💅', 15000, 'Corte y limado de unas, eliminacion de callosidades superficiales, hidratacion plantar.'],
        ['Micosis ungueal',       '🦠', 25000, 'Tratamiento de hongos en unas. Fresado, aplicacion de antimico tópico.'],
        ['Una encarnada',         '🩹', 30000, 'Onicocriptosis. Tecnica conservadora o fenolizacion segun grado.'],
        ['Plantillas ortopedicas','🦶', 80000, 'Plantillas personalizadas termoplasticas. Incluye molde y 1 ajuste.'],
        ['Pie diabetico',         '💉', 35000, 'Control integral: sensitivo, vascular, cuidado de piel y unas.'],
        ['Electroestimulacion',   '⚡', 20000, 'Terapia con corrientes para dolor plantar y fascitis plantar.'],
        ['Verruga plantar',       '🔬', 28000, 'Crioterapia o tratamiento quimico con acido salicilico.'],
        ['Estudio biomecanico',   '🏃', 50000, 'Analisis de marcha y pisada, huella plantar digital.'],
        ['Quiropodia premium',    '🌿', 25000, 'Quiropodia completa + exfoliacion, masaje, parafina y estetica.']
      ];
      for (const [nombre, icono, precio, descripcion] of trats) {
        await conn.execute(
          'INSERT INTO tratamientos (nombre, icono, precio, descripcion) VALUES (?, ?, ?, ?)',
          [nombre, icono, precio, descripcion]
        );
      }
      console.log('✅ Tratamientos insertados');
    }

    // ── MIGRACIÓN idempotente para BD ya existentes ──
    await migrateSchema(conn);

    // ── SEED del ADMIN desde variables de entorno ──
    await seedAdmin(conn);

    conn.release();
    console.log('✅ Base de datos lista');
  } catch (err) {
    console.error('❌ Error BD:', err.message);
    throw err;
  }
}

// Comprueba si una columna existe (MySQL no soporta ADD COLUMN IF NOT EXISTS)
async function columnExists(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}
async function indexExists(conn, table, index) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index]
  );
  return rows.length > 0;
}

// Lleva una BD antigua al esquema multi-especialista sin perder datos
async function migrateSchema(conn) {
  // users.especialidad / users.activo
  if (!await columnExists(conn, 'users', 'especialidad'))
    await conn.query("ALTER TABLE users ADD COLUMN especialidad VARCHAR(100) DEFAULT ''");
  if (!await columnExists(conn, 'users', 'activo'))
    await conn.query('ALTER TABLE users ADD COLUMN activo BOOLEAN DEFAULT TRUE');

  // disponibilidad.user_id + unique key por especialista
  if (!await columnExists(conn, 'disponibilidad', 'user_id')) {
    await conn.query('ALTER TABLE disponibilidad ADD COLUMN user_id INT NOT NULL DEFAULT 0');
    // Backfill: asignar los horarios existentes al primer doctor/especialista
    const [docs] = await conn.execute("SELECT id FROM users WHERE role IN ('doctor','admin') ORDER BY id LIMIT 1");
    if (docs.length) await conn.execute('UPDATE disponibilidad SET user_id = ? WHERE user_id = 0', [docs[0].id]);
    // Rehacer la clave única para que sea por (user_id, fecha, hora)
    if (await indexExists(conn, 'disponibilidad', 'uq_slot')) await conn.query('ALTER TABLE disponibilidad DROP INDEX uq_slot');
    await conn.query('ALTER TABLE disponibilidad ADD UNIQUE KEY uq_slot (user_id, fecha, hora)');
    console.log('🔧 disponibilidad migrada a multi-especialista');
  }
}

// Crea/actualiza la cuenta de administrador a partir de ADMIN_EMAIL/ADMIN_PASSWORD
async function seedAdmin(conn) {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = process.env.ADMIN_NAME || 'Administrador';
  if (!email || !password) {
    console.warn('ℹ️  ADMIN_EMAIL/ADMIN_PASSWORD no definidos: no se creó admin automático.');
    return;
  }
  if (!EMAIL_RE.test(email)) { console.warn('⚠️  ADMIN_EMAIL inválido, se omite seed de admin.'); return; }
  const hash = await bcrypt.hash(password, 10);
  const [rows] = await conn.execute('SELECT id, role FROM users WHERE email = ?', [email]);
  if (rows.length) {
    // Mantener su contraseña sincronizada con la env y asegurar rol admin
    await conn.execute("UPDATE users SET password = ?, role = 'admin', name = ? WHERE id = ?", [hash, name, rows[0].id]);
    console.log(`✅ Admin actualizado (${email})`);
  } else {
    await conn.execute("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')", [name, email, hash]);
    console.log(`✅ Admin creado (${email})`);
  }
}

// ──────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ──────────────────────────────────────────
// MIDDLEWARE DE AUTENTICACIÓN
// ──────────────────────────────────────────

// Verifica cualquier token JWT válido
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token inválido' });
    req.userId = decoded.id;
    req.userName = decoded.name;
    req.userRole = decoded.role || 'patient';
    next();
  });
};

// Exige uno de los roles indicados (se usa tras verifyToken)
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.userRole)) {
    return res.status(403).json({ error: 'Acceso solo para profesionales' });
  }
  next();
};

// Solo médicos/admin: verifica token Y rol
const verifyDoctor = [verifyToken, requireRole('doctor', 'admin')];

// Solo administrador
const verifyAdmin = [verifyToken, requireRole('admin')];

// ──────────────────────────────────────────
// RUTAS DE AUTENTICACIÓN
// ──────────────────────────────────────────

// Login (pacientes Y médicos)
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Contraseña inválida' });
    if (!EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Email inválido' });

    const conn = await pool.getConnection();
    const [users] = await conn.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    conn.release();

    if (!users.length) return res.status(401).json({ error: 'Email o contraseña inválidos' });

    const user = users[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Email o contraseña inválidos' });

    const role = user.role || 'patient';
    const token = jwt.sign({ id: user.id, name: user.name, role }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Registro público: SIEMPRE crea pacientes.
// Para crear un médico hay que enviar la cabecera 'x-setup-token' con el valor
// de SETUP_TOKEN (solo lo conoce el administrador). Esto evita que cualquiera
// se auto-asigne rol 'doctor' y vea a todos los pacientes de la clínica.
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
    if (!EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Email inválido' });
    if (String(name).trim().length > 100) return res.status(400).json({ error: 'Nombre demasiado largo' });

    // Solo se concede rol 'doctor' si se presenta el token de setup correcto.
    let userRole = 'patient';
    if (role === 'doctor') {
      const setupToken = req.headers['x-setup-token'];
      if (!process.env.SETUP_TOKEN || setupToken !== process.env.SETUP_TOKEN) {
        return res.status(403).json({ error: 'No autorizado para crear cuentas de profesional' });
      }
      userRole = 'doctor';
    }

    const conn = await pool.getConnection();
    const [existing] = await conn.execute('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing.length) { conn.release(); return res.status(400).json({ error: 'El email ya está registrado' }); }

    const hash = await bcrypt.hash(password, 10);

    await conn.execute(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name.trim(), email.toLowerCase().trim(), hash, userRole]
    );
    conn.release();
    res.json({ success: true, message: 'Usuario registrado correctamente' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS PÚBLICAS (sin login) — agendamiento de pacientes
// ──────────────────────────────────────────

// Lista pública de especialistas activos
app.get('/api/public/especialistas', publicLimiter, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.execute(
      "SELECT id, name, especialidad FROM users WHERE role = 'doctor' AND activo = 1 ORDER BY name"
    );
    conn.release();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fechas (del rango/mes) que tienen al menos un horario libre — para el calendario
app.get('/api/public/dias-disponibles', publicLimiter, async (req, res) => {
  try {
    const { desde, hasta, especialista } = req.query;
    const conn = await pool.getConnection();
    let q = "SELECT DISTINCT fecha FROM disponibilidad WHERE estado = 'libre' AND fecha >= CURDATE()";
    const params = [];
    if (especialista) { q += ' AND user_id = ?'; params.push(especialista); }
    if (desde) { q += ' AND fecha >= ?'; params.push(desde); }
    if (hasta) { q += ' AND fecha <= ?'; params.push(hasta); }
    q += ' ORDER BY fecha';
    const [rows] = await conn.execute(q, params);
    conn.release();
    res.json(rows.map(r => (r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha).slice(0, 10))));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agenda de una fecha: cada especialista con sus horarios libres
app.get('/api/public/agenda', publicLimiter, async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });
    const conn = await pool.getConnection();
    const [rows] = await conn.execute(
      `SELECT d.user_id, u.name, u.especialidad, d.hora, d.duracion
       FROM disponibilidad d
       JOIN users u ON d.user_id = u.id
       WHERE d.fecha = ? AND d.estado = 'libre' AND u.role = 'doctor' AND u.activo = 1
       ORDER BY u.name, d.hora`,
      [fecha]
    );
    conn.release();
    // Agrupar por especialista
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.user_id)) map.set(r.user_id, { id: r.user_id, name: r.name, especialidad: r.especialidad, slots: [] });
      map.get(r.user_id).slots.push({ hora: String(r.hora).slice(0, 5), duracion: r.duracion });
    }
    res.json([...map.values()]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Consulta de paciente por RUT (datos OFUSCADOS). Sirve para autocompletar.
app.get('/api/public/paciente', publicLimiter, async (req, res) => {
  try {
    const rut = normalizeRut(req.query.rut);
    if (!rut || rut.length < 7) return res.status(400).json({ error: 'RUT inválido' });
    const conn = await pool.getConnection();
    const [rows] = await conn.execute(
      "SELECT nombre, email, telefono FROM pacientes WHERE REPLACE(REPLACE(REPLACE(LOWER(rut),'.',''),'-',''),' ','') = ? LIMIT 1",
      [rut]
    );
    conn.release();
    if (!rows.length) return res.json({ exists: false });
    const p = rows[0];
    res.json({
      exists: true,
      nombre_masked: maskName(p.nombre),
      email_masked: maskEmail(p.email),
      telefono_masked: maskPhone(p.telefono)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agendar cita SIN login. Reserva un horario disponibilizado por el médico.
app.post('/api/public/citas', publicLimiter, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { rut, nombre, telefono, email, fecha, hora, tratamiento, notas } = req.body;
    const especialistaId = parseInt(req.body.especialista_id);
    if (!rut || !fecha || !hora || !especialistaId) return res.status(400).json({ error: 'RUT, especialista, fecha y hora son requeridos' });
    const rutNorm = normalizeRut(rut);
    if (rutNorm.length < 7) return res.status(400).json({ error: 'RUT inválido' });
    if (email && !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Email inválido' });

    await conn.beginTransaction();

    // 1) El horario del especialista debe existir y estar libre (bloqueo anti doble reserva)
    const [slots] = await conn.execute(
      "SELECT id, duracion FROM disponibilidad WHERE user_id = ? AND fecha = ? AND hora = ? AND estado = 'libre' FOR UPDATE",
      [especialistaId, fecha, hora]
    );
    if (!slots.length) {
      await conn.rollback(); conn.release();
      return res.status(409).json({ error: 'Ese horario ya no está disponible. Elige otro.' });
    }
    const slot = slots[0];

    // 2) Buscar paciente por RUT; si no existe, crearlo
    const [pac] = await conn.execute(
      "SELECT id FROM pacientes WHERE REPLACE(REPLACE(REPLACE(LOWER(rut),'.',''),'-',''),' ','') = ? LIMIT 1",
      [rutNorm]
    );
    let pacienteId;
    if (pac.length) {
      pacienteId = pac[0].id;
    } else {
      if (!nombre) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Nombre requerido para nuevo paciente' }); }
      const [ins] = await conn.execute(
        `INSERT INTO pacientes (user_id, nombre, rut, email, telefono, estado, fecha_registro)
         VALUES (?, ?, ?, ?, ?, 'Activo', NOW())`,
        [especialistaId, String(nombre).trim(), String(rut).trim(), email || '', telefono || '']
      );
      pacienteId = ins.insertId;
    }

    // 3) Crear la cita asignada al especialista elegido (Pendiente de confirmación)
    const [citaIns] = await conn.execute(
      `INSERT INTO citas (user_id, paciente_id, fecha, hora, duracion, tratamiento, notas, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pendiente')`,
      [especialistaId, pacienteId, fecha, hora, slot.duracion || 30, tratamiento || '', notas || '']
    );

    // 4) Marcar el horario como reservado
    await conn.execute(
      "UPDATE disponibilidad SET estado = 'reservada', cita_id = ? WHERE id = ?",
      [citaIns.insertId, slot.id]
    );

    await conn.commit();
    conn.release();
    res.json({ success: true, message: 'Cita agendada. Queda pendiente de confirmación.' });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    conn.release();
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS DE PACIENTES
// ──────────────────────────────────────────

// GET pacientes — doctor/admin ve TODOS; paciente solo el propio
app.get('/api/pacientes', verifyToken, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    let pacientes;
    if (req.userRole === 'doctor' || req.userRole === 'admin') {
      // Todos los médicos ven todos los pacientes de la clínica
      [pacientes] = await conn.execute(
        'SELECT * FROM pacientes ORDER BY fecha_registro DESC'
      );
    } else {
      [pacientes] = await conn.execute(
        'SELECT * FROM pacientes WHERE email = (SELECT email FROM users WHERE id = ?) ORDER BY fecha_registro DESC',
        [req.userId]
      );
    }
    conn.release();
    res.json(pacientes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pacientes', verifyToken, async (req, res) => {
  try {
    const { nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado } = req.body;
    if (!nombre || !rut) return res.status(400).json({ error: 'Nombre y RUT son requeridos' });

    const conn = await pool.getConnection();

    // Owner compartido: siempre se asigna al primer doctor de la clínica
    // para que todos los médicos vean al paciente
    let ownerId = req.userId;
    if (req.userRole === 'patient') {
      const [doctors] = await conn.execute("SELECT id FROM users WHERE role = 'doctor' ORDER BY id LIMIT 1");
      ownerId = doctors.length ? doctors[0].id : req.userId;
    }

    // Verificar si el RUT ya existe globalmente (sin importar el doctor)
    const [existing] = await conn.execute(
      'SELECT id FROM pacientes WHERE rut = ?',
      [rut]
    );

    let pacienteId;
    if (existing.length) {
      pacienteId = existing[0].id;
      conn.release();
    } else {
      const [result] = await conn.execute(
        `INSERT INTO pacientes (user_id, nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado, fecha_registro)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [ownerId, nombre, rut, edad || 0, email || '', telefono || '', direccion || '', alergias || '', diagnostico || '', estado || 'Activo']
      );
      conn.release();
      pacienteId = result.insertId;
    }

    res.json({ success: true, id: pacienteId, message: 'Paciente registrado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/pacientes/:id', verifyDoctor, async (req, res) => {
  try {
    const { nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado } = req.body;
    const conn = await pool.getConnection();
    await conn.execute(
      `UPDATE pacientes SET nombre=?, rut=?, edad=?, email=?, telefono=?, direccion=?, alergias=?, diagnostico=?, estado=?
       WHERE id=?`,
      [nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado, req.params.id]
    );
    conn.release();
    res.json({ success: true, message: 'Paciente actualizado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/pacientes/:id', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.execute('DELETE FROM pacientes WHERE id=?', [req.params.id]);
    conn.release();
    res.json({ success: true, message: 'Paciente eliminado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear o actualizar la CUENTA DE ACCESO (login) de un paciente.
// El médico le asigna email + contraseña; el paciente queda vinculado por email
// y puede iniciar sesión para ver sus citas y agendar nuevas.
app.post('/api/pacientes/:id/cuenta', verifyDoctor, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });

    const conn = await pool.getConnection();
    const [pacs] = await conn.execute('SELECT id, nombre, email FROM pacientes WHERE id = ?', [req.params.id]);
    if (!pacs.length) { conn.release(); return res.status(404).json({ error: 'Paciente no encontrado' }); }
    const pac = pacs[0];

    // Email de la cuenta: el indicado, o el que ya tiene el paciente
    const cuentaEmail = String(email || pac.email || '').toLowerCase().trim();
    if (!EMAIL_RE.test(cuentaEmail)) { conn.release(); return res.status(400).json({ error: 'El paciente necesita un email válido para la cuenta' }); }

    const hash = await bcrypt.hash(String(password), 10);
    const [users] = await conn.execute('SELECT id, role FROM users WHERE email = ?', [cuentaEmail]);

    if (users.length) {
      // Ya existe una cuenta con ese email: solo se permite resetear si es paciente
      if (users[0].role !== 'patient') { conn.release(); return res.status(409).json({ error: 'Ese email pertenece a una cuenta de profesional' }); }
      await conn.execute('UPDATE users SET password = ? WHERE id = ?', [hash, users[0].id]);
    } else {
      await conn.execute(
        "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'patient')",
        [pac.nombre, cuentaEmail, hash]
      );
    }

    // Asegura que el email del paciente coincida con el de su cuenta (vínculo)
    if (cuentaEmail !== String(pac.email || '').toLowerCase().trim()) {
      await conn.execute('UPDATE pacientes SET email = ? WHERE id = ?', [cuentaEmail, pac.id]);
    }
    conn.release();
    res.json({ success: true, message: 'Cuenta de paciente lista', email: cuentaEmail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS DE DISPONIBILIDAD (admin) — disponibilizar agenda
// ──────────────────────────────────────────

// Resuelve a qué especialista pertenece la operación de disponibilidad.
// Un especialista (doctor) siempre opera sobre sí mismo; el admin debe indicar
// especialista_id (en body o query).
function resolveEspecialista(req) {
  if (req.userRole === 'doctor') return req.userId;
  const raw = req.body?.especialista_id ?? req.query?.especialista_id;
  const id = parseInt(raw);
  return id || null;
}

// Generador rápido: crea slots para una fecha entre inicio y fin cada N minutos
app.post('/api/disponibilidad/generar', verifyDoctor, async (req, res) => {
  try {
    const ownerId = resolveEspecialista(req);
    if (!ownerId) return res.status(400).json({ error: 'Selecciona un especialista' });
    const { fecha, inicio, fin, intervalo, duracion } = req.body;
    if (!fecha || !inicio || !fin) return res.status(400).json({ error: 'Fecha, inicio y fin son requeridos' });
    const step = parseInt(intervalo) || 30;
    const dur = parseInt(duracion) || step;
    if (step < 5 || step > 240) return res.status(400).json({ error: 'Intervalo fuera de rango' });

    const toMin = h => { const [hh, mm] = String(h).split(':').map(Number); return hh * 60 + mm; };
    const start = toMin(inicio), end = toMin(fin);
    if (isNaN(start) || isNaN(end) || end <= start) return res.status(400).json({ error: 'Rango horario inválido' });
    if ((end - start) / step > 100) return res.status(400).json({ error: 'Demasiados horarios; reduce el rango o aumenta el intervalo' });

    const conn = await pool.getConnection();
    let creados = 0;
    for (let m = start; m < end; m += step) {
      const hora = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
      // INSERT IGNORE para no duplicar (UNIQUE user_id+fecha+hora)
      const [r] = await conn.execute(
        "INSERT IGNORE INTO disponibilidad (user_id, fecha, hora, duracion, estado) VALUES (?, ?, ?, ?, 'libre')",
        [ownerId, fecha, hora, dur]
      );
      if (r.affectedRows) creados++;
    }
    conn.release();
    res.json({ success: true, creados, message: `${creados} horario(s) habilitado(s)` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista todos los slots de una fecha (libres y reservados) para el panel admin
app.get('/api/disponibilidad', verifyDoctor, async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });
    const conn = await pool.getConnection();
    // doctor → solo sus horarios; admin → todos (o filtrado por especialista_id)
    const params = [fecha];
    let where = 'd.fecha = ?';
    if (req.userRole === 'doctor') { where += ' AND d.user_id = ?'; params.push(req.userId); }
    else if (req.query.especialista_id) { where += ' AND d.user_id = ?'; params.push(parseInt(req.query.especialista_id)); }
    const [rows] = await conn.execute(
      `SELECT d.id, d.user_id, u.name AS especialista_nombre, d.hora, d.duracion, d.estado, d.cita_id,
              p.nombre AS paciente_nombre
       FROM disponibilidad d
       JOIN users u ON d.user_id = u.id
       LEFT JOIN citas c ON d.cita_id = c.id
       LEFT JOIN pacientes p ON c.paciente_id = p.id
       WHERE ${where} ORDER BY u.name, d.hora`,
      params
    );
    conn.release();
    res.json(rows.map(r => ({ ...r, hora: String(r.hora).slice(0, 5) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Eliminar un slot (solo si está libre; el doctor solo los suyos)
app.delete('/api/disponibilidad/:id', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    let q = "DELETE FROM disponibilidad WHERE id = ? AND estado = 'libre'";
    const params = [req.params.id];
    if (req.userRole === 'doctor') { q += ' AND user_id = ?'; params.push(req.userId); }
    const [r] = await conn.execute(q, params);
    conn.release();
    if (!r.affectedRows) return res.status(409).json({ error: 'No se puede borrar: reservado o no es tuyo' });
    res.json({ success: true, message: 'Horario eliminado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS DE ESPECIALISTAS (gestión)
// ──────────────────────────────────────────

// Listar especialistas — disponible para admin y especialistas (selectores)
app.get('/api/especialistas', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.execute(
      "SELECT id, name, email, especialidad, activo FROM users WHERE role = 'doctor' ORDER BY name"
    );
    conn.release();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear especialista — SOLO admin
app.post('/api/especialistas', verifyAdmin, async (req, res) => {
  try {
    const { name, email, password, especialidad } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
    if (!EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Email inválido' });

    const conn = await pool.getConnection();
    const [exist] = await conn.execute('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (exist.length) { conn.release(); return res.status(400).json({ error: 'El email ya está registrado' }); }
    const hash = await bcrypt.hash(String(password), 10);
    const [r] = await conn.execute(
      "INSERT INTO users (name, email, password, role, especialidad) VALUES (?, ?, ?, 'doctor', ?)",
      [String(name).trim(), email.toLowerCase().trim(), hash, especialidad || '']
    );
    conn.release();
    res.json({ success: true, id: r.insertId, message: 'Especialista creado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Editar especialista (nombre, especialidad, activo, opcional password) — SOLO admin
app.put('/api/especialistas/:id', verifyAdmin, async (req, res) => {
  try {
    const { name, especialidad, activo, password } = req.body;
    const conn = await pool.getConnection();
    const [docs] = await conn.execute("SELECT id FROM users WHERE id = ? AND role = 'doctor'", [req.params.id]);
    if (!docs.length) { conn.release(); return res.status(404).json({ error: 'Especialista no encontrado' }); }

    const fields = [], values = [];
    if (name !== undefined)         { fields.push('name = ?');         values.push(String(name).trim()); }
    if (especialidad !== undefined) { fields.push('especialidad = ?'); values.push(especialidad || ''); }
    if (activo !== undefined)       { fields.push('activo = ?');       values.push(activo ? 1 : 0); }
    if (password) {
      if (String(password).length < 6) { conn.release(); return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' }); }
      fields.push('password = ?'); values.push(await bcrypt.hash(String(password), 10));
    }
    if (!fields.length) { conn.release(); return res.status(400).json({ error: 'Sin cambios' }); }
    values.push(req.params.id);
    await conn.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    conn.release();
    res.json({ success: true, message: 'Especialista actualizado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS DE HISTORIAL CLÍNICO
// ──────────────────────────────────────────

app.get('/api/historial/:pacienteId', verifyToken, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [historial] = await conn.execute(
      `SELECT h.* FROM historial_clinico h
       JOIN pacientes p ON h.paciente_id = p.id
       WHERE h.paciente_id = ?
       ORDER BY h.fecha DESC`,
      [req.params.pacienteId]
    );
    conn.release();
    res.json(historial);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/historial', verifyToken, async (req, res) => {
  try {
    const { paciente_id, tratamiento, diagnostico, observaciones, proxima_cita } = req.body;
    if (!paciente_id) return res.status(400).json({ error: 'Paciente ID es requerido' });

    const conn = await pool.getConnection();
    const [result] = await conn.execute(
      `INSERT INTO historial_clinico (paciente_id, tratamiento, diagnostico, observaciones, proxima_cita, fecha)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [paciente_id, tratamiento || '', diagnostico || '', observaciones || '', proxima_cita || null]
    );
    conn.release();
    res.json({ success: true, id: result.insertId, message: 'Entrada guardada' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS DE CITAS
// ──────────────────────────────────────────

// GET citas — admin ve TODAS; especialista ve solo las suyas; paciente las propias
app.get('/api/citas', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    const conn = await pool.getConnection();
    const params = [];
    let query = `SELECT c.*, p.nombre AS paciente_nombre, p.rut AS paciente_rut, p.telefono AS paciente_telefono,
                        u.name AS especialista_nombre
                 FROM citas c
                 JOIN pacientes p ON c.paciente_id = p.id
                 LEFT JOIN users u ON c.user_id = u.id
                 WHERE 1=1`;

    if (req.userRole === 'patient') {
      // Paciente: ver solo sus propias citas por email
      query += ' AND p.email = (SELECT email FROM users WHERE id = ?)';
      params.push(req.userId);
    } else if (req.userRole === 'doctor') {
      // Especialista: solo sus propias citas
      query += ' AND c.user_id = ?';
      params.push(req.userId);
    }
    // Admin: ve todas (sin filtro adicional)

    if (fecha) { query += ' AND c.fecha = ?'; params.push(fecha); }
    query += ' ORDER BY c.fecha DESC, c.hora';

    const [citas] = await conn.execute(query, params);
    conn.release();
    res.json(citas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST cita — cualquier usuario autenticado puede agendar
app.post('/api/citas', verifyToken, async (req, res) => {
  try {
    const { paciente_id, fecha, hora, duracion, tratamiento, notas, estado } = req.body;
    if (!paciente_id || !fecha || !hora) return res.status(400).json({ error: 'Paciente, fecha y hora son requeridos' });

    const conn = await pool.getConnection();

    // Verificar que el horario no esté tomado
    const [existing] = await conn.execute(
      "SELECT id FROM citas WHERE fecha = ? AND hora = ? AND estado != 'Cancelada'",
      [fecha, hora]
    );
    if (existing.length) {
      conn.release();
      return res.status(409).json({ error: 'Ese horario ya está ocupado. Elige otro.' });
    }

    // Owner: si es paciente, asignar al primer doctor de la clínica
    // Si es doctor, se asigna a sí mismo
    let ownerId = req.userId;
    let citaEstado = estado || 'Confirmada';
    if (req.userRole === 'patient') {
      const [doctors] = await conn.execute("SELECT id FROM users WHERE role = 'doctor' ORDER BY id LIMIT 1");
      ownerId = doctors.length ? doctors[0].id : req.userId;
      citaEstado = 'Pendiente'; // Citas de pacientes quedan pendientes de confirmación
    }

    const [result] = await conn.execute(
      `INSERT INTO citas (user_id, paciente_id, fecha, hora, duracion, tratamiento, notas, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ownerId, paciente_id, fecha, hora, duracion || 30, tratamiento || '', notas || '', citaEstado]
    );
    conn.release();
    res.json({ success: true, id: result.insertId, message: 'Cita creada correctamente' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT cita (actualizar estado, etc.)
app.put('/api/citas/:id', verifyToken, async (req, res) => {
  try {
    const { estado, hora, duracion, tratamiento, notas, fecha } = req.body;
    const conn = await pool.getConnection();
    const fields = [], values = [];

    if (estado !== undefined)     { fields.push('estado = ?');     values.push(estado); }
    if (hora !== undefined)       { fields.push('hora = ?');       values.push(hora); }
    if (fecha !== undefined)      { fields.push('fecha = ?');      values.push(fecha); }
    if (duracion !== undefined)   { fields.push('duracion = ?');   values.push(duracion); }
    if (tratamiento !== undefined){ fields.push('tratamiento = ?');values.push(tratamiento || ''); }
    if (notas !== undefined)      { fields.push('notas = ?');      values.push(notas || ''); }

    if (!fields.length) { conn.release(); return res.status(400).json({ error: 'Sin campos para actualizar' }); }

    values.push(req.params.id);

    // Paciente solo puede cancelar sus propias citas
    if (req.userRole === 'patient') {
      values.push(req.userId);
      await conn.execute(
        `UPDATE citas SET ${fields.join(', ')} WHERE id = ? AND paciente_id IN
         (SELECT id FROM pacientes WHERE email = (SELECT email FROM users WHERE id = ?))`,
        [...values]
      );
    } else {
      // Doctores pueden actualizar cualquier cita de la clínica
      await conn.execute(
        `UPDATE citas SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
    }

    // Si se canceló la cita, el horario vuelve a quedar libre
    if (estado === 'Cancelada') {
      await conn.execute(
        "UPDATE disponibilidad SET estado = 'libre', cita_id = NULL WHERE cita_id = ?",
        [req.params.id]
      );
    }

    conn.release();
    res.json({ success: true, message: 'Cita actualizada' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/citas/:id', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    // Liberar el horario asociado antes de borrar la cita
    await conn.execute(
      "UPDATE disponibilidad SET estado = 'libre', cita_id = NULL WHERE cita_id = ?",
      [req.params.id]
    );
    await conn.execute('DELETE FROM citas WHERE id = ?', [req.params.id]);
    conn.release();
    res.json({ success: true, message: 'Cita eliminada' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS DE TRATAMIENTOS
// ──────────────────────────────────────────

app.get('/api/tratamientos', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [tratamientos] = await conn.execute('SELECT * FROM tratamientos WHERE activo = 1 ORDER BY id');
    conn.release();
    res.json(tratamientos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS ADICIONALES PARA EL PORTAL MÉDICO
// ──────────────────────────────────────────

// Dashboard stats para el médico (cuenta toda la clínica)
app.get('/api/stats', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [[{ totalPacientes }]] = await conn.execute(
      'SELECT COUNT(*) AS totalPacientes FROM pacientes'
    );
    const [[{ totalHistorial }]] = await conn.execute(
      'SELECT COUNT(*) AS totalHistorial FROM historial_clinico'
    );
    const [[{ activos }]] = await conn.execute(
      "SELECT COUNT(*) AS activos FROM pacientes WHERE estado = 'Activo'"
    );
    const [[{ seguimientos }]] = await conn.execute(
      "SELECT COUNT(*) AS seguimientos FROM pacientes WHERE estado = 'Seguimiento'"
    );
    const today = new Date().toISOString().split('T')[0];
    // Especialista: solo sus citas de hoy; admin: toda la clínica
    let citasHoy;
    if (req.userRole === 'doctor') {
      [[{ citasHoy }]] = await conn.execute(
        "SELECT COUNT(*) AS citasHoy FROM citas WHERE fecha = ? AND estado != 'Cancelada' AND user_id = ?",
        [today, req.userId]
      );
    } else {
      [[{ citasHoy }]] = await conn.execute(
        "SELECT COUNT(*) AS citasHoy FROM citas WHERE fecha = ? AND estado != 'Cancelada'",
        [today]
      );
    }
    conn.release();
    res.json({ totalPacientes, totalHistorial, activos, seguimientos, citasHoy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint para que el portal de pacientes obtenga el ID del médico de la clínica
app.get('/api/clinic', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [doctors] = await conn.execute("SELECT id, name FROM users WHERE role = 'doctor' ORDER BY id LIMIT 1");
    conn.release();
    if (!doctors.length) return res.status(404).json({ error: 'No hay médicos registrados' });
    res.json({ doctorId: doctors[0].id, doctorName: doctors[0].name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Página principal = PORTAL DE PACIENTES
app.get(['/', '/pacientes'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal-pacientes.html'));
});

// Panel médico (privado) en /medico
app.get(['/medico', '/admin'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────

async function startServer() {
  const dbLista = await waitForDatabase();
  if (!dbLista) {
    console.error('❌ No se pudo conectar a MySQL tras varios intentos. Abortando arranque.');
    process.exit(1);
  }
  await initDatabase();

  app.listen(PORT, () => {
    console.log(`🦶 PodoClinic corriendo en http://localhost:${PORT}`);
    console.log(`👩‍⚕️  Panel médico:     http://localhost:${PORT}/`);
    console.log(`🙋  Portal pacientes: http://localhost:${PORT}/pacientes`);
    console.log(`📊  Base de datos:    ${process.env.DB_NAME || 'podologia_db'}`);
  });
}

startServer();
