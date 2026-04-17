# Synthese d'audit - Shugu / Project_cc

Date: 2026-04-12
Racine auditee: `F:\Dev\Project\Project_cc`
Objet: audit profond bug/robustesse/UI-UX/skills/plugins/fonctions/logging/telemetrie, avec tests locaux et smoke test API reel.

## Conclusion courte

Le depot est structure et dispose d'une bonne base de tests, mais plusieurs mecanismes de securite et d'observabilite ne tiennent pas leurs promesses dans les chemins reels:

- Les regles integrees censees bloquer l'ecriture des fichiers `.env*` ne bloquent ni `.env` a la racine, ni `.env.local`, ni les chemins profonds, ni les chemins Windows avec `\`.
- L'isolation des plugins est incoherente: la policy calcule des permissions effectives, mais le host brokered verifie encore `manifest.permissions`; sur Windows, le fallback `--allow-fs-read=*` donne une lecture fichier trop large au processus plugin.
- Le classifieur LLM de strategie utilise `maxTokens: 50`; le smoke test API reel montre qu'avec MiniMax ce budget peut etre consomme entierement en `thinking`, sans texte visible. Le code retombe ensuite silencieusement sur `simple`.
- La suite Vitest echoue actuellement: 2 tests en echec sur `GrepTool` parce que `spawn('rg')` leve `EPERM` dans cet environnement et que le fallback natif n'est pas atteint.
- Plusieurs chemins de telemetrie/logging sont fire-and-forget ou silencieux, ce qui rend les diagnostics incomplets au moment precis ou ils sont necessaires.

## Rapports produits

- `rapport_gpt/01_constats_critiques.md`: constats principaux avec fichier, fonction, impact et correctif suggere.
- `rapport_gpt/02_logging_telemetrie.md`: audit logs/traces/observabilite.
- `rapport_gpt/03_ui_ux.md`: audit UI/UX terminal et incoherences utilisateur.
- `rapport_gpt/04_skills_plugins_fonctions.md`: audit skills, plugins, permissions, tools et appels de fonctions.
- `rapport_gpt/05_tests_validation.md`: commandes executees, resultats, smoke test API et zones non verifiees.

## Passes effectuees

1. Cartographie du projet: `package.json`, docs, structure `src`, tests, outils, entrypoints.
2. Flux agentique: REPL, boucle moteur, interruption, strategie, transport, outils.
3. Securite et permissions: rules, resolver, workspace boundaries, files, shell, web, plugins.
4. Logging/telemetrie: `logger`, `tracer`, appels fire-and-forget, rotation, redaction, perte d'evenements.
5. UI/UX: rendu terminal, prompts permission, gestion du collage, statut, banner, SIGINT.
6. Skills/plugins: matching des triggers, policy plugin, sandbox, registration, host/broker.
7. Validation executable: `npm run typecheck`, `npm test`, smoke tests API MiniMax avec `.env` charge sans afficher de secret.

## Validation rapide

- `npm run typecheck`: OK.
- `npm test`: KO, 2 tests en echec sur `tests/search-boundary.test.ts`.
- Smoke API MiniMax via `.env`: connectivite OK, cle chargee, requetes reelles executees.
- Smoke API `MiniMax-M2.5-highspeed`, `maxTokens: 50`: reponse `stopReason=max_tokens`, contenu uniquement `thinking`, texte visible vide.
- Smoke API `MiniMax-M2.5-highspeed`, `maxTokens: 256`: reponse `end_turn`, texte visible `OK`.

## Severites

Les severites suivent les consignes du fichier `AGENTS.md`: les echecs silencieux dans securite, sandbox, auth, config, process execution et telemetrie sont traites severement sauf preuve claire qu'ils sont non critiques.

- Critique / haute: regles `.env`, sandbox/policy plugin, classifieur LLM avec budget trop bas, `GrepTool` qui ne fallback pas sur `EPERM`, `Write` sans read-before-write, SIGINT qui quitte la REPL, timeout de stream incomplet, telemetrie potentiellement perdue.
- Moyenne: `Retry-After` ignore, fallback search/model silencieux, WebFetch abort/timeout incomplet, gestion de collage, "always" permission non applique, version UI incoherente, fallback Grep incomplet.
- Basse: incoherences documentaires et plusieurs commentaires/specs qui divergent du comportement.

## Angles morts

- Je n'ai pas exploite un plugin malveillant en conditions reelles. Les constats plugin reposent sur lecture de code et tests existants, pas sur une preuve d'exfiltration.
- Je n'ai pas simule un serveur SSE qui envoie les headers puis bloque le corps. Le risque de timeout post-headers vient de la structure `makeRequest` + `parseSSEStream`.
- Je n'ai pas fait de test interactif TTY manuel pour Ctrl+C et bracketed paste; les constats UI viennent du code.
- Je n'ai pas provoque de vraie reponse HTTP 429 avec header `Retry-After`; le constat vient du fait que `response.headers` n'est pas transmis a `classifyHttpError`.
- Je n'ai pas lu ni imprime le contenu de `.env`; le smoke API charge uniquement les variables localement dans le processus de test.
