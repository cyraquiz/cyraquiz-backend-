const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET   = process.env.JWT_SECRET     || 'cyraquiz-secret-2026';
const LOCAL_SECRET = process.env.LOCAL_JWT_SECRET || 'cyraquiz-local-offline-secret';
const LOCAL_MODE   = process.env.LOCAL_MODE === 'true';

module.exports = async (req, res, next) => {
  try {
    const token = req.header("token") || req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return res.status(403).json("No autorizado: Falta el token");

    // En modo local usamos LOCAL_SECRET; en producción usamos JWT_SECRET
    const secret = LOCAL_MODE ? LOCAL_SECRET : JWT_SECRET;

    try {
      const decoded = jwt.verify(token, secret);
      req.user = { id: decoded.userId, email: decoded.email };
      return next();
    } catch {
      return res.status(403).json("No autorizado: Token inválido o expirado");
    }
  } catch (err) {
    console.error(err.message);
    return res.status(403).json("Error de autenticación");
  }
};
