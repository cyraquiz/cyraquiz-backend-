const router = require("express").Router();
const { randomUUID } = require("crypto");
const db = require("../db");
const authorization = require("../middleware/authorization");

/* ── init tables ── */
async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS assignments (
      id          SERIAL PRIMARY KEY,
      quiz_id     BIGINT,
      token       VARCHAR(36) NOT NULL UNIQUE,
      teacher_id  VARCHAR(255) NOT NULL,
      title       VARCHAR(255) NOT NULL,
      questions   JSONB NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      is_active   BOOLEAN DEFAULT TRUE
    )
  `);

  // Migrar quiz_id de INTEGER a BIGINT si la tabla ya existía con tipo viejo
  await db.query(`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name  = 'assignments'
          AND column_name = 'quiz_id'
          AND udt_name    = 'int4'
      ) THEN
        ALTER TABLE assignments ALTER COLUMN quiz_id TYPE BIGINT;
      END IF;
    END
    $migration$
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS assignment_submissions (
      id             SERIAL PRIMARY KEY,
      assignment_id  INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_name   VARCHAR(50) NOT NULL,
      score          INTEGER NOT NULL DEFAULT 0,
      total_possible INTEGER NOT NULL DEFAULT 0,
      answers        JSONB,
      submitted_at   TIMESTAMP DEFAULT NOW()
    )
  `);
}
ensureTables().catch(err => console.error("Error creando tablas assignments:", err.message));

/* ── Profesor: crear asignación ── */
router.post("/", authorization, async (req, res) => {
  try {
    const { quiz_id, title, questions } = req.body;
    const teacher_id = req.user.id;

    if (!title || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Faltan datos (title, questions)" });
    }

    const token = randomUUID();
    const result = await db.query(
      `INSERT INTO assignments (quiz_id, token, teacher_id, title, questions)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, token, title, created_at`,
      [quiz_id || null, token, teacher_id, title, JSON.stringify(questions)]
    );

    res.json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    console.error("CREATE ASSIGNMENT ERROR:", err.message);
    res.status(500).json({ error: err.message || "Error al crear asignación" });
  }
});

/* ── Profesor: listar mis asignaciones ── */
router.get("/", authorization, async (req, res) => {
  try {
    const teacher_id = req.user.id;
    const result = await db.query(
      `SELECT a.id, a.token, a.title, a.created_at, a.is_active,
              COUNT(s.id)::int AS submission_count
       FROM assignments a
       LEFT JOIN assignment_submissions s ON s.assignment_id = a.id
       WHERE a.teacher_id = $1
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
      [teacher_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET ASSIGNMENTS ERROR:", err.message);
    res.status(500).json({ error: err.message || "Error al obtener asignaciones" });
  }
});

/* ── Profesor: ver respuestas de una asignación ── */
router.get("/:id/submissions", authorization, async (req, res) => {
  try {
    const { id } = req.params;
    const teacher_id = req.user.id;

    const assignment = await db.query(
      "SELECT * FROM assignments WHERE id = $1 AND teacher_id = $2",
      [id, teacher_id]
    );
    if (assignment.rows.length === 0) {
      return res.status(404).json({ error: "No encontrado" });
    }

    const subs = await db.query(
      "SELECT id, student_name, score, total_possible, answers, submitted_at FROM assignment_submissions WHERE assignment_id = $1 ORDER BY submitted_at ASC",
      [id]
    );

    res.json({
      assignment: assignment.rows[0],
      submissions: subs.rows
    });
  } catch (err) {
    console.error("GET SUBMISSIONS ERROR:", err.message);
    res.status(500).json({ error: err.message || "Error al obtener respuestas" });
  }
});

/* ── Profesor: eliminar asignación ── */
router.delete("/:id", authorization, async (req, res) => {
  try {
    const { id } = req.params;
    const teacher_id = req.user.id;

    const result = await db.query(
      "DELETE FROM assignments WHERE id = $1 AND teacher_id = $2 RETURNING id",
      [id, teacher_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No encontrado o sin permiso" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE ASSIGNMENT ERROR:", err.message);
    res.status(500).json({ error: err.message || "Error al eliminar asignación" });
  }
});

/* ── Estudiante: obtener quiz por token ── */
router.get("/student/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const result = await db.query(
      "SELECT id, title, questions FROM assignments WHERE token = $1 AND is_active = TRUE",
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Asignación no encontrada o inactiva" });
    }
    const a = result.rows[0];
    res.json({
      id: a.id,
      title: a.title,
      questions: typeof a.questions === "string" ? JSON.parse(a.questions) : a.questions
    });
  } catch (err) {
    console.error("GET STUDENT ASSIGNMENT ERROR:", err.message);
    res.status(500).json({ error: err.message || "Error al obtener asignación" });
  }
});

/* ── Estudiante: enviar respuestas ── */
router.post("/student/:token/submit", async (req, res) => {
  try {
    const { token } = req.params;
    const { student_name, score, total_possible, answers } = req.body;

    if (!student_name?.trim() || score === undefined || !total_possible) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const assignment = await db.query(
      "SELECT id FROM assignments WHERE token = $1 AND is_active = TRUE",
      [token]
    );
    if (assignment.rows.length === 0) {
      return res.status(404).json({ error: "Asignación no encontrada" });
    }

    const assignment_id = assignment.rows[0].id;

    const existing = await db.query(
      "SELECT id FROM assignment_submissions WHERE assignment_id = $1 AND LOWER(student_name) = LOWER($2)",
      [assignment_id, student_name.trim()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Ya enviaste tus respuestas con este nombre" });
    }

    await db.query(
      "INSERT INTO assignment_submissions (assignment_id, student_name, score, total_possible, answers) VALUES ($1, $2, $3, $4, $5)",
      [assignment_id, student_name.trim(), score, total_possible, JSON.stringify(answers || [])]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("SUBMIT ASSIGNMENT ERROR:", err.message);
    res.status(500).json({ error: err.message || "Error al enviar respuestas" });
  }
});

module.exports = router;
