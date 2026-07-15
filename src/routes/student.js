const express = require('express');
const router  = express.Router();
const db      = require('../db');

// POST /student/session — guarda resultado de una partida
router.post('/session', async (req, res) => {
  const { roomCode, score, rank, totalPlayers, correctAnswers, totalQuestions } = req.body;
  const studentId = req.student.studentId;
  try {
    await db.query(
      `INSERT INTO student_sessions
         (student_id, room_code, score, rank, total_players, correct_answers, total_questions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [studentId, roomCode || null, score || 0, rank || null,
       totalPlayers || null, correctAnswers || 0, totalQuestions || 0]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('student/session:', err.message);
    res.status(500).json({ error: 'Error al guardar sesión' });
  }
});

// GET /student/sessions — historial del estudiante autenticado
router.get('/sessions', async (req, res) => {
  const studentId = req.student.studentId;
  try {
    const { rows } = await db.query(
      `SELECT id, room_code, score, rank, total_players,
              correct_answers, total_questions, played_at
       FROM student_sessions
       WHERE student_id = $1
       ORDER BY played_at DESC
       LIMIT 50`,
      [studentId]
    );
    res.json(rows);
  } catch (err) {
    console.error('student/sessions:', err.message);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// GET /student/me — perfil básico del estudiante
router.get('/me', async (req, res) => {
  const studentId = req.student.studentId;
  try {
    const { rows } = await db.query(
      'SELECT id, email, display_name, created_at FROM student_profiles WHERE id = $1',
      [studentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

module.exports = router;
