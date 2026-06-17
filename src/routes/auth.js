const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const localDb  = require('../db/local');
require('dotenv').config();

const LOCAL_MODE   = process.env.LOCAL_MODE === 'true';
const LOCAL_SECRET = process.env.LOCAL_JWT_SECRET || 'cyraquiz-local-offline-secret';

function makeLocalToken(userId, email) {
  return jwt.sign({ userId, email }, LOCAL_SECRET, { expiresIn: '12h' });
}

function supabaseClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

router.post('/register', async (req, res) => {
  if (LOCAL_MODE) {
    return res.status(503).json({ error: "El registro no está disponible en modo local. Crea tu cuenta desde cyraquiz.vercel.app." });
  }
  const { email, password } = req.body;
  try {
    const { data, error } = await supabaseClient().auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: "Usuario creado en Supabase", user: data.user });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error en el servidor al registrar");
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!LOCAL_MODE) {
    // ── Modo nube normal ──
    try {
      const { data, error } = await supabaseClient().auth.signInWithPassword({ email, password });
      if (error) {
        const msg = error.message.includes("Email not confirmed")
          ? "Por favor, confirma tu correo antes de iniciar sesión."
          : "Credenciales incorrectas";
        return res.status(400).json({ error: msg });
      }
      return res.json({ message: "Login exitoso", token: data.session.access_token, user: data.user });
    } catch (err) {
      console.error(err);
      return res.status(500).send("Error en el servidor al iniciar sesión");
    }
  }

  // ── Modo local: intentar Supabase con timeout, si falla usar caché ──
  let supabaseUser = null;
  try {
    const result = await Promise.race([
      supabaseClient().auth.signInWithPassword({ email, password }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    if (!result.error) supabaseUser = result.data?.user;
  } catch (_) { /* timeout o sin internet */ }

  if (supabaseUser) {
    // Online: actualizar caché de credenciales y sincronizar quizzes
    const hash = await bcrypt.hash(password, 10);
    localDb.saveUser({ id: supabaseUser.id, email, passwordHash: hash });

    try {
      const db = require('../db');
      const result = await db.query('SELECT * FROM quizzes WHERE user_id = $1', [supabaseUser.id]);
      const count = localDb.syncQuizzes(result.rows);
      console.log(`✓ ${count} quizzes sincronizados para ${email}`);
    } catch (_) { /* La DB de quizzes puede no estar disponible */ }

    const token = makeLocalToken(supabaseUser.id, email);
    return res.json({ message: "Login exitoso", token, user: supabaseUser });
  }

  // Sin internet: verificar credenciales almacenadas localmente
  const cached = localDb.findUserByEmail(email);
  if (!cached) {
    return res.status(400).json({
      error: "Sin conexión a internet. Debes iniciar sesión con internet al menos una vez desde este equipo.",
    });
  }

  const match = await bcrypt.compare(password, cached.passwordHash);
  if (!match) return res.status(400).json({ error: "Credenciales incorrectas" });

  console.log(`Login offline para ${email}`);
  const token = makeLocalToken(cached.id, email);
  return res.json({ message: "Login exitoso (offline)", token, user: { id: cached.id, email } });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    await supabaseClient().auth.resetPasswordForEmail(email, {
      redirectTo: 'https://cyraquiz-frontend.vercel.app/reset-password',
    });
    // Siempre retorna éxito para evitar enumeración de emails
    res.json({ message: 'Si el correo existe, recibirás un enlace de recuperación en tu bandeja de entrada.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

router.post('/update-password', async (req, res) => {
  const { access_token, new_password } = req.body;
  if (!access_token || !new_password) return res.status(400).json({ error: 'Datos incompletos' });
  if (new_password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const { data: { user }, error: authError } = await supabaseClient().auth.getUser(access_token);
    if (authError || !user) return res.status(400).json({ error: 'Enlace inválido o expirado' });

    const { error } = await supabaseClient().auth.admin.updateUserById(user.id, { password: new_password });
    if (error) return res.status(400).json({ error: error.message });

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la contraseña' });
  }
});

module.exports = router;
