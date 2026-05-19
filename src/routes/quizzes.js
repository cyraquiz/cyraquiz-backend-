const router      = require("express").Router();
const db          = require("../db");
const localDb     = require("../db/local");
const authorization = require("../middleware/authorization");

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';

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
    res.json({ id: data.id, title: data.title, description: data.description, questionsData: data.questions });
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
    const { title, description, questions } = req.body;
    const newQuiz = await db.query(
      "INSERT INTO quizzes (user_id, title, description, questions) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.user.id, title, description || "", JSON.stringify(questions)]
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
    const { title, questions } = req.body;
    const updated = await db.query(
      "UPDATE quizzes SET title = $1, questions = $2 WHERE id = $3 AND user_id = $4 RETURNING *",
      [title, JSON.stringify(questions), req.params.id, req.user.id]
    );
    if (updated.rows.length === 0) return res.status(404).json("No se encontró el quiz o no es tuyo");
    console.log("Quiz actualizado:", updated.rows[0].title);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error al actualizar Quiz");
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
