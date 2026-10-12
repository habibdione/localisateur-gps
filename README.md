# Localisateur GPS

Retrouver mes téléphones : **carte + recherche par numéro**, position en temps réel.

```
┌──────────────────┬────────────────────────────┐
│  Numéro  [78...] │                            │
│  → Localiser     │     carte OpenStreetMap    │
│                  │        📍 position         │
│  Lat / Lon       │        + cercle précision  │
│  Précision ±9 m  │        + trajet            │
│  Batterie  60 %  │                            │
│  Itinéraire      │                            │
└──────────────────┴────────────────────────────┘
```

---

## À lire d'abord : ce qui est possible, et ce qui ne l'est pas

**Un numéro seul ne permet pas de localiser un téléphone.** La localisation à partir du
seul numéro passe par le réseau de l'opérateur (SS7/HLR) : c'est réservé aux opérateurs
et aux autorités judiciaires. Aucune application ne peut le faire — celles qui le
promettent sont des arnaques.

Ce qui fonctionne, et que fait cette application (c'est le principe de « Localiser mon
appareil » de Google) :

1. Le téléphone ouvre **une fois** la page `/tracker` et s'enregistre avec son numéro.
2. Il envoie ensuite sa position GPS au serveur, en continu.
3. Depuis n'importe quel navigateur, vous tapez le numéro → sa position s'affiche.

**Conséquence importante :** le suivi en direct exige que la page reste ouverte sur le
téléphone. Dès que l'écran se verrouille ou que le téléphone s'éteint, l'émission
s'arrête — mais **la dernière position connue reste enregistrée** sur le serveur, avec
son horodatage. C'est précisément ce dont on a besoin pour retrouver un téléphone perdu.

---

## Démarrage

```bash
node server.js
```

Aucune dépendance à installer : le serveur n'utilise que Node (v18+).

Au premier lancement, `config.json` est créé avec une **clé d'accès** aléatoire. La
console affiche les deux liens :

```
Tableau de bord : http://localhost:3000/?k=VOTRE_CLE
Page téléphone  : http://localhost:3000/tracker?k=VOTRE_CLE
```

Cette clé protège vos positions : **ne la partagez pas**. Pour la changer, modifiez
`config.json` (ou définissez la variable d'environnement `ACCESS_KEY`).

---

## Mettre en ligne — l'étape indispensable

Sur le réseau local (`http://192.168.x.x`), **les navigateurs mobiles refusent le GPS** :
la géolocalisation exige HTTPS. Et de toute façon, un téléphone perdu n'est pas sur
votre WiFi. Il faut donc une adresse publique en HTTPS.

### Option A — hébergement gratuit (recommandé)

Sur [Render](https://render.com) ou [Railway](https://railway.app) :

1. Poussez ce dossier sur un dépôt GitHub (**sans** `config.json` ni `data/`).
2. Nouveau *Web Service* → branche le dépôt.
3. Build : *(vide)* · Start : `node server.js`
4. Variable d'environnement : `ACCESS_KEY` = une longue chaîne secrète à vous.

Vous obtenez `https://mon-app.onrender.com` — le GPS fonctionnera.

> Sur une offre gratuite, le disque est éphémère : `data/devices.json` peut être remis à
> zéro après une mise en veille. Pour conserver l'historique durablement, ajoutez un
> disque persistant (payant) ou une base externe.

### Option B — tunnel depuis ce PC (pour tester tout de suite)

```bash
# serveur déjà lancé sur le port 3000
cloudflared tunnel --url http://localhost:3000
```

Cloudflare renvoie une URL `https://xxxx.trycloudflare.com` : ouvrez-la sur le téléphone.
Elle reste valide tant que la commande tourne.

---

## Enregistrer un téléphone

1. Sur le **téléphone à suivre**, ouvrez `https://.../tracker?k=VOTRE_CLE`
   (le tableau de bord propose « Copier le lien »).
2. Saisissez son numéro, puis **Démarrer le suivi**.
3. Autorisez la localisation — choisissez **« Toujours autoriser »** si proposé.
4. Pour un suivi durable : ajoutez la page à l'écran d'accueil, et désactivez la mise en
   veille de l'écran pendant les trajets.

Ensuite, depuis n'importe quel appareil, ouvrez le tableau de bord et tapez le numéro.

Le numéro est reconnu sous toutes ses formes : `+221 78 302 15 53`, `00221783021553` et
`783021553` désignent le même appareil (identifié par ses **9 derniers chiffres**).

---

## Ce que montre le tableau de bord

| Élément | Détail |
|---|---|
| **État** | 🟢 En direct (< 90 s) · 🟡 Position récente (< 30 min) · ⚪ Hors ligne |
| **Carte** | Marqueur + cercle de précision + trajet des derniers points |
| **Fiche** | Latitude, longitude, précision, batterie, vitesse, altitude, horodatage |
| **Itinéraire** | Ouvre Google Maps pour aller jusqu'au téléphone |
| **Mes appareils** | Tous les téléphones enregistrés, triés par fraîcheur |

La carte se met à jour **toute seule** (flux SSE) dès qu'une nouvelle position arrive.
Faites glisser la carte à la main pour suspendre le recentrage automatique ; le bouton
« Centrer » le réactive.

---

## Structure

```
server.js            serveur HTTP + API + flux temps réel (zéro dépendance)
config.json          clé d'accès (généré au 1er lancement — à garder privé)
data/devices.json    positions et historique (généré)
public/
  index.html  app.js      tableau de bord : carte + recherche
  tracker.html tracker.js page ouverte sur le téléphone
  style.css              interface commune
```

### API

| Route | Rôle |
|---|---|
| `POST /api/ping` | le téléphone envoie sa position (clé dans le corps) |
| `GET /api/device?phone=…&history=1` | dernière position + trajet |
| `GET /api/devices` | liste des appareils enregistrés |
| `GET /api/events?phone=…` | flux SSE temps réel |
| `DELETE /api/device?phone=…` | supprime un appareil |

Toutes les routes exigent la clé (`k=` en query, ou `key` dans le corps du ping).

---

## Limites connues

- **Suivi en arrière-plan** : un navigateur mobile suspend le GPS quand l'écran
  s'éteint. Pour une émission vraiment continue (écran éteint, au redémarrage), il faut
  une application Android native avec un service de premier plan — c'est l'évolution
  naturelle de ce projet, le serveur ici n'aurait pas à changer.
- **Téléphone éteint ou sans réseau** : seule la dernière position connue est
  disponible. C'est aussi la limite de « Localiser mon appareil ».
- **Précision** : 5–20 m en extérieur avec le GPS actif, bien davantage en intérieur
  (position déduite du WiFi). Le cercle sur la carte indique la marge réelle.

## Vie privée

N'installez ce suivi que sur **vos propres appareils**, ou avec l'accord explicite de
leur propriétaire. Suivre la position d'une personne à son insu est illégal.
`config.json` et `data/` contiennent des données personnelles : ne les publiez jamais sur
un dépôt public.
