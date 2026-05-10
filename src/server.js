if (process.env.NODE_ENV !== 'production') {
  require("dotenv").config();
}
const authRoutes = require('./routes/auth');
const quizRoutes = require('./routes/quizzes');
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const pdf = require("pdf-extraction");
const OpenAI = require("openai");

const app = express();

const allowedOrigins = [
  "https://cyraquiz.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/quizzes', quizRoutes);

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
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  // CREAR SALA
  socket.on("create_room", (roomCode) => {
   rooms.set(roomCode, { players: [], currentQuestion: 0, scores: {}, answerCounts: [0, 0, 0, 0] });
    socket.join(roomCode);
    console.log(`Sala creada: ${roomCode}`);
  });

  // UNIRSE A SALA
  socket.on("join_room", ({ roomCode, playerName, avatar }) => {
if (!rooms.has(roomCode)) {
       console.log(`Recuperando sala ${roomCode} para ${playerName}`);
       rooms.set(roomCode, { players: [], currentQuestion: 0, scores: {}, answerCounts: [0, 0, 0, 0] });
    }
    
      const room = rooms.get(roomCode);
      const existingPlayer = room.players.find(p => p.name === playerName);
      
      if (!existingPlayer) {
        room.players.push({ 
          id: socket.id, 
          name: playerName, 
          avatar: avatar || "https://api.dicebear.com/9.x/notionists/svg?seed=default",
          score: 0,
          timeAccumulated: 0
        });
      }else {
        existingPlayer.id = socket.id;
        console.log(`Jugador ${playerName} recuperó su sesión con nuevo ID.`);
      }

      socket.join(roomCode);
      io.to(roomCode).emit("player_joined", { name: playerName, avatar });
      console.log(`${playerName} entró a la sala ${roomCode}`);
      if (room.isAnswering && room.currentOptions) {
      console.log(`Rescatando a ${playerName}: Enviando pregunta en curso.`);
      socket.emit("new_question", {
        type: room.currentQuestionType,
        options: room.currentOptions,
        time: room.currentTimeLimit 
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

  socket.on("send_question", ({ roomCode, question, time }) => {
    const roomStr = roomCode.toString();
    if (rooms.has(roomStr)) {
      const room = rooms.get(roomStr);
      room.currentCorrectAnswer = question.answer; 
      room.currentPoints = question.points || 100; 
      room.currentQuestionType = question.type;
      room.currentOptions = question.options;
      room.answerCounts = [0, 0, 0, 0]; 
      room.questionStartTime = Date.now();
      room.currentTimeLimit = time; 
      room.isAnswering = true;
    }

    io.to(roomStr).emit("new_question", { 
      type: question.type, 
      options: question.options, 
      time: time 
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
  
socket.on("show_results", (roomCode) => {
    const roomStr = roomCode.toString();
    if (rooms.has(roomStr)) {
      rooms.get(roomStr).isAnswering = false; 
    }
    io.to(roomStr).emit("reveal_results");
  });

  // FIN DEL JUEGO
  socket.on("game_over", (roomCode) => {
    const roomStr = roomCode.toString();
    if (rooms.has(roomStr)) {
      const room = rooms.get(roomStr);
      const sortedPlayers = room.players.sort((a, b) => {
        if (b.score === a.score) {
          return a.timeAccumulated - b.timeAccumulated;
        }
        return b.score - a.score; 
      });
      
      io.to(roomStr).emit("final_results", sortedPlayers);
      console.log(`Juego terminado en sala ${roomStr}`);
    }
  });

  socket.on("cancel_game", (roomCode) => {
    const roomStr = roomCode.toString();
    io.to(roomStr).emit("game_cancelled");
    
    rooms.delete(roomStr);
    console.log(`Partida cancelada en sala ${roomStr}`);
  });

  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
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

    // ── Extraer texto del PDF ──────────────────────────
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

    // ── Llamada a DeepSeek ─────────────────────────────
    const completion = await deepseek.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "deepseek-chat",
      temperature: 0.6,
      max_tokens: 12000,
    });

    let aiResponse = completion.choices[0].message.content || "";

    // ── Extracción robusta del JSON ────────────────────
    // Quitar bloques markdown si los hay
    aiResponse = aiResponse.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

    // Encontrar el array JSON aunque haya texto antes/después
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

    // Asegurar campos mínimos en cada pregunta
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

// ── Health check (usado por GitHub Actions keep-alive) ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});