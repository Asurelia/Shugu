# Rapport skills, plugins, fonctions et outils

## S01 - Triggers `keyword` et `pattern` de skills presque jamais executes

Statut: verifie par lecture.
Severite: moyenne/haute, skills/fonctionnalite.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\entrypoints\repl.ts`
  - `F:\Dev\Project\Project_cc\src\skills\loader.ts`
  - `F:\Dev\Project\Project_cc\src\skills\bundled\dream.ts`
  - `F:\Dev\Project\Project_cc\src\skills\bundled\hunter.ts`
  - `F:\Dev\Project\Project_cc\src\skills\bundled\secondbrain.ts`
- Fonctions: `runREPL`, `SkillRegistry.match`
- Lignes: repl 353-383; loader 136-178; triggers bundled trouves dans `dream.ts` 20-23, `hunter.ts` 19-23, `secondbrain.ts` 25-30.

Preuve:

`SkillRegistry.match` supporte `command`, `keyword` et `pattern`. Mais la REPL l'appelle seulement si `input.startsWith('/')`. Les keyword triggers comme `find bugs`, `security audit`, `obsidian vault` ne se declenchent donc pas sur un prompt naturel.

Impact:

Les skills sont declares plus riches qu'ils ne le sont en pratique. L'utilisateur peut demander `security audit` et passer par la boucle generale au lieu du skill `hunt`.

Correctif suggere:

Appeler `skillRegistry.match(input)` pour tous les inputs, puis gerer la priorite avec les slash commands. Si cela cree trop d'activations, ajouter un seuil ou un mode "suggest skill" au lieu d'execution automatique.

## S02 - Plugin registration permissions: voir C02

Statut: verifie.
Severite: haute.

Le detail est dans `01_constats_critiques.md` C02. En resume, la configuration resolue `permissions` n'arrive pas au `PluginHost`, donc les registrations `tools`, `hooks`, `commands`, `skills` ne respectent pas la policy effective.

Correctif suggere:

Faire de la configuration resolue la seule source d'autorite dans le host et ajouter tests E2E brokered.

## S03 - Plugin sandbox Windows: voir C03

Statut: verifie par lecture, exploitation non executee.
Severite: haute.

Le detail est dans `01_constats_critiques.md` C03. `--allow-fs-read=*` en mode Windows affaiblit l'isolation hors Docker.

## S04 - `permissions: []` a deux interpretations contradictoires

Statut: verifie par lecture.
Severite: moyenne/haute.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\plugins\loader.ts`
  - `F:\Dev\Project\Project_cc\src\plugins\host.ts`
  - `F:\Dev\Project\Project_cc\src\plugins\policy.ts`
- Fonctions: `loadPlugin`, `PluginHost.hasPermission`, `resolvePluginConfig`
- Lignes: loader 209-214, host 550-555, policy 50-56.

Preuve:

- `loadPlugin`: si `manifest.permissions` existe et vaut `[]`, le plugin devient actif sans execution de code.
- `PluginHost.hasPermission`: si `!perms || perms.length === 0`, alors `true`, donc "allow all".
- `DEFAULTS.permissions` vaut `[]`.

Impact:

La signification de `[]` depend du point du code: "aucun droit et pas d'execution" dans loader, "tous droits" dans host.

Correctif suggere:

Choisir une semantique unique:

- `undefined`: compat ancienne, peut autoriser par defaut si necessaire.
- `[]`: aucun droit.
- `['tools']`: droits explicites.

Puis modifier loader/host/tests.

## S05 - `GrepTool` fallback natif incomplet et bug de regex globale

Statut: verifie par lecture; bug `EPERM` verifie par tests.
Severite: moyenne/haute.

- Fichier: `F:\Dev\Project\Project_cc\src\tools\search\GrepTool.ts`
- Fonctions: `tryRipgrep`, `nativeGrep`, `simpleGlobMatch`
- Lignes: appel fallback 139-145, `tryRipgrep` 183-222, `nativeGrep` 227-279.

Preuves:

- Le fallback natif ne recoit pas `contextLines`, `afterLines`, `beforeLines`, `multiline`.
- Le glob fallback est applique a `entry.name`, pas au chemin relatif; `src/**/*.ts` ne se comporte pas comme `rg`.
- Le regex natif utilise le flag global `g` et fait `regex.test(lines[i])` ligne par ligne sans reset par ligne, ce qui peut rater des lignes consecutives.
- `spawn('rg')` peut lever `EPERM` avant le handler `child.on('error')`.

