# Constats critiques et robustesse generale

Chaque constat distingue l'etat verifie ou suspecte, indique le chemin, la fonction, l'impact et un correctif suggere.

## C01 - Regle integree `.env*` inoperante sur plusieurs chemins

Statut: verifie par lecture et script de resolution.
Severite: haute, securite/config.

- Fichier: `F:\Dev\Project\Project_cc\src\policy\rules.ts`
- Fonction: `matchPattern`, utilisee par `ruleMatches` et `BUILTIN_RULES`
- Lignes: `BUILTIN_RULES` autour de 137-149, `matchPattern` autour de 156-165.

Preuve:

- `BUILTIN_RULES` utilise `filePattern: '**/.env*'`.
- Le glob maison est transforme par replacements successifs `** -> .*` puis `* -> [^/]*`, ce qui casse la semantique attendue.
- Test ad hoc execute:
  - `.env` -> `allow`, source `mode`
  - `.env.local` -> `allow`, source `mode`
  - `sub/.env` -> `deny`, source `builtin`
  - `sub/deep/.env.local` -> `allow`, source `mode`
  - `sub\deep\.env` -> `allow`, source `mode`

Impact:

En `fullAuto`, les outils `Write`/`Edit` peuvent etre autorises sur `.env` a la racine ou sur des chemins profonds, alors que la regle est documentee comme "Always deny writing/editing sensitive paths". Le depot audite contient bien un fichier `.env`.

Correctif suggere:

Remplacer le glob maison par une librairie robuste (`minimatch`/`picomatch`) ou normaliser le chemin et bloquer explicitement tout basename qui matche `/^\.env/`. Ajouter des tests pour `.env`, `.env.local`, `sub/.env`, `sub/deep/.env.local` et les separateurs Windows.

## C02 - La policy plugin n'est pas appliquee aux permissions de registration

Statut: verifie par lecture.
Severite: haute, sandbox/plugins/securite.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\plugins\policy.ts`
  - `F:\Dev\Project\Project_cc\src\plugins\loader.ts`
  - `F:\Dev\Project\Project_cc\src\plugins\host.ts`
- Fonctions: `resolvePluginConfig`, `loadPlugin`, `loadBrokeredPlugin`, `PluginHost.hasPermission`
- Lignes: `resolvePluginConfig` 98-148, `loadBrokeredPlugin` 263-293, `hasPermission` 550-555.

Preuve:

- `resolvePluginConfig` produit `permissions` et `maxAgentTurns`.
- `loadBrokeredPlugin` transmet seulement `resolved.capabilities` et `resolved.timeoutMs` au `PluginHost`.
- `PluginHost.hasPermission` lit `this.options.manifest.permissions`, pas les permissions resolues.

Impact:

Une policy `.pcc/plugin-policy.json` qui tente de limiter les registrations `tools`, `hooks`, `commands` ou `skills` n'est pas appliquee dans le host brokered. Cela donne une impression de controle qui ne correspond pas au comportement reel.

Correctif suggere:

Ajouter `permissions` et `maxAgentTurns` a `PluginHostOptions`, les passer depuis `loadBrokeredPlugin`, et faire `hasPermission` sur la configuration resolue. Decider explicitement la difference entre `undefined` et `[]`, puis aligner tests et commentaires.

## C03 - Sandbox plugin Windows trop permissive en lecture fichier

Statut: verifie par lecture, exploitation non executee.
Severite: haute, sandbox/securite.

- Fichier: `F:\Dev\Project\Project_cc\src\plugins\host.ts`
- Fonction: `buildPermissionFlags`
- Lignes: 138-160, surtout 144-150.

Preuve:

Sur Windows, `buildPermissionFlags` force:

```text
--allow-fs-read=*
```

Le commentaire indique que le matching UNC de Node casse les chemins specifiques, mais le resultat accorde la lecture filesystem globale au processus plugin hors Docker.

Impact:

Dans l'environnement audite (`F:\...`, Windows), un plugin brokered hors Docker peut avoir un droit de lecture OS beaucoup plus large que les capabilities annoncees par le broker. Cela affaiblit le modele "capability broker" et peut exposer secrets locaux et fichiers hors workspace si le plugin lit directement via `fs`.

Correctif suggere:

Ne pas presenter ce mode comme sandbox fort sur Windows. Preferer Docker obligatoire pour plugins non fiables, refuser le mode brokered natif si les flags restrictifs ne peuvent pas etre appliques, ou isoler dans un repertoire de travail minimal sans secrets. Ajouter un test qui verifie qu'un plugin ne peut pas lire un fichier hors workspace en mode natif Windows.

## C04 - `capabilitiesDeny` est documente "always wins" mais peut etre annule par `capabilitiesAdd`

Statut: verifie par lecture et par test existant.
Severite: haute si utilise pour retirer `http.fetch` ou `fs.write`.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\plugins\policy.ts`
  - `F:\Dev\Project\Project_cc\tests\plugin-policy.test.ts`
