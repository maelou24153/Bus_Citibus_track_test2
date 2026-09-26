# Citibus Narbonne — Suivi des bus en temps réel

Prototype gratuit et open-source qui affiche sur une carte :
- 🚍 la position en temps réel des bus (GTFS-RT), rafraîchie toutes les 5 secondes,
  avec un mouvement fluide entre deux positions réelles (voir plus bas). Chaque
  bus est dessiné **dans la couleur officielle de sa ligne**, avec le **numéro
  de ligne affiché directement dessus** (toujours lisible, même quand le bus
  pivote selon son cap GPS réel)
- ● tous les arrêts du réseau, avec un interrupteur pour ne garder que ceux
  desservis par une ligne actuellement en circulation
- — le tracé de chaque ligne, dont la partie déjà parcourue par le bus en
  cours de trajet s'affiche en transparent (le reste du trajet reste bien visible)
- 👆 la sélection d'un bus (clic dessus) : seule sa ligne reste affichée, avec
  le trajet à venir en couleur pleine et le trajet déjà fait en transparent ;
  toutes les autres lignes disparaissent tant qu'un bus est sélectionné. Son
  popup affiche alors **ses horaires en temps réel** (prochains arrêts de son
  voyage en cours, avec l'heure théorique et, quand elle est connue, l'heure
  corrigée par le temps réel)
- 📋 un **questionnaire voyageur** accessible depuis le popup d'un bus (bus
  plein ?, chauffage/climatisation fonctionnels ?, conducteur sympathique ?,
  conduite agréable ?) ; une fois des avis envoyés, une **moyenne des
  réponses** (en %) s'affiche dans le popup de ce bus
- 📍 la **géolocalisation** de l'utilisateur (bouton dédié dans l'en-tête),
  avec un marqueur bleu pulsant sur la carte
- 🔀 un interrupteur pour n'afficher que les lignes actuellement en circulation
- 🕑 les prochains passages à un arrêt (au clic), avec l'heure théorique et,
  quand elle est connue, l'heure corrigée par le temps réel
- 🔎 une recherche d'arrêt par nom
- des interrupteurs pour afficher/masquer chaque calque (utile sur mobile)
- un habillage visuel repensé (couleurs de la marque Citibus, cartes flottantes
  arrondies, ombres douces) et le **vrai logo Citibus** dans l'en-tête (avec
  repli automatique sur une icône si l'image ne peut pas se charger)

### À propos du questionnaire voyageur

Les réponses sont stockées **en mémoire côté serveur**, associées à
l'identifiant physique du véhicule (`vehicleId`) — elles sont donc partagées
entre tous les visiteurs du site, mais sont **perdues au redémarrage du
serveur** (pas de base de données dans ce prototype). Pour les conserver
durablement, il faudrait brancher une vraie base (SQLite, Postgres…) sur les
deux routes `/api/vehicles/:id/feedback` (GET/POST) dans `server.js`.

### À propos de la géolocalisation

Elle utilise l'API `navigator.geolocation` du navigateur : elle ne fonctionne
que si le site est servi en HTTPS (ou en local sur `localhost`), et demande
l'autorisation explicite de l'utilisateur à chaque navigateur.

### À propos de l'icône des bus

Un vrai modèle 3D (comme dans un jeu vidéo, qu'on peut faire tourner à
360°) demanderait de changer complètement de moteur de carte (Mapbox GL,
three.js...) et de trouver/héberger un fichier modèle 3D fiable et libre de
droits, ce qui est complexe et fragile pour un site gratuit. À la place,
chaque bus est représenté par une icône dessinée (dégradé de couleur,
vitrage, ombre portée) qui s'oriente selon sa direction réelle — un bon
compromis visuel sans dépendance externe.

## Pourquoi un serveur est nécessaire

Le flux GTFS-RT est un fichier binaire (Protobuf) sans CORS, et les horaires
théoriques viennent d'un fichier GTFS (zip de fichiers CSV) volumineux à
traiter. Le serveur Node.js s'occupe de tout ça et fournit des données déjà
prêtes à afficher à la page web.

