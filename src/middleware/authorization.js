const jwt = require('jsonwebtoken');
require('dotenv').config();

const LOCAL_MODE   = process.env.LOCAL_MODE === 'true';
const LOCAL_SECRET = process.env.LOCAL_JWT_SECRET || 'cyraquiz-local-offline-secret';

// Only create the Supabase client when not in local mode
let supabase = null;
if (!LOCAL_MODE) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

module.exports = async (req, res, next) => {
  try {
    const token = req.header("token") || req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return res.status(403).json("No autorizado: Falta el token");

    if (LOCAL_MODE) {
      try {
        const decoded = jwt.verify(token, LOCAL_SECRET);
        req.user = { id: decoded.userId, email: decoded.email };
        return next();
      } catch {
        return res.status(403).json("No autorizado: Token inválido o expirado");
      }
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(403).json("No autorizado: Token inválido o expirado");
    req.user = user;
    next();
  } catch (err) {
    console.error(err.message);
    return res.status(403).json("Error de autenticación");
  }
};
