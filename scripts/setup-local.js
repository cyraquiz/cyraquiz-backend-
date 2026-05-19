/**
 * setup-local.js
 * Ejecutar UNA SOLA VEZ en la computadora del laboratorio:
 *   node scripts/setup-local.js
 *
 * Qué hace:
 *   1. Verifica que Node.js >= 18
 *   2. Busca la carpeta del frontend (sibling directory)
 *   3. Construye el frontend (npm run build)
 *   4. Copia dist/ → backend/public/
 *   5. Verifica que .env existe
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const PUBLIC  = path.join(ROOT, 'public');

// ── 1. Versión de Node ──
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`✗ Se necesita Node.js 18 o superior. Tienes v${process.versions.node}.`);
  process.exit(1);
}
console.log(`✓ Node.js v${process.versions.node}`);

// ── 2. Localizar el frontend ──
const FRONTEND_CANDIDATES = [
  path.join(ROOT, '..', 'cyraquiz-frontend-main'),
  path.join(ROOT, '..', 'cyraquiz-frontend'),
  path.join(ROOT, '..', 'frontend'),
];

let frontendDir = null;
for (const candidate of FRONTEND_CANDIDATES) {
  if (fs.existsSync(path.join(candidate, 'package.json'))) {
    frontendDir = candidate;
    break;
  }
}

if (!frontendDir) {
  console.error('✗ No se encontró la carpeta del frontend.');
  console.error('  Coloca el frontend junto a este backend y que se llame "cyraquiz-frontend-main" o "cyraquiz-frontend".');
  process.exit(1);
}
console.log(`✓ Frontend encontrado en: ${frontendDir}`);

// ── 3. Construir el frontend ──
console.log('\nInstalando dependencias del frontend...');
let result = spawnSync('npm', ['install'], { cwd: frontendDir, stdio: 'inherit', shell: true });
if (result.status !== 0) { console.error('✗ npm install falló'); process.exit(1); }

console.log('\nConstruyendo el frontend...');
result = spawnSync('npm', ['run', 'build'], { cwd: frontendDir, stdio: 'inherit', shell: true });
if (result.status !== 0) { console.error('✗ npm run build falló'); process.exit(1); }

// ── 4. Copiar dist/ → public/ ──
const distDir = path.join(frontendDir, 'dist');
if (!fs.existsSync(distDir)) {
  console.error('✗ No se encontró la carpeta dist/ después del build.');
  process.exit(1);
}

if (fs.existsSync(PUBLIC)) fs.rmSync(PUBLIC, { recursive: true, force: true });
fs.mkdirSync(PUBLIC, { recursive: true });

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

copyDir(distDir, PUBLIC);
console.log(`✓ Frontend copiado a ${PUBLIC}`);

// ── 5. Verificar .env ──
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  console.warn('\n⚠  No se encontró el archivo .env');
  console.warn('   Crea un archivo .env con:');
  console.warn('     DATABASE_URL=postgres://...');
  console.warn('     SUPABASE_URL=https://...');
  console.warn('     SUPABASE_KEY=...');
  console.warn('     LOCAL_MODE=true');
} else {
  const env = fs.readFileSync(envFile, 'utf8');
  if (!env.includes('LOCAL_MODE=true')) {
    console.warn('\n⚠  Agrega LOCAL_MODE=true a tu archivo .env');
  }
  console.log('✓ Archivo .env encontrado');
}

console.log('\n╔═══════════════════════════════════════╗');
console.log('║  ✓ Configuración completada           ║');
console.log('║                                       ║');
console.log('║  Para iniciar el servidor local:      ║');
console.log('║    npm run local        (Mac/Linux)   ║');
console.log('║    npm run local:win    (Windows)     ║');
console.log('╚═══════════════════════════════════════╝\n');
