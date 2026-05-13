const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fs = require('fs');          // ⬅️ para leer archivos SQL
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'tu_secreto_seguro_aqui_2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.url.endsWith('.html')) res.type('text/html; charset=utf-8');
  next();
});
app.use(express.static(path.join(__dirname)));

// --------------------------------------------------------------
// 🔧 POOL DE CONEXIÓN – usa las variables que Railway inyecta AUTOMÁTICAMENTE
// --------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,          // inyectado por Railway
  user: process.env.MYSQLUSER,          // inyectado por Railway
  password: process.env.MYSQLPASSWORD,  // inyectado por Railway
  database: process.env.MYSQL_DATABASE, // inyectado por Railway (normalmente 'railway')
  port: parseInt(process.env.MYSQLPORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ✅ Prueba de conexión a MySQL al iniciar (muestra en logs si todo va bien)
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Conectado a MySQL exitosamente');
    conn.release();
  } catch (err) {
    console.error('❌ Error conectando a MySQL:', err.message);
    // No detenemos el servidor, solo mostramos el error
  }
})();

// ✅ Middleware global para capturar errores inesperados
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ✅ Endpoint de health check para Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
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

// Solo médicos/admin
const verifyDoctor = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token inválido' });
    if (decoded.role !== 'doctor' && decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso solo para profesionales' });
    }
    req.userId = decoded.id;
    req.userName = decoded.name;
    req.userRole = decoded.role;
    next();
  });
};

// ──────────────────────────────────────────
// RUTAS DE AUTENTICACIÓN
// ──────────────────────────────────────────

// Login (pacientes Y médicos)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const conn = await pool.getConnection();
    const [users] = await conn.execute('SELECT * FROM users WHERE email = ?', [email]);
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

