# Qui veut gagner des millions ? — version multijoueur

Salon en ligne : un hôte crée une salle, partage le lien, tout le monde répond aux mêmes questions en même temps (30 s).

## Déploiement sur Render
1. Déposez ces fichiers sur un dépôt GitHub (sans node_modules) : server.js, package.json, questions.json, render.yaml, public/.
2. render.com > New > Web Service > connectez le dépôt.
   Build : `npm install` — Start : `node server.js` (déjà dans render.yaml, vous pouvez aussi choisir New > Blueprint).
3. Optionnel : variable d'environnement ADMIN_KEY pour protéger l'ajout de questions.
4. Lien public : https://votre-nom.onrender.com

Test en local : `npm install && npm start` puis http://localhost:3000
Les questions ajoutées sont écrites dans data/extra.json (effacées à chaque redéploiement sur l'offre gratuite).
