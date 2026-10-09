const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const db       = require('../db');

require('dotenv').config();

const JWT_SECRET     = process.env.JWT_SECRET     || 'cyraquiz-secret-2026';
const LOCAL_SECRET   = process.env.LOCAL_JWT_SECRET || 'cyraquiz-local-offline-secret';
const STUDENT_SECRET = process.env.STUDENT_JWT_SECRET || 'cyraquiz-student-secret-2026';
const LOCAL_MODE     = process.env.LOCAL_MODE === 'true';

function makeToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '12h' });
}

// ─── Registro de maestro ──────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length)
      return res.status(400).json({ error: 'Este correo ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [email.toLowerCase(), hash]
    );
    const user = rows[0];
    const token = makeToken(user.id, user.email);
    res.status(201).json({ message: 'Usuario creado exitosamente', token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('register:', err.message);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// ─── Login de maestro ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length)
      return res.status(400).json({ error: 'Credenciales incorrectas' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(400).json({ error: 'Credenciales incorrectas' });

    const token = makeToken(user.id, user.email);
    res.json({ message: 'Login exitoso', token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('login:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// ─── Forgot Password ──────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    // Siempre responder con éxito para evitar enumeración de emails
    if (!rows.length)
      return res.json({ message: 'Si el correo existe, recibirás un enlace de recuperación en tu bandeja de entrada.' });

    const userId = rows[0].id;
    const token  = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET token = $2, expires_at = $3`,
      [userId, token, expires]
    );

    // TODO: enviar email con el enlace de reset
    // Por ahora solo log (integrar nodemailer o Resend si se desea)
    const resetUrl = `https://cyraquiz-frontend.vercel.app/reset-password?token=${token}`;
    console.log(`Reset URL para ${email}: ${resetUrl}`);

    res.json({ message: 'Si el correo existe, recibirás un enlace de recuperación en tu bandeja de entrada.' });
  } catch (err) {
    console.error('forgot-password:', err.message);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

// ─── Update Password ──────────────────────────────────────────────────────────
router.post('/update-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password)
    return res.status(400).json({ error: 'Datos incompletos' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const { rows } = await db.query(
      `SELECT user_id FROM password_reset_tokens
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (!rows.length)
      return res.status(400).json({ error: 'Enlace inválido o expirado' });

    const userId = rows[0].user_id;
    const hash   = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('update-password:', err.message);
    res.status(500).json({ error: 'Error al actualizar la contraseña' });
  }
});

// ─── Estudiante: Registro ─────────────────────────────────────────────────────
router.post('/student-register', async (req, res) => {
  const { displayName, email, password } = req.body;
  if (!displayName || !email || !password)
    return res.status(400).json({ error: 'Datos incompletos' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const existing = await db.query(
      'SELECT id FROM student_profiles WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existing.rows.length)
      return res.status(400).json({ error: 'Este correo ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO student_profiles (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name`,
      [email.toLowerCase(), displayName.trim(), hash]
    );
    const student = rows[0];
    const token = jwt.sign(
      { studentId: student.id, email: student.email, role: 'student' },
      STUDENT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, displayName: student.display_name });
  } catch (err) {
    console.error('student-register:', err.message);
    res.status(500).json({ error: 'Error al registrar estudiante' });
  }
});

// ─── Estudiante: Login ────────────────────────────────────────────────────────
router.post('/student-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Datos incompletos' });

  try {
    const { rows } = await db.query(
      'SELECT * FROM student_profiles WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!rows.length)
      return res.status(400).json({ error: 'Credenciales incorrectas' });

    const student = rows[0];
    const match = await bcrypt.compare(password, student.password_hash);
    if (!match)
      return res.status(400).json({ error: 'Credenciales incorrectas' });

    const token = jwt.sign(
      { studentId: student.id, email: student.email, role: 'student' },
      STUDENT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, displayName: student.display_name });
  } catch (err) {
    console.error('student-login:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// ─── Admin: borrar usuario por email (protegido con ADMIN_SECRET) ─────────────
router.delete('/admin/user', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  try {
    const { rowCount } = await db.query('DELETE FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rowCount) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: `Usuario ${email} eliminado` });
  } catch (err) {
    console.error('admin delete user:', err.message);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

module.exports = router;
