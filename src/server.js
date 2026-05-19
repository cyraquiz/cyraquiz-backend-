if (process.env.NODE_ENV !== 'production') {
  require("dotenv").config();
}
const { randomUUID } = require('crypto');
const authRoutes        = require('./routes/auth');
const quizRoutes        = require('./routes/quizzes');
const assignmentRoutes  = require('./routes/assignments');
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const pdf = require("pdf-extraction");
const OpenAI = require("openai");

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';

const app = express();

const allowedOrigins = [
  "https://cyraquiz.vercel.app",
  "https://cyraquiz-frontend.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:4173",
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : []),
];

// En modo local aceptamos cualquier origen (red interna de la escuela)
app.use(cors(
  LOCAL_MODE
    ? { origin: true, methods: ["GET", "POST", "PUT", "DELETE"], credentials: true }
    : {
        origin: (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) callback(null, true);
          else callback(new Error("Not allowed by CORS"));
        },
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true,
      }
));
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/quizzes', quizRoutes);
app.use('/assignments', assignmentRoutes);

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const upload = multer({ dest: uploadDir });

const server = http.createServer(app);
const io = new Server(server, {
  cors: LOCAL_MODE
    ? { origin: true, methods: ["GET", "POST"], credentials: true }
    : { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
});

const rooms = new Map();

// ── Helpers de validación ────────────────────────────────
function validateHostToken(roomCode, hostToken) {
  const room = rooms.get(roomCode);
  if (!room || !hostToken) return false;
  return room.hostToken === hostToken;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 20) return null;
  return trimmed;
}

