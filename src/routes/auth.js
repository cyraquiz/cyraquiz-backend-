const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: "Usuario creado en Supabase", user: data.user });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error en el servidor al registrar");
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (error) {
      const msj = error.message.includes("Email not confirmed") 
        ? "Por favor, confirma tu correo antes de iniciar sesión." 
        : "Credenciales incorrectas";
      return res.status(400).json({ error: msj });
    }

    res.json({ 
      message: "Login exitoso", 
      token: data.session.access_token, 
      user: data.user 
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error en el servidor al iniciar sesión");
  }
});

module.exports = router;