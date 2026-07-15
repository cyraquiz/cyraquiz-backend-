if (process.env.NODE_ENV !== 'production') {
  require("dotenv").config();
}
const { randomUUID } = require('crypto');
const authRoutes        = require('./routes/auth');
const quizRoutes        = require('./routes/quizzes');
const assignmentRoutes  = require('./routes/assignments');
const studentRoutes     = require('./routes/student');
const authorization     = require('./middleware/authorization');
const studentAuth       = require('./middleware/studentAuth');
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

// ── Supabase Storage (cloud mode) ──
let supabaseStorage = null;
if (!LOCAL_MODE && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabaseStorage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // Auto-create the public bucket if it doesn't exist yet
  supabaseStorage.storage.createBucket('quiz-images', {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  }).then(({ error }) => {
    if (error && !error.message?.includes('already exist') && !error.message?.includes('Duplicate')) {
      console.error('quiz-images bucket error:', error.message);
    } else {
      console.log('Supabase Storage bucket "quiz-images" listo.');
    }
  });
}

const app = express();

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

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
app.use('/student', studentAuth, studentRoutes);

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
      questionHistory: [],
      teamMode: false,
      teams: [],
      autoAssign: false,
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

    if (room.teamMode && room.teams.length) {
      if (room.autoAssign && !existingPlayer) {
        const smallest = room.teams.reduce((m, t) => t.players.length < m.players.length ? t : m, room.teams[0]);
        smallest.players.push(safeName);
        const newP = room.players[room.players.length - 1];
        newP.teamId    = smallest.id;
        newP.teamName  = smallest.name;
        newP.teamColor = smallest.color;
        io.to(roomStr).emit("team_updated", { teams: room.teams });
      }
      socket.emit("teams_configured", { teams: room.teams, autoAssign: room.autoAssign });
    }

    if (room.isGameOver && room.finalResults) {
      socket.emit("final_results", room.finalResults);
      if (room.teamMode && room.teamResults) socket.emit("team_results", room.teamResults);
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
        image:    room.currentImage || null,
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
    room.currentImage = question.image || null;
    room.answerCounts = [0, 0, 0, 0];
    room.textAnswers = [];
    room.questionStartTime = Date.now();
    room.currentTimeLimit = time;
    room.isAnswering = true;
    room.isShowingResults = false;
    if (!room.questionHistory) room.questionHistory = [];
    room.questionHistory.push({
      index: room.questionHistory.length,
      question: question.question || "",
      type: question.type,
      options: question.options,
      correctAnswer: question.answer,
      points: question.points || 100,
      playerAnswers: [],
      startTime: room.questionStartTime,
    });

    io.to(roomStr).emit("new_question", {
      type:           question.type,
      question:       question.question || "",
      options:        question.options,
      answer:         question.answer,
      time:           time,
      points:         question.points || 100,
      min:            question.min ?? 0,
      max:            question.max ?? 100,
      image:          question.image || null,
      powerUpsEnabled: !!room.powerUpsEnabled,
      examMode:        !!room.examMode,
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

      if (room.currentQuestionType === "text" && typeof answer === "string") {
        if (!room.textAnswers) room.textAnswers = [];
        room.textAnswers.push(answer.trim());
        io.to(roomStr).emit("update_text_answers", room.textAnswers);
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
      let pointsEarned = isCorrect ? room.currentPoints : 0;

      if (room.powerUpsEnabled) {
        if (isCorrect && player.doubleActive) {
          pointsEarned *= 2;
          player.doubleActive = false;
        }
        if (!isCorrect && player.shieldActive) {
          pointsEarned = Math.floor(room.currentPoints * 0.5);
          player.shieldActive = false;
        }
      }

      player.score += pointsEarned;

      if (isCorrect) {
        player.timeAccumulated += timeTaken;
      }

      if (room.questionHistory && room.questionHistory.length > 0) {
        const currentQ = room.questionHistory[room.questionHistory.length - 1];
        currentQ.playerAnswers.push({ name: playerName, answer, isCorrect, timeTaken, pointsEarned });
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

  // CONFIGURAR EQUIPOS (host)
  socket.on("enable_teams", ({ roomCode, hostToken, teams, autoAssign }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr) || !validateHostToken(roomStr, hostToken)) {
      socket.emit("error", "No autorizado");
      return;
    }
    const room = rooms.get(roomStr);
    if (!room) return;
    room.teamMode = true;
    room.autoAssign = !!autoAssign;
    room.teams = teams.map(t => ({ ...t, players: [] }));

    if (autoAssign && room.players.length > 0) {
      room.players.forEach((p, i) => {
        const team = room.teams[i % room.teams.length];
        team.players.push(p.name);
        p.teamId    = team.id;
        p.teamName  = team.name;
        p.teamColor = team.color;
      });
    }

    io.to(roomStr).emit("teams_configured", { teams: room.teams, autoAssign: room.autoAssign });
    console.log(`Equipos activados en sala ${roomStr}`);
  });

  // UNIRSE A UN EQUIPO (estudiante)
  socket.on("join_team", ({ roomCode, playerName, teamId }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr)) return;
    const room = rooms.get(roomStr);
    if (!room || !room.teamMode) return;
    const player = room.players.find(p => p.name === playerName);
    if (!player) return;

    room.teams.forEach(t => { t.players = t.players.filter(n => n !== playerName); });
    const team = room.teams.find(t => t.id === teamId);
    if (team) {
      team.players.push(playerName);
      player.teamId    = teamId;
      player.teamName  = team.name;
      player.teamColor = team.color;
    }
    io.to(roomStr).emit("team_updated", { teams: room.teams });
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

        if (room.teamMode && room.teams.length > 0) {
          room.teamResults = room.teams.map(team => {
            const members = team.players
              .map(name => room.players.find(p => p.name === name))
              .filter(Boolean);
            const totalScore = members.reduce((s, p) => s + (p.score || 0), 0);
            const avgScore   = members.length ? Math.round(totalScore / members.length) : 0;
            const avgTime    = members.length
              ? Math.round(members.reduce((s, p) => s + (p.timeAccumulated || 0), 0) / members.length) : 0;
            return {
              id: team.id, name: team.name, color: team.color,
              avgScore, totalScore, avgTime,
              members: members.map(p => ({ name: p.name, avatar: p.avatar, score: p.score })),
            };
          }).sort((a, b) => b.avgScore !== a.avgScore ? b.avgScore - a.avgScore : a.avgTime - b.avgTime);
        }

        console.log(`Juego terminado en sala ${roomStr}`);
      }

      const broadcast = () => {
        if (!rooms.has(roomStr)) return;
        const r = rooms.get(roomStr);
        io.to(roomStr).emit("final_results", r.finalResults);
        for (const player of r.players) {
          if (player.id) io.to(player.id).emit("final_results", r.finalResults);
        }
        if (r.teamMode && r.teamResults) {
          io.to(roomStr).emit("team_results", r.teamResults);
          for (const player of r.players) {
            if (player.id) io.to(player.id).emit("team_results", r.teamResults);
          }
        }
      };

      // Solo iniciar UN loop de reintento por sala
      if (!room.broadcastStarted) {
        room.broadcastStarted = true;
        broadcast();
        let retries = 0;
        const retryId = setInterval(() => {
          retries++;
          broadcast();
          if (retries >= 15) clearInterval(retryId);
        }, 1000);
      } else {
        broadcast();
      }
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

  socket.on("enable_powerups", ({ roomCode, hostToken }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr) || !validateHostToken(roomStr, hostToken)) return;
    const room = rooms.get(roomStr);
    if (!room) return;
    room.powerUpsEnabled = true;
    console.log(`Power-ups activados en sala ${roomStr}`);
  });

  socket.on("enable_exam", ({ roomCode, hostToken }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr) || !validateHostToken(roomStr, hostToken)) return;
    const room = rooms.get(roomStr);
    if (!room) return;
    room.examMode = true;
    console.log(`Modo Examen activado en sala ${roomStr}`);
  });

  socket.on("use_powerup", ({ roomCode, playerName, type }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr)) return;
    const room = rooms.get(roomStr);
    if (!room || !room.powerUpsEnabled) return;
    const player = room.players.find(p => p.name === playerName);
    if (!player) return;

    if (type === "fifty_fifty") {
      const options = room.currentOptions || [];
      const correct = room.currentCorrectAnswer;
      const wrongIdxs = options
        .map((opt, i) => ({ opt, i }))
        .filter(({ opt }) => Array.isArray(correct) ? !correct.includes(opt) : opt !== correct)
        .map(({ i }) => i);
      const eliminated = wrongIdxs.sort(() => Math.random() - 0.5).slice(0, 2);
      socket.emit("powerup_applied", { type: "fifty_fifty", eliminated });
    } else if (type === "double") {
      player.doubleActive = true;
      socket.emit("powerup_applied", { type: "double" });
    } else if (type === "shield") {
      player.shieldActive = true;
      socket.emit("powerup_applied", { type: "shield" });
    }
  });

  socket.on("send_reaction", ({ roomCode, emoji }) => {
    const roomStr = roomCode?.toString();
    if (!validateRoomCode(roomStr)) return;
    socket.to(roomStr).emit("reaction", { emoji });
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

// ── Subida de imágenes para preguntas ──
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido'), false);
  },
});