function validateRoomCode(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  // CREAR SALA
  socket.on("create_room", (roomCode) => {
    const hostToken = randomUUID();
    rooms.set(roomCode, {
      players: [],
      currentQuestion: 0,
      scores: {},
      answerCounts: [0, 0, 0, 0],
      hostToken,
      hostSocketId: socket.id,
    });
    socket.join(roomCode);
    socket.emit("room_created", { hostToken });
    console.log(`Sala creada: ${roomCode}`);
  });

  // UNIRSE A SALA
  socket.on("join_room", ({ roomCode, playerName, avatar }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr)) {
      socket.emit("error", "Código de sala inválido");
      return;
    }
    const safeName = sanitizeName(playerName);
    if (!safeName) {
      socket.emit("error", "Nombre inválido (1-20 caracteres)");
      return;
    }

    if (!rooms.has(roomStr)) {
      console.log(`Recuperando sala ${roomStr} para ${safeName}`);
      rooms.set(roomStr, { players: [], currentQuestion: 0, scores: {}, answerCounts: [0, 0, 0, 0], hostToken: null });
    }

    const room = rooms.get(roomStr);
    const existingPlayer = room.players.find(p => p.name === safeName);

    if (!existingPlayer) {
      room.players.push({
        id: socket.id,
        name: safeName,
        avatar: avatar || "https://api.dicebear.com/9.x/notionists/svg?seed=default",
        score: 0,
        timeAccumulated: 0
      });
    } else {
      existingPlayer.id = socket.id;
      console.log(`Jugador ${safeName} recuperó su sesión con nuevo ID.`);
    }

    socket.join(roomStr);
    io.to(roomStr).emit("player_joined", { name: safeName, avatar });
    console.log(`${safeName} entró a la sala ${roomStr}`);

    if (room.isGameOver && room.finalResults) {
      socket.emit("final_results", room.finalResults);
    } else if (room.isShowingResults) {
      socket.emit("reveal_results");
    } else if (room.isAnswering && room.currentOptions) {
      console.log(`Rescatando a ${safeName}: Enviando pregunta en curso.`);
      socket.emit("new_question", {
        type:     room.currentQuestionType,
        question: room.currentQuestion || "",
        options:  room.currentOptions,
        answer:   room.currentCorrectAnswer,
        time:     room.currentTimeLimit,
        points:   room.currentPoints || 100,
        min:      room.currentMin ?? 0,
        max:      room.currentMax ?? 100,
      });
    }
  });

  socket.on("start_game", (roomCode) => {
    const roomStr = roomCode.toString();
    console.log(`Intentando iniciar juego en sala: ${roomStr}`);

    if (rooms.has(roomStr)) {
      io.to(roomStr).emit("game_started");
      console.log(`Juego iniciado en sala ${roomStr} (Señal enviada a todos)`);
    } else {
      console.log("No se encontró la sala para iniciar");
    }
  });

  socket.on("send_question", ({ roomCode, question, time, hostToken }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr) || !validateHostToken(roomStr, hostToken)) {
      socket.emit("error", "No autorizado");
      return;
    }
    const room = rooms.get(roomStr);
    room.currentCorrectAnswer = question.answer;
    room.currentPoints = question.points || 100;
    room.currentQuestionType = question.type;
    room.currentOptions = question.options;
    room.currentQuestion = question.question || "";
    room.currentMin = question.min ?? 0;
    room.currentMax = question.max ?? 100;
    room.answerCounts = [0, 0, 0, 0];
    room.questionStartTime = Date.now();
    room.currentTimeLimit = time;
    room.isAnswering = true;
    room.isShowingResults = false;

    io.to(roomStr).emit("new_question", {
      type:     question.type,
      question: question.question || "",
      options:  question.options,
      answer:   question.answer,
      time:     time,
      points:   question.points || 100,
      min:      question.min ?? 0,
      max:      question.max ?? 100,
    });
    console.log(`Pregunta enviada a sala ${roomStr} (Tipo: ${question.type})`);
  });

  socket.on("submit_answer", ({ roomCode, playerName, answer }) => {
    const roomStr = roomCode.toString();
    if (!rooms.has(roomStr)) return;

    const room = rooms.get(roomStr);
    const player = room.players.find(p => p.name === playerName);

    if (player) {
      if (room.currentOptions) {
        const answersArray = Array.isArray(answer) ? answer : [answer];

        answersArray.forEach(ans => {
          const cleanAns = typeof ans === 'string' ? ans.trim() : ans;
          const index = room.currentOptions.findIndex(opt => opt.trim() === cleanAns);

          if (index !== -1 && index < 4) {
            room.answerCounts[index] += 1;
          }
        });

        io.to(roomStr).emit("update_stats", room.answerCounts);
      }

      let isCorrect = false;
      if (room.currentQuestionType === "multi") {
        const correctArr = Array.isArray(room.currentCorrectAnswer) ? room.currentCorrectAnswer.sort() : [];
        const answerArr = Array.isArray(answer) ? answer.sort() : [];
        isCorrect = JSON.stringify(correctArr) === JSON.stringify(answerArr);
      } else {
        isCorrect = room.currentCorrectAnswer === answer;
      }

      const timeTaken = Date.now() - room.questionStartTime;
      const pointsEarned = isCorrect ? room.currentPoints : 0;
      player.score += pointsEarned;

      if (isCorrect) {
        player.timeAccumulated += timeTaken;
      }

      io.to(roomStr).emit("player_answered", { playerName });
      io.to(player.id).emit("answer_result", {
        isCorrect,
        pointsEarned,
        totalScore: player.score
      });

      console.log(`${playerName} respondió. Correcto: ${isCorrect}. Puntos: ${player.score}`);
    }
  });

  socket.on("show_results", ({ roomCode, hostToken }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr) || !validateHostToken(roomStr, hostToken)) {
      socket.emit("error", "No autorizado");
      return;
    }
    const room = rooms.get(roomStr);
    room.isAnswering = false;
    room.isShowingResults = true;
    io.to(roomStr).emit("reveal_results");
  });

  // FIN DEL JUEGO
  socket.on("game_over", ({ roomCode, hostToken }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr) || !validateHostToken(roomStr, hostToken)) {
      socket.emit("error", "No autorizado");
      return;
    }
    const room = rooms.get(roomStr);
    if (room) {
      if (!room.isGameOver) {
        const sortedPlayers = [...room.players].sort((a, b) => {
          if (b.score === a.score) return a.timeAccumulated - b.timeAccumulated;
          return b.score - a.score;
        });
        room.isGameOver = true;
        room.finalResults = sortedPlayers;
        room.isShowingResults = false;
        room.isAnswering = false;
        console.log(`Juego terminado en sala ${roomStr}`);
      }
      io.to(roomStr).emit("final_results", room.finalResults);
    }
  });

  socket.on("cancel_game", ({ roomCode, hostToken }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr) || !validateHostToken(roomStr, hostToken)) {
      socket.emit("error", "No autorizado");
      return;
    }
    io.to(roomStr).emit("game_cancelled");
    rooms.delete(roomStr);
    console.log(`Partida cancelada en sala ${roomStr}`);
  });

  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});

