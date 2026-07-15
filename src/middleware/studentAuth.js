const jwt = require('jsonwebtoken');
require('dotenv').config();

const STUDENT_SECRET = process.env.STUDENT_JWT_SECRET || 'cyraquiz-student-secret-2026';

module.exports = (req, res, next) => {
  const token =
    req.header("Authorization")?.replace("Bearer ", "") ||
    req.header("student-token");
  if (!token) return res.status(403).json("No autorizado: Falta el token de estudiante");
  try {
    const decoded = jwt.verify(token, STUDENT_SECRET);
    if (decoded.role !== 'student') return res.status(403).json("No autorizado");
    req.student = decoded;
    next();
  } catch {
    return res.status(403).json("Token inválido o expirado");
  }
};
