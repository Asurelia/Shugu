# Rapport logging et telemetrie

## T01 - `tracer.log` fire-and-forget: perte d'evenements et rejets non geres possibles

Statut: verifie par lecture.
Severite: haute selon les consignes AGENTS, telemetrie.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\utils\tracer.ts`
  - `F:\Dev\Project\Project_cc\src\engine\loop.ts`
  - `F:\Dev\Project\Project_cc\src\entrypoints\repl.ts`
- Fonctions: `writeEvent`, `redactEventData`, appels `tracer.log`
- Lignes: tracer 65-94 et 128-153; appels loop 131, 191, 219, 375, 407, 520, 606; appels repl 329, 415, 454, 642.

Preuve:

- Beaucoup d'appels `tracer.log(...)` ne sont pas await.
- Dans `writeEvent`, `redactEventData(event)` est appele avant le `try`.
- `redactEventData` fait `JSON.stringify(v)` puis `JSON.parse(...)` sur les objets.

Impact:

- `session_end`, `model_call`, `tool_result`, `error` peuvent etre perdus lors d'un `process.exit` ou d'un shutdown rapide.
- Si `JSON.stringify` echoue (objet circulaire, BigInt), la promesse `tracer.log` rejette avant le `try`; comme plusieurs appels ne sont pas await, cela peut devenir un rejet non gere.

Correctif suggere:

Mettre la redaction dans le bloc `try`, rendre la redaction failure-safe, pousser l'evenement brut/redige en memoire avant l'I/O fichier, et `await` les evenements critiques (`session_start`, `session_end`, erreurs). Ajouter tests avec objet circulaire et BigInt.

## T02 - `logger.ensureDir` desactive le logger apres un echec mkdir

Statut: verifie par lecture.
Severite: haute selon AGENTS, logging silencieux.

- Fichier: `F:\Dev\Project\Project_cc\src\utils\logger.ts`
- Fonctions: `ensureDir`, `write`
- Lignes: 22-30, 52-59.

Preuve:

`ensureDir` catch toute erreur de `mkdir`, commente "Directory might already exist", puis met `dirEnsured = true`. `write` catch ensuite tous les ecrits et les jette silencieusement.

Impact:

Si `~/.pcc` ne peut pas etre cree (permission, disque, chemin casse), le logger considere le repertoire comme pret et n'essaie plus. Les logs sont silencieusement perdus.

Correctif suggere:

Ne marquer `dirEnsured=true` que sur succes ou erreur `EEXIST`. Garder `dirEnsured=false` sur autres erreurs. Exposer un statut logger dans `/doctor` ou stderr en mode verbose.

## T03 - Rotation du tracer annoncee mais non implementee

Statut: verifie par lecture.
Severite: moyenne.

- Fichier: `F:\Dev\Project\Project_cc\src\utils\tracer.ts`
- Fonction: `writeEvent`
- Lignes: constante `MAX_FILE_SIZE` 49, commentaire 85, imports 13.

Preuve:

`MAX_FILE_SIZE` est defini a 50 MB, `stat` et `readdir` sont importes, mais aucune verification de taille n'est faite. Le commentaire dit: "Rotation: if file > 50MB, it's fine - new day = new file".

Impact:

Un fichier de trace journalier peut croitre bien au-dela de 50 MB. Le code et le commentaire donnent une impression de rotation qui n'existe pas.

Correctif suggere:

Implementer la rotation par suffixe (`YYYY-MM-DD.1.jsonl`) ou supprimer constante/commentaire et documenter clairement la rotation quotidienne uniquement.

## T04 - `Retry-After` HTTP reel ignore

Statut: verifie par lecture.
Severite: moyenne/haute, transport/telemetrie provider.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\transport\client.ts`
  - `F:\Dev\Project\Project_cc\src\transport\errors.ts`
- Fonctions: `MiniMaxClient.makeRequest`, `classifyHttpError`, `parseRetryAfter`
- Lignes: client 232-234, errors 59-66 et 88-99.

Preuve:

`makeRequest` lit uniquement `response.text()` puis appelle `classifyHttpError(response.status, errorBody)`. `parseRetryAfter` cherche `headers['retry-after']` dans un JSON body, pas dans `response.headers`.

Impact:

Une vraie reponse 429 avec header HTTP `Retry-After` sera ramenee au fallback 10 s, ce qui peut mal respecter la cadence provider.

Correctif suggere:

Passer `response.headers.get('retry-after')` a `classifyHttpError` ou enrichir l'erreur avec headers. Parser secondes et HTTP-date. Ajouter tests avec un vrai objet `Response` et headers.

## T05 - Fallbacks reseau/search/model non traces

Statut: verifie par lecture.
Severite: moyenne.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\tools\web\WebSearchTool.ts`
  - `F:\Dev\Project\Project_cc\src\transport\client.ts`
- Fonctions: `searchMiniMax`, `searchDuckDuckGo`, `attemptFallback`
- Lignes: WebSearch 106-132 et 137-150; client 138-158.

Preuve:

- `searchMiniMax` fallback vers DuckDuckGo si pas de cle, HTTP non OK, ou exception.
- `searchDuckDuckGo` catch et retourne `[]`.
- `attemptFallback` change de modele avec `this.setModel(nextModel)` sans warning UI ni trace.

Impact:

Un probleme MiniMax Search, une erreur DuckDuckGo ou une degradation de modele peut apparaitre comme "No results found" ou comme un simple changement de qualite, sans diagnostic clair.

Correctif suggere:

Ajouter des evenements `tracer.log('error'/'model_fallback'/...)`, retourner une indication de mode degrade dans le resultat tool, et afficher un warning utilisateur quand le modele est downgrade.

## T06 - Compaction et context loading avalent certaines erreurs avec peu de contexte

Statut: verifie par lecture.
Severite: moyenne.

- Fichiers:
  - `F:\Dev\Project\Project_cc\src\entrypoints\repl.ts`
  - `F:\Dev\Project\Project_cc\src\entrypoints\prompt-builder.ts`
- Fonctions: `runREPL`, `buildSystemPrompt`
- Lignes: repl 500-507, prompt-builder 147-155.

Preuve:

La compaction auto catch puis incremente un circuit breaker, sans conserver la cause. Le prompt-builder downgrade plusieurs erreurs de contexte en `logger.debug` et `null`.

Impact:

Dans une panne de contexte, l'utilisateur voit parfois un symptome general ("custom instructions missing" ou circuit breaker) sans cause exploitable.

Correctif suggere:

Tracer les causes avec type d'erreur et chemin concerne, tout en gardant le fallback non bloquant si le contexte est optionnel.