// Registro (por defecto, rol paciente)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Todos los campos son requeridos' });

    const conn = await pool.getConnection();
    const [existing] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) { conn.release(); return res.status(400).json({ error: 'El email ya está registrado' }); }

    const hash = await bcrypt.hash(password, 10);
    const userRole = role === 'doctor' ? 'doctor' : 'patient';

    await conn.execute(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name, email, hash, userRole]
    );
    conn.release();
    res.json({ success: true, message: 'Usuario registrado correctamente' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────
// RUTAS DE PACIENTES
// ──────────────────────────────────────────

// GET pacientes (doctor ve todos los suyos; paciente solo el propio)
app.get('/api/pacientes', verifyToken, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    let pacientes;
    if (req.userRole === 'doctor' || req.userRole === 'admin') {
      [pacientes] = await conn.execute(
        'SELECT * FROM pacientes WHERE user_id = ? ORDER BY fecha_registro DESC',
        [req.userId]
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

    let ownerId = req.userId;
    if (req.userRole === 'patient') {
      const conn2 = await pool.getConnection();
      const [doctors] = await conn2.execute("SELECT id FROM users WHERE role = 'doctor' LIMIT 1");
      conn2.release();
      ownerId = doctors.length ? doctors[0].id : req.userId;
    }

    const conn = await pool.getConnection();
    const [existing] = await conn.execute(
      'SELECT id FROM pacientes WHERE rut = ? AND user_id = ?',
      [rut, ownerId]
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
       WHERE id=? AND user_id=?`,
      [nombre, rut, edad, email, telefono, direccion, alergias, diagnostico, estado, req.params.id, req.userId]
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
    await conn.execute('DELETE FROM pacientes WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    conn.release();
    res.json({ success: true, message: 'Paciente eliminado' });
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

app.get('/api/citas', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    const conn = await pool.getConnection();
    const params = [];
    let query = `SELECT c.*, p.nombre AS paciente_nombre, p.rut AS paciente_rut, p.telefono AS paciente_telefono
                 FROM citas c
                 JOIN pacientes p ON c.paciente_id = p.id
                 WHERE `;

    if (req.userRole === 'doctor' || req.userRole === 'admin') {
      query += 'c.user_id = ?';
      params.push(req.userId);
    } else {
      query += 'p.email = (SELECT email FROM users WHERE id = ?)';
      params.push(req.userId);
    }

    if (fecha) { query += ' AND c.fecha = ?'; params.push(fecha); }
    query += ' ORDER BY c.fecha DESC, c.hora';

    const [citas] = await conn.execute(query, params);
    conn.release();
    res.json(citas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/citas', verifyToken, async (req, res) => {
  try {
    const { paciente_id, fecha, hora, duracion, tratamiento, notas, estado } = req.body;
    if (!paciente_id || !fecha || !hora) return res.status(400).json({ error: 'Paciente, fecha y hora son requeridos' });

    const conn = await pool.getConnection();
    const [existing] = await conn.execute(
      "SELECT id FROM citas WHERE fecha = ? AND hora = ? AND estado != 'Cancelada'",
      [fecha, hora]
    );
    if (existing.length) {
      conn.release();
      return res.status(409).json({ error: 'Ese horario ya está ocupado. Elige otro.' });
    }

    let ownerId = req.userId;
    if (req.userRole === 'patient') {
      const [doctors] = await conn.execute("SELECT id FROM users WHERE role = 'doctor' LIMIT 1");
      ownerId = doctors.length ? doctors[0].id : req.userId;
    }

    const [result] = await conn.execute(
      `INSERT INTO citas (user_id, paciente_id, fecha, hora, duracion, tratamiento, notas, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ownerId, paciente_id, fecha, hora, duracion || 30, tratamiento || '', notas || '', estado || 'Confirmada']
    );
    conn.release();
    res.json({ success: true, id: result.insertId, message: 'Cita creada correctamente' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

    if (req.userRole === 'patient') {
      values.push(req.userId);
      await conn.execute(
        `UPDATE citas SET ${fields.join(', ')} WHERE id = ? AND paciente_id IN
         (SELECT id FROM pacientes WHERE email = (SELECT email FROM users WHERE id = ?))`,
        [...values]
      );
    } else {
      values.push(req.userId);
      await conn.execute(
        `UPDATE citas SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
        values
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
    await conn.execute('DELETE FROM citas WHERE user_id = ? AND id = ?', [req.userId, req.params.id]);
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

app.get('/api/stats', verifyDoctor, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [[{ totalPacientes }]] = await conn.execute(
      'SELECT COUNT(*) AS totalPacientes FROM pacientes WHERE user_id = ?', [req.userId]
    );
    const [[{ totalHistorial }]] = await conn.execute(
      `SELECT COUNT(*) AS totalHistorial FROM historial_clinico h
       JOIN pacientes p ON h.paciente_id = p.id WHERE p.user_id = ?`, [req.userId]
    );
    const [[{ activos }]] = await conn.execute(
      "SELECT COUNT(*) AS activos FROM pacientes WHERE user_id = ? AND estado = 'Activo'", [req.userId]
    );
    const [[{ seguimientos }]] = await conn.execute(
      "SELECT COUNT(*) AS seguimientos FROM pacientes WHERE user_id = ? AND estado = 'Seguimiento'", [req.userId]
    );
    const today = new Date().toISOString().split('T')[0];
    const [[{ citasHoy }]] = await conn.execute(
      "SELECT COUNT(*) AS citasHoy FROM citas WHERE user_id = ? AND fecha = ? AND estado != 'Cancelada'",
      [req.userId, today]
    );
    conn.release();
    res.json({ totalPacientes, totalHistorial, activos, seguimientos, citasHoy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Servir portal de pacientes en /pacientes
app.get('/pacientes', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal-pacientes.html'));
});

// Servir app médico en raíz /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =====================================================
// ⚠️  ENDPOINT TEMPORAL PARA IMPORTAR LA BASE DE DATOS
// =====================================================
app.get('/api/setup-db', async (req, res) => {
  try {
    const dbSql = fs.readFileSync(path.join(__dirname, 'database.sql'), 'utf8');
    const migrationSql = fs.readFileSync(path.join(__dirname, 'migration.sql'), 'utf8');

    const conn = await pool.getConnection();

    const executeSql = async (sqlContent) => {
      const statements = sqlContent.split(';').filter(stmt => stmt.trim().length > 0);
      for (let stmt of statements) {
        await conn.execute(stmt);
      }
    };

    await executeSql(dbSql);
    await executeSql(migrationSql);

    conn.release();
    res.send('✅ Base de datos importada correctamente');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ Error al importar: ' + error.message);
  }
});
// =====================================================

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🦶 PodoClinic corriendo en http://localhost:${PORT}`);
  console.log(`👩‍⚕️  Panel médico:     http://localhost:${PORT}/`);
  console.log(`🙋  Portal pacientes: http://localhost:${PORT}/pacientes`);
  console.log(`📊  Base de datos:    ${process.env.MYSQL_DATABASE || 'railway'}`);
});