/* ── Generación IA desde tema / texto / URL ── */
app.post('/generate-text', async (req, res) => {
  const { mode, content } = req.body;

  if (!mode || !content || content.trim().length < 3) {
    return res.status(400).json({ error: "Falta el contenido." });
  }

  let sourceText = null;

  try {
    if (mode === "url") {
      const url = content.trim();
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: "URL inválida. Debe comenzar con http:// o https://" });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const fetchRes = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CYRAQuiz/1.0)" }
      });
      clearTimeout(timer);
      const html = await fetchRes.text();
      sourceText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ').trim();
      if (sourceText.length < 100) {
        return res.status(400).json({ error: "No se pudo extraer texto suficiente de esa URL." });
      }
    } else if (mode === "text") {
      sourceText = content.trim();
      if (sourceText.length < 50) {
        return res.status(400).json({ error: "El texto es muy corto. Pega más contenido." });
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(400).json({ error: "La URL tardó demasiado en responder." });
    }
    return res.status(400).json({ error: "No se pudo acceder a la URL. Verifica que sea pública." });
  }

  const sourceSection = sourceText
    ? `Basándote en el siguiente texto:\n---\n${sourceText.substring(0, 90000)}\n---\n\n`
    : '';
  const topicSection = mode === "topic"
    ? `Genera preguntas sobre el siguiente tema: "${content.trim()}"\n\n`
    : '';

  const prompt = `Actúa como un profesor experto. ${sourceSection}${topicSection}Genera EXACTAMENTE 20 preguntas variadas. Mezcla los tipos como consideres más adecuado para evaluar el contenido.

TIPOS DE PREGUNTA:
- "single": 4 opciones, "answer" es un string con la opción correcta.
- "multi": 4 opciones, EXACTAMENTE 2 correctas, "answer" es un array con las dos opciones correctas.
- "tf": "options" debe ser exactamente ["Verdadero","Falso"], "answer" es un string.

Incluye también "time" (entre 15 y 60, en segundos) y "points" (50, 100, 200 o 500) según la dificultad.

RESPONDE ÚNICAMENTE con el array JSON. Sin texto adicional, sin markdown, sin explicaciones.`;

  try {
    const completion = await deepseek.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "deepseek-chat",
      temperature: 0.6,
      max_tokens: 12000,
    });

    let aiResponse = completion.choices[0].message.content || "";
    aiResponse = aiResponse.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "La IA no devolvió preguntas válidas. Intenta de nuevo." });
    }

    const questions = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(500).json({ error: "La IA devolvió un resultado vacío. Intenta de nuevo." });
    }

    const normalized = questions.map(q => ({
      time:     q.time     || 20,
      points:   q.points   || 100,
      type:     q.type     || "single",
      question: q.question || "",
      options:  q.options  || [],
      answer:   q.answer   ?? "",
    }));

    res.json({ success: true, questions: normalized });
  } catch (error) {
    console.error("Error en /generate-text:", error?.message || error);
    if (error?.status === 402) return res.status(500).json({ error: "Sin saldo en DeepSeek." });
    res.status(500).json({ error: "Error generando preguntas con IA. Intenta de nuevo." });
  }
});

