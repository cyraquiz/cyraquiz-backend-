const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR    = path.join(os.homedir(), '.cyraquiz');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  DATA_DIR,

  saveUser({ id, email, passwordHash }) {
    const list = read(USERS_FILE).filter(u => u.email !== email);
    list.push({ id, email, passwordHash });
    write(USERS_FILE, list);
  },

  findUserByEmail(email) {
    return read(USERS_FILE).find(u => u.email === email) ?? null;
  },

  syncQuizzes(rows) {
    write(QUIZZES_FILE, rows);
    return rows.length;
  },

  getQuizzesByUser(userId) {
    return read(QUIZZES_FILE)
      .filter(q => String(q.user_id) === String(userId))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  getQuizById(id) {
    const q = read(QUIZZES_FILE).find(q => String(q.id) === String(id)) ?? null;
    if (q && typeof q.questions === 'string') {
      try { q.questions = JSON.parse(q.questions); } catch { q.questions = []; }
    }
    return q;
  },
};