## Lancer le projet en local

```bash
npm install
npm start
```

Puis ouvre **http://localhost:3000**. Au premier démarrage, le serveur
télécharge et analyse le fichier GTFS (arrêts, lignes, horaires) : ça peut
prendre quelques secondes, regarde la fenêtre du terminal pour voir le
message "GTFS statique chargé".

## Limites connues de ce prototype

- **Horaires autour de minuit** : certains horaires théoriques GTFS sont
  exprimés au-delà de 24:00:00 (ex. 25:10:00 pour 01:10 le lendemain). Ce
  prototype ne gère pas encore ce cas particulier ; les passages juste après
  minuit peuvent donc être incomplets.
- **Précision du temps réel sur les horaires** : le retard affiché à un
  arrêt n'est disponible que si le bus a déjà transmis une mise à jour pour
  ce voyage ; sinon, l'heure théorique est affichée telle quelle.
- **Chargement initial** : le fichier GTFS statique est retéléchargé
  automatiquement toutes les 12h pour rester à jour avec les changements
  d'horaires du réseau.
- **Segment "déjà parcouru"** : il est calculé en cherchant le point du tracé
  le plus proche de la position actuelle du bus (pas un vrai calcul GPS de
  trajet), ce qui est très fiable en pratique mais peut ponctuellement se
  décaler d'un point si deux endroits du tracé sont proches l'un de l'autre
  (ex. un rond-point).
- **Fréquence de mise à jour** : le serveur interroge le flux toutes les 5
  secondes, mais le réseau Citibus lui-même ne transmet ses propres positions
  GPS que toutes les 15 à 30 secondes en général. Interroger plus vite ne
  fait donc qu'éviter d'ajouter du délai supplémentaire, sans dépasser la
  fraîcheur réelle des données du réseau.

## Mouvement fluide entre deux positions GPS (et pourquoi pas Waze)

Le réseau Citibus ne transmet ses positions réelles que toutes les 15 à 30
secondes environ. Pour éviter que les bus n'apparaissent "par sauts" sur la
carte, ce prototype fait avancer chaque bus, entre deux positions réelles, le
long du tracé de sa ligne, à sa dernière vitesse connue transmise par le
flux GTFS-RT. Dès qu'une nouvelle position réelle arrive, le bus se recale
immédiatement dessus (l'estimation ne remplace jamais la vraie donnée).

Concrètement, cette vitesse rapportée par le bus reflète déjà indirectement
les conditions de circulation réelles (un bus ralenti par du trafic aura une
vitesse transmise plus basse, donc une avance plus lente sur la carte).

**Je n'ai en revanche pas intégré Waze ni les panneaux de signalisation** :
aucune API Waze publique et gratuite ne permet d'obtenir le trafic en temps
réel pour un point précis d'une route, et il n'existe pas de source ouverte
équivalente pour les panneaux. L'approche ci-dessus donne un résultat visuel
proche sans dépendre d'un service tiers payant ou non disponible.



Ce projet peut être déployé gratuitement sur des plateformes comme
**Render.com**, **Railway.app** ou **Fly.io** :
1. Mets ce dossier dans un dépôt GitHub.
2. Sur Render, crée un "New Web Service" et connecte le dépôt.
3. Build command : `npm install` — Start command : `npm start`.
4. Tu obtiens une URL publique (ex. `https://ton-app.onrender.com`) à
   partager gratuitement avec n'importe qui.

⚠️ Sur les plans gratuits, le serveur peut se "mettre en veille" après une
période d'inactivité et redémarrer en quelques secondes au premier accès —
c'est normal.

## Idées pour aller plus loin
- Alertes trafic (le flux `service_alerts` de Citibus est aussi disponible)
- Filtrer la carte par ligne
- Mode sombre automatique
- Favoris (arrêts épinglés) sauvegardés dans le navigateur
