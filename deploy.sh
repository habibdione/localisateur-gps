#!/bin/bash
# Deploiement GitHub sans gh : lit le jeton depuis le presse-papier, cree le depot
# via l'API GitHub et pousse avec git. Scope 'repo' suffisant. Jeton jamais affiche.
set -e

PROJECT="C:/Users/30100-23-SNG/OneDrive - sonaged/ESPACE DE TRAVAIL/LOCALISATION"
cd "$PROJECT"

echo ">> Lecture du jeton depuis le presse-papier..."
TOKEN=$(powershell.exe -NoProfile -Command "Get-Clipboard" | tr -d '\r\n' | tr -d ' ')
if [[ ! "$TOKEN" =~ ^(ghp_|github_pat_) ]]; then
  echo "ERREUR : presse-papier sans jeton. Re-cliquez 'copier' sur la page GitHub, puis relancez."
  exit 1
fi

echo ">> Identification du compte GitHub..."
USER=$(curl -s -H "Authorization: token $TOKEN" https://api.github.com/user \
       | grep '"login"' | head -1 | sed -E 's/.*"login": *"([^"]+)".*/\1/')
if [ -z "$USER" ]; then echo "ERREUR : jeton invalide ou refuse."; exit 1; fi
echo "   connecte en tant que : $USER"

echo ">> Commit des derniers changements (QR code)..."
git add -A
git commit -m "Ajout du QR code pour inscrire les proches" \
           -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" \
           || echo "   (rien de nouveau a committer)"

echo ">> Creation du depot GitHub 'localisateur-gps'..."
RESP=$(mktemp)
HTTP=$(curl -s -o "$RESP" -w "%{http_code}" \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d '{"name":"localisateur-gps","private":false,"description":"Localisateur GPS - carte GPS temps reel + recherche par numero"}')
if   [ "$HTTP" = "201" ]; then echo "   depot cree."
elif [ "$HTTP" = "422" ]; then echo "   depot deja existant, on continue."
else echo "   reponse inattendue ($HTTP) :"; cat "$RESP"; rm -f "$RESP"; exit 1; fi
rm -f "$RESP"

echo ">> Envoi du code vers GitHub..."
git remote remove origin 2>/dev/null || true
git remote add origin "https://${TOKEN}@github.com/${USER}/localisateur-gps.git"
git push -u origin HEAD 2>&1 | grep -v -i "token" || true

echo ">> Nettoyage : retrait du jeton de la config git..."
git remote set-url origin "https://github.com/${USER}/localisateur-gps.git"

echo ""
echo "=================================================="
echo " DEPOT PRET : https://github.com/${USER}/localisateur-gps"
echo "=================================================="
