const router      = require("express").Router();
const db          = require("../db");
const localDb     = require("../db/local");
const authorization = require("../middleware/authorization");

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';

// Auto-migration: add public bank columns + video_url if they don't exist yet
if (!LOCAL_MODE) {
  db.query(`
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS is_public    BOOLEAN      DEFAULT false;
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS author_email TEXT;
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS video_url    TEXT;
  `).catch(err => console.error('Migration quizzes:', err.message));
}

// ── GET banco público (sin autenticación) ──
// MUST come before GET /:id so Express doesn't treat "public" as an id param
router.get("/public", async (req, res) => {
  if (LOCAL_MODE) return res.json([]);
  try {
    const result = await db.query(
      `SELECT id, title, description, questions, author_email, published_at
       FROM quizzes WHERE is_public = true ORDER BY published_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET PUBLIC ERROR:", err);
    res.status(500).json({ error: "Error al obtener el banco público" });
  }
});

// ── GET lista de quizzes ──
router.get("/", authorization, async (req, res) => {
  if (LOCAL_MODE) {
    return res.json(localDb.getQuizzesByUser(req.user.id));
  }
  try {
    const all = await db.query(
      "SELECT * FROM quizzes WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json(all.rows);
  } catch (err) {
    console.error("GET QUIZ ERROR:", err);
    res.status(500).json({ error: "Error al obtener Quiz" });
  }
});

// ── GET quiz por id ──
router.get("/:id", async (req, res) => {
  if (LOCAL_MODE) {
    const quiz = localDb.getQuizById(req.params.id);
    if (!quiz) return res.status(404).json("Quiz no encontrado");
    return res.json({
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      questionsData: quiz.questions,
    });
  }
  try {
    const quiz = await db.query("SELECT * FROM quizzes WHERE id = $1", [req.params.id]);
    if (quiz.rows.length === 0) return res.status(404).json("Quiz no encontrado");
    const data = quiz.rows[0];
    res.json({ id: data.id, title: data.title, description: data.description, questionsData: data.questions, video_url: data.video_url });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error del servidor");
  }
});

// ── POST crear quiz ──
router.post("/", authorization, async (req, res) => {
  if (LOCAL_MODE) {
    return res.status(503).json({ error: "Creación de quizzes no disponible sin internet. Crea quizzes desde cyraquiz.vercel.app y se sincronizarán al iniciar sesión." });
  }
  try {
    const { title, description, questions, videoUrl } = req.body;
    const newQuiz = await db.query(
      "INSERT INTO quizzes (user_id, title, description, questions, video_url) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [req.user.id, title, description || "", JSON.stringify(questions), videoUrl || null]
    );
    console.log("Quiz guardado:", newQuiz.rows[0].title);
    res.json(newQuiz.rows[0]);
  } catch (err) {
    console.error("SAVE QUIZ ERROR:", err.message, "| user:", req.user?.id, "| code:", err.code);
    res.status(500).json({ error: err.message || "Error al guardar Quiz" });
  }
});

// ── PUT actualizar quiz ──
router.put("/:id", authorization, async (req, res) => {
  if (LOCAL_MODE) {
    return res.status(503).json({ error: "Edición de quizzes no disponible sin internet." });
  }
  try {
    const { title, questions, videoUrl } = req.body;
    const updated = await db.query(
      "UPDATE quizzes SET title = $1, questions = $2, video_url = $3 WHERE id = $4 AND user_id = $5 RETURNING *",
      [title, JSON.stringify(questions), videoUrl || null, req.params.id, req.user.id]
    );
    if (updated.rows.length === 0) return res.status(404).json("No se encontró el quiz o no es tuyo");
    console.log("Quiz actualizado:", updated.rows[0].title);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error al actualizar Quiz");
  }
});

// ── PUT publicar quiz al banco público ──
router.put("/:id/publish", authorization, async (req, res) => {
  if (LOCAL_MODE) return res.status(503).json({ error: "No disponible en modo local." });
  try {
    const email = req.user.email || req.user.user_metadata?.email || "";
    const updated = await db.query(
      `UPDATE quizzes SET is_public = true, author_email = $1, published_at = NOW()
       WHERE id = $2 AND user_id = $3 RETURNING id, title, is_public`,
      [email, req.params.id, req.user.id]
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: "Quiz no encontrado o sin permiso" });
    res.json(updated.rows[0]);
  } catch (err) {
    console.error("PUBLISH ERROR:", err.message);
    res.status(500).json({ error: "Error al publicar el quiz" });
  }
});

// ── PUT despublicar quiz del banco público ──
router.put("/:id/unpublish", authorization, async (req, res) => {
  if (LOCAL_MODE) return res.status(503).json({ error: "No disponible en modo local." });
  try {
    const updated = await db.query(
      `UPDATE quizzes SET is_public = false WHERE id = $1 AND user_id = $2 RETURNING id, title, is_public`,
      [req.params.id, req.user.id]
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: "Quiz no encontrado o sin permiso" });
    res.json(updated.rows[0]);
  } catch (err) {
    console.error("UNPUBLISH ERROR:", err.message);
    res.status(500).json({ error: "Error al despublicar el quiz" });
  }
});

// ── POST clonar quiz público a la cuenta del usuario ──
router.post("/:id/clone", authorization, async (req, res) => {
  if (LOCAL_MODE) return res.status(503).json({ error: "No disponible en modo local." });
  try {
    const src = await db.query(
      `SELECT title, description, questions FROM quizzes WHERE id = $1 AND is_public = true`,
      [req.params.id]
    );
    if (src.rows.length === 0) return res.status(404).json({ error: "Quiz público no encontrado" });
    const q = src.rows[0];
    const cloned = await db.query(
      `INSERT INTO quizzes (user_id, title, description, questions) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, q.title + " (importado)", q.description || "", q.questions]
    );
    res.json(cloned.rows[0]);
  } catch (err) {
    console.error("CLONE ERROR:", err.message);
    res.status(500).json({ error: "Error al importar el quiz" });
  }
});

// ── DELETE eliminar quiz ──
router.delete("/:id", authorization, async (req, res) => {
  if (LOCAL_MODE) {
    return res.status(503).json({ error: "Eliminación de quizzes no disponible sin internet." });
  }
  try {
    const deleted = await db.query(
      "DELETE FROM quizzes WHERE id = $1 AND user_id = $2 RETURNING *",
      [req.params.id, req.user.id]
    );
    if (deleted.rows.length === 0) return res.status(404).json("No se encontró el examen o no tienes permiso");
    console.log("Quiz eliminado exitosamente:", req.params.id);
    res.json({ message: "Examen eliminado correctamente" });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error al eliminar el Quiz");
  }
});

module.exports = router;