- Fonction: `resolvePluginConfig`
- Lignes: policy 95-97 et 131-144; test 151-172.

Preuve:

- Le commentaire de policy dit: "`capabilitiesDeny` always removes from the final list".
- Le code applique `capabilitiesDeny`, puis reapplique `capabilitiesAdd`, donc une capability presente dans les deux listes revient.
- Le test existant a ete ecrit pour accepter ce comportement malgre la contradiction.

Impact:

Un administrateur peut penser avoir interdit une capability, alors qu'une autre section de policy la rajoute ensuite.

Correctif suggere:

Appliquer `capabilitiesAdd` avant `capabilitiesDeny`, ou faire un filtrage final avec le set deny. Modifier le test pour verifier la specification de securite, pas le bug actuel.

## C05 - Classifieur LLM de strategie sous-dimensionne pour MiniMax reasoning

Statut: verifie par smoke test API reel.
Severite: haute, comportement agentique/fonctions.

- Fichier: `F:\Dev\Project\Project_cc\src\engine\strategy.ts`
- Fonction: `classifyByLLM`
- Lignes: 105-133, surtout 110-128.

Preuve:

- Le classifieur appelle `client.complete(..., { maxTokens: 50, model: MINIMAX_MODELS.fast, temperature: 0.1 })`.
- Le client active `reasoning_split` par defaut via `thinkingConfig.showThinking`.
- Smoke API reel avec `MiniMax-M2.5-highspeed`, `maxTokens: 50`: `stopReason=max_tokens`, `contentTypes=["thinking"]`, texte visible vide.
- Smoke API reel avec `maxTokens: 256`: `stopReason=end_turn`, texte visible `OK`.

Impact:

Pour les taches ambigues, le classifieur peut ne produire aucun texte visible, puis le code transforme `firstWord=''` en complexite `simple` sans trace d'erreur. Cela reduit la planification, les hints d'agents et la prudence sur les taches complexes.

Correctif suggere:

Augmenter le budget du classifieur (par exemple 256), detecter `stopReason === 'max_tokens'` ou texte vide et retry avec un budget plus grand, puis tracer/logguer l'echec. Ajouter un test d'integration mocke ou reel qui simule une reponse `thinking` only.

## C06 - `GrepTool` ne fallback pas si `spawn('rg')` leve `EPERM`

Statut: verifie par `npm test`.
Severite: haute, process execution/search.

- Fichier: `F:\Dev\Project\Project_cc\src\tools\search\GrepTool.ts`
- Fonction: `tryRipgrep`
- Lignes: 183-222, surtout 207.

Preuve:

`npm test` echoue:

```text
FAIL tests/search-boundary.test.ts > GrepTool workspace boundary > allows search without path
Error: spawn EPERM
src/tools/search/GrepTool.ts:207:19
```

Le handler `child.on('error', ...)` ne capture pas une exception levee synchroniquement par `spawn`.

Impact:

Si `rg` existe mais n'est pas executable, le tool plante au lieu de passer au fallback natif. C'est le cas dans l'environnement d'audit.

Correctif suggere:

