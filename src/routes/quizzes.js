const router = require("express").Router();
const db = require("../db");
const authorization = require("../middleware/authorization"); 

router.post("/", authorization, async (req, res) => {
  try {
    const { title, description, questions } = req.body;

    const userId = req.user.id; 

    const newQuiz = await db.query(
      "INSERT INTO quizzes (user_id, title, description, questions) VALUES ($1, $2, $3, $4) RETURNING *",
      [userId, title, description || "", JSON.stringify(questions)]
    );

    console.log("Quiz guardado:", newQuiz.rows[0].title);
    res.json(newQuiz.rows[0]);
    
  } catch (err) {
    console.error("SAVE QUIZ ERROR:", err.message, "| user:", req.user?.id, "| code:", err.code);
    res.status(500).json({ error: err.message || "Error al guardar Quiz" });
  }
});

router.get("/", authorization, async (req, res) => {
  try {
    const userId = req.user.id;

    const allQuizzes = await db.query(
      "SELECT * FROM quizzes WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );

    res.json(allQuizzes.rows);
  } catch (err) {
    console.error("GET QUIZ ERROR:", err);
  res.status(500).json({ error: "Error al obtener Quiz" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const quiz = await db.query("SELECT * FROM quizzes WHERE id = $1", [id]);

    if (quiz.rows.length === 0) {
      return res.status(404).json("Quiz no encontrado");
    }

    const data = quiz.rows[0];

    res.json({
      id: data.id,
      title: data.title,
      description: data.description,
      questionsData: data.questions
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error del servidor");
  }
});

router.put("/:id", authorization, async (req, res) => {
  try {
    const { id } = req.params; 
    const { title, questions } = req.body; 
    const userId = req.user.id;

    const updateQuiz = await db.query(
      "UPDATE quizzes SET title = $1, questions = $2 WHERE id = $3 AND user_id = $4 RETURNING *",
      [title, JSON.stringify(questions), id, userId]
    );

    if (updateQuiz.rows.length === 0) {
      return res.status(404).json("No se encontró el quiz o no es tuyo");
    }

    console.log("Quiz actualizado:", updateQuiz.rows[0].title);
    res.json(updateQuiz.rows[0]);

  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error al actualizar Quiz");
  }
});

router.delete("/:id", authorization, async (req, res) => {
  try {
    const { id } = req.params; 
    const userId = req.user.id;

    const deleteQuiz = await db.query(
      "DELETE FROM quizzes WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId]
    );

    if (deleteQuiz.rows.length === 0) {
      return res.status(404).json("No se encontró el examen o no tienes permiso para eliminarlo");
    }

    console.log("Quiz eliminado exitosamente:", id);
    res.json({ message: "Examen eliminado correctamente" });

  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error al eliminar el Quiz");
  }
});


module.exports = router;