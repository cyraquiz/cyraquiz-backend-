/**
 * setup-local.js  —  Configuración / actualización del modo local
 * Ejecutar cada vez que quieras actualizar CYRAQuiz:
 *   node scripts/setup-local.js
 *
 * Qué hace:
 *   1. Verifica Node.js >= 18
 *   2. Descarga el código más reciente del frontend desde GitHub
 *   3. Actualiza archivos clave del backend (server.js, rutas, etc.)
 *   4. Instala dependencias y construye el frontend
 *   5. Copia dist/ → backend/public/
 *   6. Verifica que .env existe
 */

const https      = require('https');
const { spawnSync } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const ROOT   = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// ── 1. Versión de Node ────────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`✗ Se necesita Node.js 18 o superior. Tienes v${process.versions.node}.`);
  process.exit(1);
}
console.log(`✓ Node.js v${process.versions.node}`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

/** Descarga una URL (sigue hasta 5 redirects) a un archivo local. */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'cyraquiz-setup/1.0' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          if (++redirects > 5) return reject(new Error('Demasiados redirects'));
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} al descargar ${u}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error',  reject);
        res.on('error',   reject);
      }).on('error', reject);
    };
    get(url);
  });
}

/** Extrae un .zip usando tar (disponible en Windows 10+ y en macOS/Linux). */
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { shell: true, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar falló al extraer el ZIP');
}

// ── 2. Actualizar código del frontend desde GitHub ────────────────────────────
const FRONTEND_CANDIDATES = [
  path.join(ROOT, '..', 'cyraquiz-frontend-main'),
  path.join(ROOT, '..', 'cyraquiz-frontend'),
  path.join(ROOT, '..', 'frontend'),
];

let frontendDir = FRONTEND_CANDIDATES.find(c => fs.existsSync(path.join(c, 'package.json')))
               || FRONTEND_CANDIDATES[0]; // default: cyraquiz-frontend-main

const FRONTEND_REPO = 'cyraquiz/cyraquiz-frontend';
const FRONTEND_ZIP  = `https://github.com/${FRONTEND_REPO}/archive/refs/heads/main.zip`;

// ── 3. Actualizar archivos clave del backend ──────────────────────────────────
const BACKEND_REPO  = 'cyraquiz/cyraquiz-backend-';
const BACKEND_FILES = [
  'src/server.js',
  'src/routes/auth.js',
  'src/routes/quizzes.js',
  'src/middleware/authorization.js',
  'src/db/local.js',
];

(async () => {
  // ── Intentar git pull primero ──────────────────────────────────────────────
  const hasGit = spawnSync('git', ['--version'], { shell: true }).status === 0;

  if (hasGit) {
    console.log('\nActualizando backend con git pull...');
    spawnSync('git', ['pull'], { cwd: ROOT, stdio: 'inherit', shell: true });

    if (fs.existsSync(path.join(frontendDir, '.git'))) {
      console.log('Actualizando frontend con git pull...');
      spawnSync('git', ['pull'], { cwd: frontendDir, stdio: 'inherit', shell: true });
    } else {
      await downloadAndExtractFrontend();
    }
  } else {
    console.log('\nGit no instalado — descargando actualizaciones desde GitHub...');
    await updateBackendFiles();
    await downloadAndExtractFrontend();
  }

  buildAndDeploy();
})();

