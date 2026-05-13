const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');
require('dotenv').config();

const app        = express();
const PORT       = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'podoclinic_secreto_2026';

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.url.endsWith('.html')) res.type('text/html; charset=utf-8');
  next();
});
app.use(express.static(path.join(__dirname)));

// ─── Pool MySQL ───────────────────────────────────────────────
// Railway inyecta MYSQLHOST, MYSQLUSER, MYSQLPASSWORD, MYSQL_DATABASE, MYSQLPORT
// automaticamente cuando agregas el plugin MySQL al proyecto.
const pool = mysql.createPool({
  host:     process.env.MYSQLHOST     || process.env.DB_HOST     || 'localhost',
  user:     process.env.MYSQLUSER     || process.env.DB_USER     || 'root',
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.MYSQL_DATABASE|| process.env.DB_NAME     || 'railway',
  port:     parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306'),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── AUTO-INIT BASE DE DATOS ──────────────────────────────────
async function initDatabase() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Conectado a MySQL');

    // Crear tablas una por una (sin semicolons en execute)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'doctor',
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
      CREATE TABLE IF NOT EXISTS tratamientos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        icono VARCHAR(10) DEFAULT '💅',
        precio DECIMAL(10,2) NOT NULL DEFAULT 0,
        descripcion VARCHAR(500) DEFAULT '',
        activo BOOLEAN DEFAULT TRUE
      )
    `);

    await conn.execute(`
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
        FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE
      )
    `);

    // Migracion: agregar columna role si no existe
    try {
      await conn.execute("ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'doctor'");
    } catch (e) { /* ya existe, ok */ }

    // Poblar tratamientos solo si estan vacios
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

    conn.release();
    console.log('✅ Base de datos lista');
  } catch (err) {
    console.error('❌ Error BD:', err.message);
  }
}

initDatabase();

// ─── Health ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Auth Middleware ──────────────────────────────────────────
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token inválido o expirado' });
    req.userId   = decoded.id;
    req.userName = decoded.name;
    req.userRole = decoded.role || 'doctor';
    next();
  });
};

const verifyDoctor = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token inválido' });
    if (decoded.role !== 'doctor' && decoded.role !== 'admin')
      return res.status(403).json({ error: 'Acceso solo para profesionales' });
    req.userId   = decoded.id;
    req.userName = decoded.name;
    req.userRole = decoded.role;
    next();
  });
};

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const conn = await pool.getConnection();
    const [users] = await conn.execute(
      'SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]
    );
    conn.release();

    if (!users.length)
      return res.status(401).json({ error: 'Email o contraseña inválidos' });

    const user  = users[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ error: 'Email o contraseña inválidos' });

    const role  = user.role || 'doctor';
    const token = jwt.sign({ id: user.id, name: user.name, role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role } });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    if (password.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const conn = await pool.getConnection();
    const [existing] = await conn.execute(
      'SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]
    );
    if (existing.length) {
      conn.release();
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    const hash     = await bcrypt.hash(password, 10);
    const userRole = (role === 'admin') ? 'admin' : 'doctor';

    const [result] = await conn.execute(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name.trim(), email.toLowerCase().trim(), hash, userRole]
    );
    conn.release();
    res.status(201).json({ success: true, message: 'Usuario registrado correctamente', id: result.insertId });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PACIENTES
// ══════════════════════════════════════════════════════════════

app.get('/api/pacientes', verifyToken, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    let pacientes;
    if (req.userRole === 'doctor' || req.userRole === 'admin') {
      [pacientes] = await conn.execute(
        'SELECT * FROM pacientes WHERE user_id = ? ORDER BY fecha_registro DESC', [req.userId]
      );
    } else {
      [pacientes] = await conn.execute(
        'SELECT * FROM pacientes WHERE email = (SELECT email FROM users WHERE id = ?) ORDER BY fecha_registro DESC',
        [req.userId]
      );
    }
    conn.release();
    res.json(pacientes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pacientes', verifyToken, async (req, res) => {
  try {
    const { nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado } = req.body;
    if (!nombre || !rut) return res.status(400).json({ error: 'Nombre y RUT son requeridos' });

    const conn = await pool.getConnection();
    const [existing] = await conn.execute(
      'SELECT id FROM pacientes WHERE rut = ? AND user_id = ?', [rut, req.userId]
    );
    if (existing.length) {
      conn.release();
      return res.status(400).json({ error: 'Ya existe un paciente con ese RUT' });
    }
    const [result] = await conn.execute(
      `INSERT INTO pacientes (user_id, nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado, fecha_registro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [req.userId, nombre, rut, edad || 0, email || '', telefono || '', direccion || '', alergias || '', diagnostico || '', estado || 'Activo']
    );
    conn.release();
    res.status(201).json({ success: true, id: result.insertId, message: 'Paciente registrado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/pacientes/:id', verifyDoctor, async (req, res) => {
  try {
    const { nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado } = req.body;
    const conn = await pool.getConnection();
    await conn.execute(
      `UPDATE pacientes SET nombre=?, rut=?, edad=?, email=?, telefono=?, direccion=?, alergias=?, diagnostico=?, estado=?
       WHERE id=? AND user_id=?`,
      [nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado, req.params.id, req.userId]
    );
    conn.release();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pacientes/:id', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.execute('DELETE FROM pacientes WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    conn.release();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// HISTORIAL
// ══════════════════════════════════════════════════════════════

app.get('/api/historial/:pacienteId', verifyToken, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [h] = await conn.execute(
      'SELECT * FROM historial_clinico WHERE paciente_id = ? ORDER BY fecha DESC',
      [req.params.pacienteId]
    );
    conn.release();
    res.json(h);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/historial', verifyToken, async (req, res) => {
  try {
    const { paciente_id, tratamiento, diagnostico, observaciones, proxima_cita } = req.body;
    if (!paciente_id) return res.status(400).json({ error: 'Paciente ID requerido' });
    const conn = await pool.getConnection();
    const [r] = await conn.execute(
      `INSERT INTO historial_clinico (paciente_id, tratamiento, diagnostico, observaciones, proxima_cita, fecha)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [paciente_id, tratamiento || '', diagnostico || '', observaciones || '', proxima_cita || null]
    );
    conn.release();
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// CITAS
// ══════════════════════════════════════════════════════════════

app.get('/api/citas', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    const conn = await pool.getConnection();
    const params = [];
    let q = `SELECT c.*, p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
             FROM citas c JOIN pacientes p ON c.paciente_id = p.id WHERE `;
    if (req.userRole === 'doctor' || req.userRole === 'admin') {
      q += 'c.user_id = ?'; params.push(req.userId);
    } else {
      q += 'p.email = (SELECT email FROM users WHERE id = ?)'; params.push(req.userId);
    }
    if (fecha) { q += ' AND c.fecha = ?'; params.push(fecha); }
    q += ' ORDER BY c.fecha DESC, c.hora';
    const [citas] = await conn.execute(q, params);
    conn.release();
    res.json(citas);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/citas', verifyToken, async (req, res) => {
  try {
    const { paciente_id, fecha, hora, duracion, tratamiento, notas, estado } = req.body;
    if (!paciente_id || !fecha || !hora)
      return res.status(400).json({ error: 'Paciente, fecha y hora son requeridos' });
    const conn = await pool.getConnection();
    const [c] = await conn.execute(
      "SELECT id FROM citas WHERE fecha=? AND hora=? AND estado != 'Cancelada'", [fecha, hora]
    );
    if (c.length) { conn.release(); return res.status(409).json({ error: 'Horario ocupado. Elige otro.' }); }
    const [r] = await conn.execute(
      `INSERT INTO citas (user_id, paciente_id, fecha, hora, duracion, tratamiento, notas, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, paciente_id, fecha, hora, duracion || 30, tratamiento || '', notas || '', estado || 'Pendiente']
    );
    conn.release();
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/citas/:id', verifyToken, async (req, res) => {
  try {
    const { estado, hora, duracion, tratamiento, notas, fecha } = req.body;
    const fields = [], values = [];
    if (estado !== undefined)      { fields.push('estado=?');      values.push(estado); }
    if (hora !== undefined)        { fields.push('hora=?');        values.push(hora); }
    if (fecha !== undefined)       { fields.push('fecha=?');       values.push(fecha); }
    if (duracion !== undefined)    { fields.push('duracion=?');    values.push(duracion); }
    if (tratamiento !== undefined) { fields.push('tratamiento=?'); values.push(tratamiento||''); }
    if (notas !== undefined)       { fields.push('notas=?');       values.push(notas||''); }
    if (!fields.length) return res.status(400).json({ error: 'Sin campos' });
    values.push(req.params.id, req.userId);
    const conn = await pool.getConnection();
    await conn.execute(`UPDATE citas SET ${fields.join(',')} WHERE id=? AND user_id=?`, values);
    conn.release();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/citas/:id', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.execute('DELETE FROM citas WHERE user_id=? AND id=?', [req.userId, req.params.id]);
    conn.release();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// TRATAMIENTOS & STATS
// ══════════════════════════════════════════════════════════════

app.get('/api/tratamientos', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [t] = await conn.execute('SELECT * FROM tratamientos WHERE activo=1 ORDER BY id');
    conn.release();
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', verifyDoctor, async (req, res) => {
  try {
    const conn  = await pool.getConnection();
    const today = new Date().toISOString().split('T')[0];
    const [[{ totalPacientes }]] = await conn.execute('SELECT COUNT(*) AS totalPacientes FROM pacientes WHERE user_id=?', [req.userId]);
    const [[{ totalHistorial }]] = await conn.execute(`SELECT COUNT(*) AS totalHistorial FROM historial_clinico h JOIN pacientes p ON h.paciente_id=p.id WHERE p.user_id=?`, [req.userId]);
    const [[{ activos }]]        = await conn.execute("SELECT COUNT(*) AS activos FROM pacientes WHERE user_id=? AND estado='Activo'", [req.userId]);
    const [[{ seguimientos }]]   = await conn.execute("SELECT COUNT(*) AS seguimientos FROM pacientes WHERE user_id=? AND estado='Seguimiento'", [req.userId]);
    const [[{ citasHoy }]]       = await conn.execute("SELECT COUNT(*) AS citasHoy FROM citas WHERE user_id=? AND fecha=? AND estado!='Cancelada'", [req.userId, today]);
    conn.release();
    res.json({ totalPacientes, totalHistorial, activos, seguimientos, citasHoy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// SETUP-DB (llamar 1 vez tras deploy, protegido con key)
// https://tu-app.railway.app/api/setup-db?key=podoclinic_setup_2026
// ══════════════════════════════════════════════════════════════
app.get('/api/setup-db', async (req, res) => {
  const key = req.query.key;
  if (key !== (process.env.SETUP_KEY || 'podoclinic_setup_2026'))
    return res.status(403).send('Acceso denegado. Agrega ?key=podoclinic_setup_2026');
  try {
    await initDatabase();
    res.send('✅ Base de datos configurada. Tablas creadas y tratamientos insertados.');
  } catch (err) {
    res.status(500).send('❌ Error: ' + err.message);
  }
});

// ─── Servir frontends ─────────────────────────────────────────
app.get('/pacientes', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal-pacientes.html'));
});

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// ─── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({ error: 'Error interno' });
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n====================================================`);
  console.log(`  🦶 PodoClinic en http://localhost:${PORT}`);
  console.log(`  Panel medico:     http://localhost:${PORT}/`);
  console.log(`  Portal pacientes: http://localhost:${PORT}/pacientes`);
  console.log(`  Setup BD:         http://localhost:${PORT}/api/setup-db?key=podoclinic_setup_2026`);
  console.log(`  DB: ${process.env.MYSQLHOST || 'localhost'} / ${process.env.MYSQL_DATABASE || 'railway'}`);
  console.log(`====================================================\n`);
});