app.post('/upload', upload.single('pdfFile'), async (req, res) => {
  const cleanupFile = () => {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  };

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se subió ningún archivo PDF." });
    }

    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdf(dataBuffer);
    const text = data.text?.trim() || "";

    if (text.length < 40) {
      cleanupFile();
      return res.status(400).json({
        error: "No se pudo leer texto del PDF. Asegúrate de que no sea solo imágenes o esté protegido."
      });
    }

    const usarNuevoPrompt = req.body.casillaMarcada === 'true';

    let instruccionesEspecificas = "";
    if (usarNuevoPrompt) {
      instruccionesEspecificas = `
El texto es un examen o cuestionario que YA CONTIENE preguntas y respuestas.
Tu tarea es EXTRAER un MÁXIMO DE 40 PREGUNTAS. Si hay menos, extrae solo las que haya.
REGLAS:
1. Mantén el orden exacto del documento original.
2. No inventes preguntas nuevas ni añadas información externa.
3. Asigna el tipo ("single", "multi" o "tf") según cómo vienen estructuradas en el original.`;
    } else {
      instruccionesEspecificas = `
Genera EXACTAMENTE 20 preguntas variadas.
Mezcla los tipos como consideres más adecuado para evaluar el contenido.`;
    }

    const prompt = `Actúa como un profesor experto. Basándote en el siguiente texto:

---
${text.substring(0, 90000)}
---

${instruccionesEspecificas}

TIPOS DE PREGUNTA:
- "single": 4 opciones, "answer" es un string con la opción correcta.
- "multi": 4 opciones, EXACTAMENTE 2 correctas, "answer" es un array con las dos opciones correctas.
- "tf": "options" debe ser exactamente ["Verdadero","Falso"], "answer" es un string.

Incluye también "time" (entre 15 y 60, en segundos) y "points" (50, 100, 200 o 500) según la dificultad.

RESPONDE ÚNICAMENTE con el array JSON. Sin texto adicional, sin markdown, sin explicaciones.

Ejemplo:
[{"type":"single","question":"¿Capital de Francia?","options":["Madrid","París","Roma","Berlín"],"answer":"París","time":20,"points":100}]`;

    const completion = await deepseek.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "deepseek-chat",
      temperature: 0.6,
      max_tokens: 12000,
    });

    let aiResponse = completion.choices[0].message.content || "";

    aiResponse = aiResponse.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("Respuesta de la IA sin JSON válido:", aiResponse.substring(0, 300));
      cleanupFile();
      return res.status(500).json({ error: "La IA no devolvió preguntas válidas. Intenta de nuevo." });
    }

    const questions = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(questions) || questions.length === 0) {
      cleanupFile();
      return res.status(500).json({ error: "La IA devolvió un resultado vacío. Intenta con otro PDF." });
    }

    const normalized = questions.map(q => ({
      time:    q.time    || 20,
      points:  q.points  || 100,
      type:    q.type    || "single",
      question: q.question || "",
      options:  q.options  || [],
      answer:   q.answer   ?? "",
    }));

    cleanupFile();
    res.json({ success: true, questions: normalized });

  } catch (error) {
    console.error("Error en /upload:", error?.message || error);
    cleanupFile();

    if (error?.status === 401) {
      return res.status(500).json({ error: "API Key de DeepSeek inválida. Verifica tu configuración." });
    }
    if (error?.status === 402) {
      return res.status(500).json({ error: "Sin saldo en DeepSeek. Recarga tu cuenta en platform.deepseek.com." });
    }
    if (error instanceof SyntaxError) {
      return res.status(500).json({ error: "La IA devolvió un formato inesperado. Intenta de nuevo." });
    }

    res.status(500).json({ error: "Error procesando el examen con IA. Intenta de nuevo." });
  }
});

// ── Health check (keeps Supabase DB active) ──
const db = require('./db');
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', mode: LOCAL_MODE ? 'local' : 'cloud', timestamp: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: 'ok', db: 'unreachable', mode: LOCAL_MODE ? 'local' : 'cloud', timestamp: new Date().toISOString() });
  }
});

// ── Modo local: servir el frontend desde public/ ──
if (LOCAL_MODE) {
  const publicDir = path.join(__dirname, '../public');
  if (fs.existsSync(path.join(publicDir, 'index.html'))) {
    app.use(express.static(publicDir, { index: false }));
    // SPA fallback: rutas no-API devuelven index.html
    app.get('/{*path}', (req, res, next) => {
      if (req.path.startsWith('/auth') || req.path.startsWith('/quizzes') ||
          req.path.startsWith('/assignments') || req.path.startsWith('/upload') ||
          req.path.startsWith('/generate') || req.path.startsWith('/health')) {
        return next();
      }
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  } else {
    console.warn('\n⚠  No se encontró public/index.html — ejecuta "npm run setup:local" primero.\n');
  }
}

// ── Helpers modo local ──
function getLocalIP() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

async function startupSync() {
  const localDb = require('./db/local');
  console.log('Sincronizando quizzes con la nube...');
  try {
    const result = await db.query('SELECT * FROM quizzes');
    const count = localDb.syncQuizzes(result.rows);
    console.log(`✓ ${count} quizzes sincronizados`);
  } catch {
    const data = require('./db/local').DATA_DIR;
    console.log(`⚠  Sin internet — usando datos en ${data}`);
  }
}

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", async () => {
  if (LOCAL_MODE) {
    const ip  = getLocalIP();
    const url = `http://${ip}:${PORT}`;
    console.log('\n╔═══════════════════════════════════════════════╗');
    console.log('║         CYRAQuiz  —  Modo Local               ║');
    console.log(`║  URL: ${url.padEnd(40)}║`);
    console.log('║  Comparte esta URL con tus estudiantes        ║');
    console.log('╚═══════════════════════════════════════════════╝\n');
    try {
      const qr = require('qrcode-terminal');
      qr.generate(url, { small: true });
    } catch { /* qrcode-terminal opcional */ }
    await startupSync();
  } else {
    console.log(`Server listening on port ${PORT}`);
  }
});