// ── Descarga y extrae el frontend ZIP ─────────────────────────────────────────
async function downloadAndExtractFrontend() {
  const tmp = os.tmpdir();
  const zipPath     = path.join(tmp, 'cyraquiz-frontend.zip');
  const extractDir  = path.join(tmp, 'cyraquiz-frontend-extract');

  process.stdout.write('Descargando frontend... ');
  try {
    await downloadFile(FRONTEND_ZIP, zipPath);
    console.log('✓');
  } catch (e) {
    console.warn(`\n⚠  No se pudo descargar el frontend: ${e.message}`);
    console.warn('   Continuando con el código local existente.\n');
    return;
  }

  process.stdout.write('Extrayendo... ');
  try {
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    extractZip(zipPath, extractDir);
    console.log('✓');
  } catch (e) {
    console.warn(`\n⚠  No se pudo extraer el ZIP: ${e.message}`);
    return;
  }

  // El ZIP extrae a cyraquiz-frontend-main (nombre del repo)
  const extracted = path.join(extractDir, 'cyraquiz-frontend-main');
  if (!fs.existsSync(extracted)) {
    console.warn('⚠  No se encontró la carpeta dentro del ZIP. Continuando con código local.');
    return;
  }

  // Reemplazar carpeta del frontend (guardando node_modules si existen)
  const nmBackup = path.join(tmp, 'cyraquiz-nm-backup');
  const nm = path.join(frontendDir, 'node_modules');
  if (fs.existsSync(nm)) {
    process.stdout.write('Preservando node_modules... ');
    if (fs.existsSync(nmBackup)) fs.rmSync(nmBackup, { recursive: true, force: true });
    fs.renameSync(nm, nmBackup);
    console.log('✓');
  }

  if (fs.existsSync(frontendDir)) fs.rmSync(frontendDir, { recursive: true, force: true });
  copyDir(extracted, frontendDir);

  if (fs.existsSync(nmBackup)) {
    fs.renameSync(nmBackup, nm);
  }

  fs.rmSync(extractDir, { recursive: true, force: true });
  try { fs.unlinkSync(zipPath); } catch {}
  console.log(`✓ Frontend actualizado en: ${frontendDir}`);
}

// ── Descarga archivos individuales del backend ─────────────────────────────────
async function updateBackendFiles() {
  let updated = 0;
  for (const file of BACKEND_FILES) {
    const url      = `https://raw.githubusercontent.com/${BACKEND_REPO}/main/${file}`;
    const destPath = path.join(ROOT, file);
    process.stdout.write(`  Actualizando ${file}... `);
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      await downloadFile(url, destPath);
      console.log('✓');
      updated++;
    } catch (e) {
      console.warn(`⚠  (sin internet o error: ${e.message})`);
    }
  }
  if (updated > 0) console.log(`✓ ${updated} archivos del backend actualizados`);
}

// ── Build y deploy ─────────────────────────────────────────────────────────────
function buildAndDeploy() {
  // Verificar que existe el frontend
  if (!fs.existsSync(path.join(frontendDir, 'package.json'))) {
    console.error('✗ No se encontró package.json del frontend.');
    process.exit(1);
  }
  console.log(`\n✓ Frontend en: ${frontendDir}`);

  // npm install
  console.log('\nInstalando dependencias del frontend...');
  let result = spawnSync('npm', ['install'], { cwd: frontendDir, stdio: 'inherit', shell: true });
  if (result.status !== 0) { console.error('✗ npm install falló'); process.exit(1); }

  // npm run build
  console.log('\nConstruyendo el frontend...');
  result = spawnSync('npm', ['run', 'build'], { cwd: frontendDir, stdio: 'inherit', shell: true });
  if (result.status !== 0) { console.error('✗ npm run build falló'); process.exit(1); }

  // Copiar dist/ → public/
  const distDir = path.join(frontendDir, 'dist');
  if (!fs.existsSync(distDir)) {
    console.error('✗ No se encontró dist/ después del build.');
    process.exit(1);
  }
  if (fs.existsSync(PUBLIC)) fs.rmSync(PUBLIC, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC, { recursive: true });
  copyDir(distDir, PUBLIC);
  console.log(`✓ Frontend copiado a ${PUBLIC}`);

  // Verificar .env
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) {
    console.warn('\n⚠  No se encontró .env');
    console.warn('   Crea un .env con: DATABASE_URL=... SUPABASE_URL=... SUPABASE_KEY=... LOCAL_MODE=true');
  } else {
    const env = fs.readFileSync(envFile, 'utf8');
    if (!env.includes('LOCAL_MODE=true')) console.warn('\n⚠  Agrega LOCAL_MODE=true a tu .env');
    console.log('✓ Archivo .env encontrado');
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  ✓ CYRAQuiz actualizado y listo          ║');
  console.log('║                                          ║');
  console.log('║  Para iniciar el servidor:               ║');
  console.log('║    node src/server.js                    ║');
  console.log('╚══════════════════════════════════════════╝\n');
}