app.post('/upload-image', authorization, imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  const ext = req.file.mimetype === 'image/jpeg' ? 'jpg'
    : req.file.mimetype === 'image/png'  ? 'png'
    : req.file.mimetype === 'image/webp' ? 'webp' : 'gif';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  if (LOCAL_MODE) {
    const uploadsDir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, filename), req.file.buffer);
    return res.json({ url: `/uploads/${filename}` });
  }

  if (!supabaseStorage) return res.status(500).json({ error: 'Almacenamiento no configurado' });

  const { error } = await supabaseStorage.storage
    .from('quiz-images')
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (error) {
    console.error('Supabase storage error:', error.message);
    return res.status(500).json({ error: 'Error al subir imagen: ' + error.message });
  }

  const { data } = supabaseStorage.storage.from('quiz-images').getPublicUrl(filename);
  return res.json({ url: data.publicUrl });
});

// ── Estado del juego (HTTP polling fallback) ──
app.get('/game-state/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode?.toString();
  if (!validateRoomCode(roomCode)) return res.json({ status: 'not_found' });
  const room = rooms.get(roomCode);
  if (!room) return res.json({ status: 'not_found' });
  if (room.isGameOver && room.finalResults) {
    return res.json({ status: 'over', players: room.finalResults, teams: room.teamResults || null });
  }
  if (room.isShowingResults) return res.json({ status: 'results' });
  return res.json({ status: 'active' });
});

// ── Reporte post-partida ──
app.get('/reports/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode?.toString();
  if (!validateRoomCode(roomCode)) return res.status(400).json({ error: 'Código inválido' });
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: 'Sala no encontrada' });
  return res.json({
    players: room.finalResults || room.players,
    questions: room.questionHistory || [],
  });
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
