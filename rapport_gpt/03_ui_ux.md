# Rapport UI / UX terminal

## U01 - Le prompt `a(lways)` n'applique pas le `always`

Statut: verifie par lecture et recherche globale.
Severite: moyenne/haute, UX + permissions.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\ui\renderer.ts`
  - `F:\Dev\Project\Project_cc\src\entrypoints\bootstrap.ts`
  - `F:\Dev\Project\Project_cc\src\policy\permissions.ts`
- Fonctions: `TerminalRenderer.permissionPrompt`, `createPermissionPrompter`, `PermissionResolver.allowForSession`
- Lignes: renderer 264-276, bootstrap 163-182, permissions 122-124 et 137-174.

Preuve:

`permissionPrompt` accepte `a`/`always` mais retourne seulement `boolean`. `createPermissionPrompter` retourne ce boolean au tool. Recherche globale: `allowForSession` n'est pas appele dans le flux REPL.

Impact:

L'UI promet une approbation persistante pour la session, mais le comportement est identique a "oui". Cela degrade la confiance dans les prompts de permissions.

Correctif suggere:

Faire retourner un enum (`deny`, `allow_once`, `allow_session`) et appeler `permResolver.allowForSession(call)` si l'utilisateur choisit `always`. Corriger aussi `getSessionKey` pour les outils fichiers afin de ne pas autoriser trop large.

## U02 - Ctrl+C a deux comportements concurrents

Statut: verifie par lecture.
Severite: haute, UX controle.

- Fichier: `F:\Dev\Project\Project_cc\src\entrypoints\repl.ts`
- Fonction: `runREPL`
- Lignes: 254-266 et 511-520.

Impact:

Pendant un tour, Ctrl+C peut a la fois abort le tour et lancer le shutdown global. L'utilisateur s'attend generalement a interrompre la generation, pas a quitter l'application.

Correctif suggere:

Unifier la gestion SIGINT: actif -> abort tour; inactif -> shutdown. Ajouter un second Ctrl+C optionnel pour forcer la sortie.

## U03 - Plusieurs gros collages avant Enter corrompent le prompt final

Statut: verifie par lecture.
Severite: moyenne/haute, UX + integrite entree utilisateur.

- Fichier: `F:\Dev\Project\Project_cc\src\ui\FullApp.tsx`
- Fonction: `FullApp`
- Lignes: 467-497.

Preuve:

`pastedContentRef` stocke un seul contenu. Si l'utilisateur colle deux gros blocs avant de soumettre:

1. Le premier marker reste dans `inputValue`.
2. Le ref est remplace par le second collage.
3. `handleSubmit` remplace seulement le premier marker par le dernier contenu.
4. Le second marker peut rester litteralement dans le prompt.

Impact:

Le modele peut recevoir un prompt different de ce que l'utilisateur pense avoir envoye.

Correctif suggere:

Stocker un `Map<number, string>` des collages et remplacer tous les markers par leur contenu correspondant. Ajouter un test composant ou test pur sur la fonction de substitution.

## U04 - `createPasteHandler.disable()` ne restaure pas `process.stdin.emit`

Statut: verifie par lecture.
Severite: moyenne, stabilite UI/tests.

- Fichier: `F:\Dev\Project\Project_cc\src\ui\paste.ts`
- Fonction: `createPasteHandler`
- Lignes: 45-107.

Preuve:

`enable` remplace `process.stdin.emit` par un wrapper qui capture le `origEmit`, mais `disable` ne restaure jamais `process.stdin.emit`. Il retire seulement un `stdinListener` placeholder qui n'a jamais ete ajoute.

Impact:

Apres un unmount/relaunch dans le meme processus, le stdin reste wrappe. Les tests ou sessions multiples peuvent empiler les wrappers et avaler des donnees de maniere inattendue.

Correctif suggere:

Stocker `origEmit` hors du scope de `enable`, rendre `enable/disable` idempotents, restaurer `process.stdin.emit = origEmit` sur disable et retirer le handler `exit`.

## U05 - Version affichee incoherente

Statut: verifie par lecture.
Severite: basse/moyenne, support/diagnostic.

- Fichiers:
  - `F:\Dev\Project\Project_cc\package.json`
  - `F:\Dev\Project\Project_cc\src\entrypoints\bootstrap.ts`
  - `F:\Dev\Project\Project_cc\src\ui\renderer.ts`
- Fonctions: `bootstrap`, `TerminalRenderer.banner`
- Lignes: package version `0.2.0`; bootstrap 407-409; renderer 66-70.

Preuve:

Le banner riche utilise `0.2.0`, mais le fallback `TerminalRenderer.banner` affiche `Shugu v1.0.0`.

Impact:

Les captures et diagnostics peuvent reporter une version incorrecte.

Correctif suggere:

Centraliser la version dans un module (`brand.ts`) ou lire le package au build.

## U06 - Affichage tronque des tools peut cacher le detail utile

Statut: suspicion raisonnable par lecture, non teste en TTY.
Severite: moyenne.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\ui\renderer.ts`
  - `F:\Dev\Project\Project_cc\src\ui\FullApp.tsx`
- Fonctions: `TerminalRenderer.toolResult`, `StaticMessage`
- Lignes: renderer 193-210; FullApp 157-299.

Preuve:

Le rendu ANSI tronque les resultats a 1000 caracteres, le rendu Ink affiche souvent 20-30 lignes puis `... more`. C'est utile pour lisibilite, mais il n'y a pas toujours une voie visible de "show full" sauf transcript partiel.

Impact:

Pour debugging tests/API/logs, l'utilisateur peut croire voir l'erreur complete alors qu'une partie importante est masquee.

Correctif suggere:

Afficher systematiquement le nombre total de caracteres/lignes et proposer une commande de transcript ou expansion pour le dernier tool result.
