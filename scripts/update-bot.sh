#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${PM2_APP_NAME:-manguadu}"
PROJECT_DIR="${BOT_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${BOT_UPDATE_LOG_DIR:-$PROJECT_DIR/data}"
LOG_FILE="$LOG_DIR/update-bot.log"
BRANCH="${BOT_UPDATE_BRANCH:-}"

mkdir -p "$LOG_DIR"

exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "==== Atualizacao iniciada em $(date -Is) ===="
echo "Projeto: $PROJECT_DIR"
echo "PM2 app: $APP_NAME"

cd "$PROJECT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "ERRO: git nao encontrado na VM."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERRO: npm nao encontrado na VM."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: node nao encontrado na VM."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERRO: a pasta do bot nao e um repositorio git."
  echo "Coloque o bot em um repo na VM ou configure outro fluxo de deploy."
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git branch --show-current)"
fi

if [[ -z "$BRANCH" ]]; then
  echo "ERRO: nao consegui descobrir a branch atual."
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ERRO: existem alteracoes locais rastreadas na VM. Atualizacao abortada para nao sobrescrever nada."
  git status --short --untracked-files=no
  exit 1
fi

BEFORE="$(git rev-parse --short HEAD)"
echo "Commit atual: $BEFORE"
echo "Branch: $BRANCH"

git fetch --prune origin
git pull --ff-only origin "$BRANCH"

AFTER="$(git rev-parse --short HEAD)"
echo "Commit depois do pull: $AFTER"

echo "Instalando dependencias..."
npm ci --omit=dev

echo "Validando sintaxe..."
node --check index.js
if [[ -d lib ]]; then
  while IFS= read -r -d '' file; do
    node --check "$file"
  done < <(find lib -name '*.js' -print0)
fi

if [[ "${BOT_UPDATE_SKIP_RESTART:-0}" == "1" ]]; then
  echo "Reinicio pelo script pulado; o bot vai reiniciar via comando Discord."
else
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "ERRO: pm2 nao encontrado na VM."
    exit 1
  fi

  echo "Reiniciando PM2..."
  pm2 restart "$APP_NAME" --update-env
fi

echo "Atualizacao concluida em $(date -Is)"