Impact:

Quand `rg` manque ou echoue, la recherche devient incomplete ou plante. Dans l'environnement audite, c'est un chemin reel, pas theorique.

Correctif suggere:

1. Wrapper `spawn` par `try/catch`.
2. Supprimer le flag `g` pour le mode line-by-line ou reset `lastIndex` avant chaque test.
3. Appliquer les globs sur chemin relatif.
4. Soit implementer contexte/multiline, soit retourner une notice "degraded fallback".

## S06 - `WebFetch` ignore l'abort utilisateur et clear le timeout avant lecture du body

Statut: verifie par lecture.
Severite: moyenne.

- Fichier: `F:\Dev\Project\Project_cc\src\tools\web\WebFetchTool.ts`
- Fonction: `WebFetchTool.execute`
- Lignes: 74-157, surtout 99-127.

Preuve:

`context.abortSignal` n'est pas combine au `AbortController` local. Le timeout est clear juste apres `ssrfSafeFetch`, avant `response.json()` ou `response.text()`.

Impact:

Un abort utilisateur ne coupe pas le fetch. Un serveur qui envoie les headers puis bloque le corps peut depasser 30 s.

Correctif suggere:

Combiner `context.abortSignal` et timeout local, clear le timeout dans un `finally` apres lecture du body, et tester un body lent.

## S07 - `WebSearch` masque les erreurs provider

Statut: verifie par lecture.
Severite: moyenne.

- Fichier: `F:\Dev\Project\Project_cc\src\tools\web\WebSearchTool.ts`
- Fonctions: `searchMiniMax`, `searchDuckDuckGo`
- Lignes: 106-132 et 137-150.

Impact:

Une erreur MiniMax Search ou DuckDuckGo peut etre convertie en fallback silencieux puis "No results found".

Correctif suggere:

Retourner une erreur si tous les providers echouent, ou inclure `source`, `degraded`, `fallbackReason` dans le resultat.

## S08 - `BashTool` tue le shell direct, pas forcement l'arbre de processus

Statut: suspicion forte par lecture, non verifie par integration.
Severite: moyenne, process execution.

- Fichier: `F:\Dev\Project\Project_cc\src\tools\bash\BashTool.ts`
- Fonction: `runBash`
- Lignes: 155-220, surtout 191-194.

Preuve:

L'abort handler appelle `child.kill('SIGTERM')`, puis `SIGKILL` sur le meme child. Aucun process group / tree kill n'est gere.

Impact:

Un script qui lance un serveur ou un petit-enfant peut laisser des processus orphelins apres timeout/abort, surtout sur Windows.

Correctif suggere:

Sur POSIX, utiliser process group/detached et tuer le groupe. Sur Windows, utiliser une strategie tree-kill ou documenter fortement la limite. Ajouter un test avec un enfant qui survit.

## S09 - Model fallback downgrade sans feedback

Statut: verifie par lecture.
Severite: moyenne.

- Fichier: `F:\Dev\Project\Project_cc\src\transport\client.ts`
- Fonction: `MiniMaxClient.attemptFallback`
- Lignes: 138-158.

Impact:

En cas de 404 modele ou 529 repetes, le client passe au modele suivant avec `this.setModel(nextModel)` sans warning utilisateur ni trace. Cela change qualite/cout/latence.

Correctif suggere:

Tracer `model_fallback`, exposer un warning dans la UI/status, et enregistrer l'ancien/nouveau modele.

## S10 - `FileWriteTool` n'applique pas sa propre description

Statut: verifie.
Severite: haute.

Le detail est dans `01_constats_critiques.md` C07.

## S11 - Markdown loaders: certains skips sont silencieux

Statut: verifie par lecture.
Severite: basse/moyenne.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\commands\markdown-loader.ts`
  - `F:\Dev\Project\Project_cc\src\agents\markdown-loader.ts`
- Fonctions: `loadMarkdownCommands`, `loadMarkdownAgents`, parsers.
- Lignes: command loader 53-57, 101-110; agent loader 68-74, 126-134.

Impact:

Les repertoires manquants sont optionnels, donc non critique. Mais un repertoire present mais non lisible est aussi saute comme s'il n'existait pas, ce qui peut cacher un probleme de configuration.

Correctif suggere:

Ne pas logger `ENOENT`, mais logger en warn les erreurs autres que `ENOENT`/`ENOTDIR`.