Entourer `spawn('rg', ...)` par `try/catch` dans `tryRipgrep` et retourner `null` en cas d'erreur de spawn. Ajouter un test qui mocke `spawn` pour lever `EPERM`.

## C07 - `Write` n'applique pas le contrat read-before-write

Statut: verifie par lecture.
Severite: haute, safety fichier.

- Fichier: `F:\Dev\Project\Project_cc\src\tools\files\FileWriteTool.ts`
- Fonction: `FileWriteTool.execute`
- Lignes: description 16-19, execution 54-80.

Preuve:

La description dit: "This tool will fail if you did not read the file first." Mais `execute` cree les repertoires et appelle directement `writeFile` sans verifier si le fichier existe ni `context.readTracker`.

Impact:

Un fichier existant peut etre ecrase sans lecture prealable, alors que `Edit` implemente cette barriere. Cela augmente le risque de perte de modifications utilisateur.

Correctif suggere:

Avant ecriture, tester l'existence du fichier. Si le fichier existe et `context.readTracker?.hasRead(absPath)` est faux hors bypass, retourner une erreur. Ajouter un test equivalent a `file-edit-preread` pour `Write`.

## C08 - Ctrl+C pendant un tour quitte la REPL au lieu d'aborter seulement le tour

Statut: verifie par lecture.
Severite: haute, UX/controle session.

- Fichier: `F:\Dev\Project\Project_cc\src\entrypoints\repl.ts`
- Fonction: `runREPL`
- Lignes: shutdown global 254-266, handler de tour 511-520.

Preuve:

La REPL enregistre `process.on('SIGINT', () => gracefulShutdown('SIGINT'))` au niveau global, puis ajoute un autre handler SIGINT pendant le tour pour `interrupt.abort('User interrupted')`. Node appelle les listeners, donc le handler global peut unmount, sauvegarder, disposer et `process.exit(0)`.

Impact:

L'utilisateur perd la capacite attendue d'interrompre seulement une generation ou un outil. Le comportement est plus proche de "quitter l'application".

Correctif suggere:

Remplacer les handlers concurrents par une seule machine d'etat SIGINT: si un tour est actif, abort le `InterruptController`; sinon, shutdown. Ajouter un garde contre double shutdown.

## C09 - Timeout streaming limite aux headers, pas au corps SSE

Statut: verifie par lecture, serveur bloque non simule.
Severite: haute, transport/robustesse.

- Fichier: `F:\Dev\Project\Project_cc\src\transport\client.ts`
- Fonctions: `MiniMaxClient.makeRequest`, `MiniMaxClient.stream`
- Lignes: `makeRequest` 206-240, `stream` 127-131.

Preuve:

`makeRequest` cree un timeout, fait `fetch`, retourne `Response`, puis `finally` clear le timeout. La lecture du `response.body` par `parseSSEStream` se fait apres, sans timeout idle/total.

Impact:

Si le serveur envoie les headers puis bloque le flux SSE, la session peut rester bloquee indefiniment sauf abort externe.

Correctif suggere:

Propager un timeout de stream dans `parseSSEStream`, ajouter un idle timeout sur `reader.read()`, et lever `StreamTimeoutError`. Ajouter un test avec `ReadableStream` qui ne termine pas.

## C10 - Abort SSE transforme en complete partiel

Statut: verifie par lecture.
Severite: moyenne/haute, transport/etat de conversation.

- Fichier: `F:\Dev\Project\Project_cc\src\transport\stream.ts`
- Fonctions: `parseSSEStream`, `streamWithDeltas`
- Lignes: `parseSSEStream` 28-75, `streamWithDeltas` 358-363.

Preuve:

`parseSSEStream` fait `break` si `abortSignal.aborted`, sans lever d'erreur. `streamWithDeltas` construit ensuite toujours une reponse `complete`.

Impact:

Un abort observe entre deux reads peut etre vu comme une reponse assistant partielle complete, avec `stopReason` nul ou incomplet.

Correctif suggere:

Lever une `AbortError` lorsque le signal est aborte et ne pas emettre `complete` dans ce chemin. Ajouter tests abort-before-read et abort-between-chunks.
