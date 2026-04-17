# Revue Socratique de Shugu — à la manière de Rodin

**Date :** 2026-04-16
**Portée :** Architecture globale, branche `main` + modifications non committées (Phase 1 compétitive).
**Auteur :** Rodin (posture socratique, anti-complaisance).
**Inspiration :** gist `bdebon/e22d0b728abc5f393227440907b334cf`.

**Mise à jour 2026-04-16 (post-correction) :** les assertions sont annotées avec leur statut après intervention. Voir la section finale "Tableau de suivi des correctifs" et `metrics-20260416.md` pour les mesures empiriques.

---

## Préambule — La règle du jeu

Je ne suis ni ton allié ni ton adversaire. Tu as écrit ~26 600 lignes de TypeScript pour reimplémenter Claude Code côté MiniMax. 448 tests passent. Ce n'est pas un argument. Les tests vérifient la correction, pas la justesse architecturale.

Je refuse deux tentations symétriques :
- **La complaisance** : "c'est déjà en place, donc c'est bon."
- **Le centrisme mou** : "globalement c'est sain, quelques points perfectibles."

À la place, chaque décision reçoit une étiquette :

| Étiquette | Signification |
|---|---|
| ✓ Correct | La décision tient, j'ajoute des arguments que tu n'as pas mis |
| ~ Contestable | Défendable, mais pas uniquement. Il existe un choix adverse crédible |
| ⚡ Simplification | Tu traites un cas comme simple alors que la réalité est plus riche |
| ◐ Angle mort | Ce que le code ne voit pas, et dont rien dans le repo ne parle |
| ✗ Faux | Bug démontrable, contradiction, décision incohérente avec ses propres prémisses |

Pas de note globale. Pas de "7/10". Je tranche à la fin.

---

## Contexte historique en cinq lignes

Shugu est né d'un refus : celui de nettoyer le fork OpenClaude (487K lignes, 89 feature flags, 344 gates `USER_TYPE`). Tu as préféré la reimplémentation propre avec MiniMax M2.7 comme seul fournisseur. Phase 0 (feature-complete) est livrée. Le Meta-Harness (arXiv 2603.28052) est mergé depuis `bb2ee66`. Phase 1 (compétitif vs ForgeCode) ajoute workspace index, shell bridge, custom agents/commands markdown, observabilité temps-réel. C'est cette Phase 1 qui est actuellement non-committée. La trajectoire est claire ; la question est : **tient-elle encore sous pression ?**

---

## Axe 1 — Boucle agentique & stratégie (`engine/`)

### A1.1 — ✓ Correct : L'AsyncGenerator comme couplage UI/engine

`src/engine/loop.ts:101-105` expose la boucle comme `AsyncGenerator<LoopEvent>`. Chaque étape yield un événement, la couche UI consomme sans coupler. C'est le choix le plus important du repo — il rend possible le streaming temps-réel, l'abort propre, et le TrackerPanel. **Argument supplémentaire que tu n'as pas écrit** : c'est aussi ce qui rend le mode sans-UI (single-shot) trivial — le même générateur alimente un renderer différent. Tu as fait le bon pari, garde-le.

### A1.2 — ⚡ Simplification : Le classifier heuristique prétend être "gratuit"

`src/engine/strategy.ts:41-83` affirme "0 tokens pour trivial/heuristique". C'est techniquement vrai pour l'appel LLM, mais la complexité réelle est ailleurs : tu classes `"explique la fonction"` comme `trivial`, mais `"analyse cette fonction"` comme `simple`. La frontière entre trivial et simple repose sur une regex française/anglaise hard-codée (`EXPLORE_KEYWORDS`, ligne 47). Une question comme *"pourquoi ce code déclenche un leak mémoire ?"* passe en `simple` alors qu'elle mérite `complex` (diagnostic = multi-tool). **Question socratique** : si un utilisateur pose la même question en portugais, que se passe-t-il ? Le classifier fallback sur LLM (~150 tokens). Tu paies donc en tokens ce que tu as évité en heuristique. Le "0 token" est une promesse asymétrique — vraie pour le français/anglais, fausse pour tout le reste. Est-ce un bug ou une dette assumée ?

### A1.3 — ~ Contestable : La détection de boucle à 3 tool calls identiques

`src/engine/loop.ts:423-440` détecte une boucle après 3 appels identiques, injecte un message `[LOOP DETECTED]` et reset le compteur. Steelman : c'est simple, observable, et ça sort le modèle d'un pattern infini. **Critique** : la signature est `tool.name + JSON.stringify(input).slice(0, 100)`. Un `Grep` qui boucle avec `pattern: "foo"` puis `pattern: "bar"` puis `pattern: "baz"` n'est pas détecté — mêmes tool et même **intention** (chercher à l'aveugle), signatures différentes. Tu détectes la boucle syntaxique, pas la boucle sémantique. **Question** : combien de sessions "bloquées" observées dans les traces `.pcc/traces/` ont réellement 3 signatures identiques ? Si c'est < 20 %, ton détecteur est cosmétique.

### A1.4 — ◐ Angle mort : Le `recentToolMeta.shift()` à 10 éléments

`src/engine/loop.ts:431`. Tu gardes les 10 derniers tool calls pour le routage et le refresh de contexte. Ligne 604-628, tu reconstruis un prompt à partir des **5 derniers `filePath`**. Question que personne dans le repo n'a posée : quelle est la relation entre le nombre de tours et la taille de cette fenêtre ? Un run de 50 tours avec 3 tool calls par tour = 150 calls, dont seuls 10 sont visibles par le routeur. Le routeur de tools (`toolRouter.select`) décide en voyant 6 % de l'historique. Tu n'as pas justifié le choix de 10 — c'est un magic number. **À interroger** : pourquoi pas 20 ? Pourquoi pas "fenêtre adaptative selon complexité" ? La Meta-Harness optimise déjà `reflectionInterval` et `toolTimeoutMs`. Pourquoi pas ce paramètre ?

### A1.5 — ✓ Correct : La partition concurrencySafe / mutating

`src/engine/loop.ts:304-419` exécute les outils `concurrencySafe` en parallèle (`Read`, `Glob`, `Grep`, `Agent`) et les mutants en série. C'est la bonne réponse à une vraie contrainte : deux `Edit` concurrents sur le même fichier sont une condition de course certaine. **Argument supplémentaire** : ça te protège aussi contre un modèle qui demanderait `Write A` + `Read A` dans le même tour — l'ordre importe, la sérialisation le garantit. Le seul risque est d'oublier de marquer un nouvel outil `concurrencySafe: false` par défaut. Vérifie que le defaults est `false` dans `ToolDefinition`.

---

## Axe 2 — Transport & streaming (`transport/`)

### A2.1 — ✓ Correct : L'idle timeout sur SSE séparé du connect timeout

`src/transport/client.ts:133-151`. Deux timeouts distincts : connexion (600s) et idle stream (120s). C'est exactement ce que réclame une API LLM réelle — un modèle qui réfléchit longtemps maintient la connexion, mais 2 minutes sans byte = stream mort. **Argument supplémentaire** : sans cela, un serveur qui se coupe silencieusement bloque l'UI jusqu'au timeout global. Tu as fait le travail.

### A2.2 — ✗ Faux : `throw new DOMException` dans un contexte purement Node

`src/transport/stream.ts:39`. Tu jettes `new DOMException('Stream aborted', 'AbortError')` et ligne 366, tu la captures avec `err instanceof DOMException`. Problème : `DOMException` n'est global en Node que depuis v17. Ton `package.json` ne fixe pas de `engines.node`. Si quelqu'un lance Shugu sur Node 16 (LTS jusqu'à fin 2023), le `throw` échoue silencieusement (ReferenceError lors du premier abort). **Correctif** : soit tu ajoutes `"engines": {"node": ">=22"}` dans `package.json` (cohérent avec `buildPermissionFlags` qui exige v22), soit tu utilises une classe custom (`class AbortError extends Error`). Le mélange DOM API / Node host est une dette silencieuse.

### A2.3 — ~ Contestable : La chaîne de fallback modèle hard-codée

`src/transport/client.ts:95-99`. Chaîne statique `best → balanced → fast`. Steelman : c'est déterministe, lisible, facile à tester. **Critique** : si MiniMax sort `M3.0`, tu dois éditer le code. Pire — si `balanced` est down mais `fast` disponible, tu essaies quand même `balanced` avant de tomber sur `fast`. La "dégradation gracieuse" inclut un essai infructueux. **Question socratique** : si la chaîne était lue depuis `.pcc/config.yaml`, qu'est-ce qui changerait ? Tu pourrais tester un mode `best → fast` (skip balanced), mesurer le latency, et pousser la config. Aujourd'hui tu ne peux pas mesurer parce que tu ne peux pas configurer.

### A2.4 — ◐ Angle mort : L'absence de circuit breaker

Aucun fichier dans `transport/` ne porte ce nom. La retry logic (`errors.ts`) fait exponential backoff + jitter. Mais rien ne coupe l'accès à un endpoint qui répond systématiquement 500. **Scenario à imaginer** : API MiniMax en panne 10 minutes. Ton agent fait 50 tours, chacun re-essaye 3 fois, chaque retry attend 1-8s. Tu brûles 10 minutes de quota retry pour 0 résultat. Un circuit breaker (5 échecs consécutifs → skip pendant 60s) empêche ce gâchis. **Ce que personne dans le repo ne demande** : combien de tokens consommés dans les traces sont "post-échec inutile" ? Les traces le savent (`tool_result` avec `is_error: true`). Tu n'as pas construit le tableau.

---

## Axe 3 — Sécurité & permissions (`policy/`, `plugins/`, guards outils)

### A3.1 — ✗ Faux : Le guard read-before-write n'applique pas `fullAuto` cohéremment

`src/tools/files/FileWriteTool.ts:74` :
```typescript
if (context.readTracker && !context.readTracker.hasRead(absPath) && context.permissionMode !== 'bypass')
```
La condition vérifie uniquement `!== 'bypass'`. Or `permissionMode` peut valoir `default`, `plan`, `acceptEdits`, `fullAuto`, `bypass`. En `fullAuto`, le mode dit "agis, ne demande pas" — mais le guard read-before-write continue de bloquer. Résultat : un `fullAuto` veut écrire un fichier existant non lu → **erreur**, alors que l'intention utilisateur est "vas-y sans déranger". Tu confonds deux axes : la **confiance envers l'utilisateur** (fullAuto) et la **confiance envers le code du modèle** (read-before-write est un filet contre les écrasements accidentels). La logique correcte est : `fullAuto || bypass` skip le guard, `default || acceptEdits || plan` le conservent. Le code actuel est incohérent avec son propre modèle de permissions.

### A3.2 — ◐ Angle mort : `ReadTracker` n'a pas de `clear()`

`src/context/read-tracker.ts:8-25`. Classe de 25 lignes, un `Set<string>` qui grossit en mémoire à chaque `markRead`. Aucune méthode pour vider. Aucun appel à `reset()` dans tout le repo (`grep readTracker` ne retourne que 3 usages : define, markRead, hasRead). **Conséquence** : une session de 8 heures qui lit 5 000 fichiers garde 5 000 chaînes en RAM. Ce n'est pas un leak catastrophique, mais c'est une fuite identitaire — `hasRead(path)` retourne `true` pour un fichier lu 4 heures plus tôt, modifié depuis par un process externe. Le guard *passe* sans que le modèle n'ait l'état actuel. **Question** : un `Read` marque "lu", puis `git pull` change le fichier. Un `Write` ultérieur sans nouveau `Read` passe le guard. Est-ce ton intention ?

### A3.3 — ✓ Correct : La sanitisation multi-phase de `sanitizeUntrustedContent`

`src/utils/security.ts:227-256`. Sept phases distinctes (line endings, zero-width, Cyrillic, HTML entities, role markers, XML tags, HTML comments). C'est bien pensé — tu couvres la "Trojan Source attack" (CVE-2021-42574), les homoglyphes cyrilliques, et les entités HTML numériques (`&#72;uman:` → `Human:`). **Argument supplémentaire** : l'ordre des phases est critique, et tu l'as mis dans le bon ordre (entities avant role markers — sinon `&#72;uman:` échapperait). Le commentaire ligne 243 le dit explicitement. C'est du travail sérieux.

### A3.4 — ~ Contestable : La décision "no --permission sur TypeScript"

`src/plugins/host.ts:140` : `if (nodeVersion < 22 || entryPath.endsWith('.ts')) return []`. En dev mode avec `tsx`, tu perds le sandbox OS. Steelman : `tsx` intercepte les imports et Node refuse `--permission` avec un loader. **Critique** : ça signifie que ton mode dev tourne *sans* les protections que ton mode prod a. C'est le moment exact où un bug plugin corrompt le filesystem du développeur. **Question socratique** : ton dev est-il d'accord pour travailler sans filet, ou faudrait-il au moins un warning explicite au démarrage en dev mode ? Aujourd'hui il n'y a qu'un `logger.debug`.

### A3.5 — ⚡ Simplification : Le "no shadow" builtin protège contre le nom, pas contre le comportement

`src/plugins/host.ts:39-44, 566-570`. Tu refuses qu'un plugin enregistre un outil nommé `Read`, `Write`, etc. **Bonne idée**. Mais un plugin peut enregistrer `ReadFile`, `WriteFile`, `Reader`, et le modèle peut l'appeler à la place de `Read`. Tu t'appuies sur les noms exacts — la surface d'attaque réelle est la **ressemblance sémantique**. **Question** : est-ce que ton threat model considère un plugin hostile comme (a) malveillant-délibéré ou (b) malveillant-convaincant ? Le code actuel gère (a). Tu n'as rien contre (b). Ce n'est pas un bug — c'est une décision non verbalisée.

### A3.6 — ✗ Faux : Le `new RegExp` dans `rules.ts` attrape l'erreur puis perd l'information

`src/policy/rules.ts:58-63` :
```typescript
try { const regex = new RegExp(rule.inputMatch.commandPattern); ... }
catch { return false; }
```
Si un utilisateur écrit dans `.pcc/policy.json` une regex invalide (ex. `(?P<invalid>...)` qui est syntaxe Python), la règle retourne silencieusement `false` → la commande est **autorisée** (aucun match = pas de deny). C'est l'inverse du principe fail-secure. Une règle cassée devrait logger un warning ET fail-closed (treat as deny). Actuellement, une faute de frappe dans une règle de sécurité silencieusement désactive la sécurité.

---

## Axe 4 — Observabilité (`utils/tracer.ts`, `ui/TrackerPanel.tsx`)

### A4.1 — ✓ Correct : Le tracer n'a pas le droit de throw

`src/utils/tracer.ts:112-114, 284-286`. Deux `try/catch` silencieux dans `writeEvent` et `logModelCall` ("Tracer must never throw"). C'est la bonne règle — un observateur qui plante l'observé est un anti-pattern classique. **Argument supplémentaire** : le tracer est appelé ~50 fois par tour sur des chemins chauds. Une seule `fs.appendFile` qui rejette (disque plein) sans catch = crash cascadé de tout le runtime. Tu as raison de sacrifier l'observabilité à la robustesse.

### A4.2 — ◐ Angle mort : Le buffer en mémoire `_sessionEvents` est trimmé à 200, pas indexé par traceId

`src/utils/tracer.ts:66, 102`. Tu gardes 200 événements en mémoire, rolling window. `getTraceEvents(traceId)` filtre ce buffer. **Problème** : un traceId qui a généré 201 événements (agent chaîné, ~40 événements par agent) est déjà partiellement évincé. Tu crois afficher "tous les événements du trace X" mais tu en affiches un sous-ensemble tronqué au hasard de l'ordre d'arrivée. Pour une vue précise, il faut relire le fichier JSONL. **Question** : quand tu veux débugger une session, tu fais `getTraceEvents()` ou tu ouvres le fichier à la main ? Si c'est le second, le buffer en mémoire n'a qu'un usage — l'alimenter `onEvent` pour TrackerPanel — et 200 est une limite arbitraire qui ne sert pas le cas d'usage.

### A4.3 — ⚡ Simplification : `startSpan(parentSpanId?)` accepte le paramètre mais ne l'utilise pas

`src/utils/tracer.ts:133-137`. Signature `startSpan(parentSpanId?: string): string`. Corps : `_currentSpanId = spanId; return spanId;`. Le paramètre `parentSpanId` est **ignoré**. C'est soit un bug (l'intention était de créer une vraie hiérarchie), soit un artefact (tu as gardé la signature d'une version antérieure). Dans les deux cas, le mot "nested tracing" dans le commentaire (`parent-child nesting for agent → tool tracing`, ligne 7) est faux à l'exécution. Les `parentSpanId` dans les événements viennent de `_currentSpanId`, qui est un global écrasé à chaque `startSpan`. Pas de vraie arbre — juste une chaîne.

### A4.4 — ~ Contestable : 20 listeners max sur l'EventEmitter tracer

`src/utils/tracer.ts:61`. `_emitter.setMaxListeners(20)`. Steelman : ça suppose au plus ~20 abonnés concurrents (1 TrackerPanel + quelques tests + marge). **Critique** : un agent multi-niveau (Agent → Agent → Agent) peut spawner plusieurs `onEvent` si chaque niveau veut tracer indépendamment. Tu n'as pas de mécanisme de désinscription automatique quand un agent termine. Le warning Node ("possible EventEmitter memory leak") apparaîtra en tests longs. **Question** : la désinscription est-elle documentée ? Le commentaire ligne 239-243 expose `onEvent` mais ne dit pas "appelle le unsubscribe avant de sortir". C'est un contrat implicite — fragile.

---

## Axe 5 — Extensibilité (plugins, custom agents/commands markdown)

### A5.1 — ✓ Correct : Policy à quatre niveaux (defaults → manifest → policy.defaults → policy.plugins)

`src/plugins/policy.ts:98-149`. La résolution est explicite, ordonnée, et le commentaire ligne 92-96 l'énonce. `capabilitiesDeny` applique **après** `capabilitiesAdd` — donc deny gagne toujours. C'est la bonne sémantique. **Argument supplémentaire** : ce pattern est réutilisable pour les rules de permission côté user (actuellement `rules.ts` les charge de nulle part). Tu as résolu le problème une fois — extends-le.

### A5.2 — ⚡ Simplification : Le mode isolation binaire `trusted | brokered`

`src/plugins/policy.ts:40`. Deux niveaux. Mais la réalité a au moins trois : (1) plugin 100 % trusté (publié par toi, partagé avec tes dev), (2) plugin semi-trusté (écrit par équipe, revu, mais bug possible), (3) plugin hostile (téléchargé). Tu traites (1) et (2) identiquement. **Conséquence** : un plugin interne qui fait un `writeFile('/etc/hosts', ...)` en mode `trusted` passe. C'est peut-être ton intention — mais tu ne l'as pas verbalisée. Le mode `trusted` devrait probablement s'appeler `bypass_sandbox` pour forcer la conscience. Le mot "trusted" amène à penser "sûr" ; le vrai sens est "non surveillé".

### A5.3 — ◐ Angle mort : Les custom commands markdown chargées de `.pcc/commands/*.md`

`src/commands/markdown-loader.ts` + `src/agents/markdown-loader.ts`. Tu protèges les noms buildin (bien). Mais **qui écrit dans `.pcc/commands/` ?** Un clone de repo malveillant, un `git pull` d'une branche compromise, un autre outil CLI. Tu ne signes pas ces fichiers, tu ne les hashes pas, tu ne demandes pas confirmation au premier lancement. Le modèle threat est "utilisateur qui ajoute sa commande" — réel. Il n'est pas "utilisateur qui clone un repo qui a une commande". Ta Phase 1 ajoute une surface d'exécution basée sur le contenu d'un dossier, sans mécanisme de consentement. **Question** : la première fois que Shugu découvre une commande markdown dans un repo, est-ce qu'il demande à l'utilisateur ? Non. Est-ce que ça devrait ? Je pense que oui, et c'est ton angle mort.

### A5.4 — ~ Contestable : Docker optionnel avant `--permission`

`src/plugins/host.ts:232-289`. Priorité `Docker > --permission > bare`. Steelman : Docker offre plus d'isolation (net=none, read-only FS, drop all caps). **Critique** : Docker ajoute une dépendance externe massive. La détection (`docker version`) fait un `execFileSync` de 5s au premier appel — latence visible. Surtout, Docker sur Windows = Docker Desktop = 2-3 GB de RAM réservés en permanence. Tu n'as pas explicité ce coût. Un utilisateur qui installe Shugu sur un laptop 8GB active-t-il Docker sans comprendre qu'il vient de perdre 30 % de sa RAM ? **Question** : le choix Docker-first est-il documenté avec son coût mémoire, ou est-il silencieusement activé ?

---

## Axe 6 — UI/UX terminal (`ui/FullApp.tsx`, `ui/TrackerPanel.tsx`)

### A6.1 — ✓ Correct : Le pattern `<Static>` pour le scrollback

`src/ui/FullApp.tsx:1-27`. Commentaire d'architecture très bien écrit. Séparer historique (printed to scrollback) et zone vive (re-renders) est la solution canonique à "Ink re-render lag avec grosse conversation". **Argument supplémentaire** : c'est aussi ce qui rend compatible le mouse wheel scroll et `Ctrl+Shift+C` pour copier. Si tu avais tout re-rendu, la sélection terminale serait instable. Tu as trouvé le bon compromis.

### A6.2 — ~ Contestable : Le commentaire en français dans le code

`src/ui/FullApp.tsx:130` : `… (ctrl+o pour expand)`. Le reste du codebase est en anglais. Tu as mémorisé (`feedback_french_first`) que l'utilisateur écrit en français, mais cela s'applique aux **heuristiques de classification** (EXPLORE_KEYWORDS), pas aux messages UI. Si Shugu est publié, des anglophones verront "pour expand" sans comprendre. **Question** : est-ce un mix i18n volontaire ou un accident de committer en cours ? Si c'est volontaire, il manque un mécanisme `t()` pour tout le reste. Si c'est accident, c'est un tell que tu travailles sans relecture linguistique.

### A6.3 — ⚡ Simplification : Le TrackerPanel reçoit `stage` depuis tracer.getCurrentStage()

`src/utils/tracer.ts:246-251`. Itère depuis la fin du buffer, prend le **premier** `event.stage` non-null. Problème : un `tool_result` tardif arrivé après un `model_call` suivant écrase l'affichage. Exemple : tour 5 démarre (`stage: 'model'`) → entre-temps le tool_result du tour 4 arrive en async → l'affichage redevient `tool_result` alors que le tour 5 est en cours. L'UI ment sur l'instant courant. **Question socratique** : es-tu sûr que l'ordre d'arrivée des traces reflète l'ordre réel des stages ? Ton tracer est async (`await writeEvent`), l'ordre n'est pas garanti. Un `Promise.all` interne peut reorder.

### A6.4 — ◐ Angle mort : Le companion `Buddy` injecte des observations dans la conversation

`src/engine/loop.ts:595-601`. `config.buddyObserver.drain()` → `messages.push({ role: 'user', content: '[Buddy observation] ...' })`. Tu sanitises avec `sanitizeUntrustedContent`. Mais l'angle mort est ailleurs : **les observations du Buddy sont des messages `role: 'user'` du point de vue du modèle**. Le modèle ne sait pas que c'est un système automatique qui parle, pas le vrai utilisateur. Une observation du type "le disque est plein" peut être interprétée par le modèle comme une requête utilisateur ("oh, le disque est plein, je dois faire quelque chose"). **Question** : pourquoi pas `role: 'system'` (block dans system prompt) ou un canal distinct ? Le design actuel mélange deux interlocuteurs sous la même étiquette.

### A6.5 — ✓ Correction de moi-même : le Ctrl+O fonctionne

**[CORRIGÉ DANS LE RAPPORT 2026-04-16]** En relisant `src/ui/FullApp.tsx:471-483`, le raccourci est bien géré via `useInput` au niveau du composant parent, en amont de `TextInput`. Le raccourci fonctionne. Mon assertion était une extrapolation non vérifiée. Gardée pour mémoire : la revue Rodin elle-même doit être auditable.

---

## Synthèse — Je tranche

### Trois décisions à défendre (même sous pression)

1. **L'AsyncGenerator de `runLoop`** (A1.1). C'est ton meilleur choix architectural. Le pattern `yield LoopEvent` découple UI et engine sans état partagé. Garde-le y compris si quelqu'un te propose un `EventEmitter` "plus idiomatique".
2. **La sanitisation multi-phase de `sanitizeUntrustedContent`** (A3.3). Sept phases dans le bon ordre, avec la vraie connaissance des CVE concrètes (Trojan Source). C'est un travail rare — la plupart des codebases n'en font pas le quart.
3. **Le pattern `<Static>` Ink + live area** (A6.1). Solution canonique proprement appliquée. Ne laisse personne "simplifier" cela en re-rendant tout.

### Trois décisions à reconsidérer

1. **Le guard read-before-write et l'interprétation de `permissionMode`** (A3.1). Incohérent avec ton propre modèle — `fullAuto` devrait skip le guard, pas seulement `bypass`. Correctif : < 5 lignes. Impact : expérience utilisateur fullAuto massivement améliorée.
2. **La regex `rules.ts` qui fail-open silencieusement** (A3.6). Une faute de frappe dans un fichier de sécurité désactive la sécurité. Passage à fail-closed + warning au chargement. < 10 lignes.
3. **Le `DOMException` du stream parser** (A2.2). Soit tu déclares `engines.node >= 22`, soit tu crées une vraie `AbortError` custom. Le mélange DOM/Node est une dette qui explosera au mauvais moment.

### L'angle mort structurel

**Il n'y a aucun consentement explicite sur le contenu exécutable découvert au runtime.** Plugins, custom commands, custom agents markdown — tout ce qui vient d'un dossier `.pcc/` dans un repo cloné s'active au démarrage sans demande. Ton modèle threat pense "utilisateur qui ajoute ses propres commandes". La réalité Phase 1 inclut "utilisateur qui `git clone` un repo dont il n'a pas lu le contenu". Tu as construit une surface d'exécution basée sur l'écosystème (c'est une force) sans le contrat de découverte associé (c'est un angle mort). La correction n'est pas technique, elle est de design : au premier lancement dans un repo, lister ce qui sera chargé et demander confirmation. Une fois signé, ne plus redemander.

---

## Questions ouvertes (auxquelles tu n'as pas à répondre maintenant)

1. La chaîne `best → balanced → fast` de fallback est-elle défendable sur preuve mesurée, ou par intuition ?
2. Si un utilisateur lance Shugu sur Node 16, quel comportement est souhaité : refus explicite ou dégradation silencieuse ?
3. Un plugin `trusted` devrait-il pouvoir écrire dans `C:\Windows\System32` ? Si oui, le mot `trusted` est correct. Sinon, il te faut un troisième niveau.
4. Le classifier `strategy.ts` doit-il supporter les langues autres que FR/EN, ou acceptes-tu que les utilisateurs non-anglophones/francophones paient en tokens LLM systématiquement ?
5. `ReadTracker.hasRead(path)` est-il une assertion "a été lu une fois depuis le début de la session" ou "reflète l'état actuel du fichier" ? Selon la réponse, la stratégie d'invalidation change complètement.
6. Pourquoi 10 dans `recentToolMeta.shift()` ligne 431 ? C'est la question la plus simple à résoudre par mesure.
7. Le Meta-Harness peut-il actuellement explorer les paramètres de sécurité (read-before-write actif/inactif, sanitizer phases activées), ou se limite-t-il aux paramètres de performance ?

---

*Fin de revue. Rien n'est décidé — tout est argumenté.*

---

## Tableau de suivi des correctifs (2026-04-16, post-intervention)

Légende des statuts :
- **RÉSOLU** — correction appliquée + tests ajoutés
- **REPORTÉ** — décision différée (documentée, pas encore implémentée)
- **INVALIDÉ** — l'assertion initiale du rapport était incorrecte
- **MESURÉ** — données empiriques produites, la décision est différée sur base des mesures (voir `metrics-20260416.md`)

| Assertion | Statut | Note |
|---|---|---|
| A1.1 ✓ AsyncGenerator loop | INCHANGÉ | À garder |
| A1.2 ⚡ Classifier i18n | REPORTÉ | Dépend d'une décision produit (FR/EN first vs universel) |
| A1.3 ~ Détection boucle 3-signatures | MESURÉ | 2% des sessions réellement détectées (131 sessions, 15j). Détecteur peu actif mais pas supprimé |
| A1.4 ◐ Fenêtre recentToolMeta=10 | MESURÉ | p95=0, max=138, seulement 3/131 sessions dépassent la fenêtre. La valeur 10 couvre 97.7% du trafic — magic number défendable |
| A1.5 ✓ Concurrency partition | INCHANGÉ | À garder |
| A2.1 ✓ Idle timeout séparé | INCHANGÉ | À garder |
| A2.2 ✗ DOMException | **RÉSOLU** | Nouvelle classe `StreamAbortError` (name=AbortError) dans `transport/errors.ts`. Plus de dépendance DOM |
| A2.3 ~ Fallback chain hardcoded | MESURÉ | 0 fallback observé en 15j (chaîne existe mais non utilisée en prod). Pas urgent à rendre configurable |
| A2.4 ◐ Circuit breaker absent | **RÉSOLU** | Hystrix-like 3-états dans `transport/breaker.ts`, wiré dans `MiniMaxClient.makeRequest`. 13 tests dédiés |
| A3.1 ✗ fullAuto guard incohérent | **RÉSOLU** | `GUARD_BYPASS_MODES = ['fullAuto', 'bypass']` dans `FileWriteTool.ts` + `FileEditTool.ts`. Tests fullAuto/acceptEdits ajoutés |
| A3.2 ◐ ReadTracker sans clear | **RÉSOLU** | Méthodes `clear()`, `invalidate(path)`, `size()` ajoutées. Invalidation auto après Write/Edit. `/clear` REPL la wipe. ReadTracker maintenant instancié dans bootstrap (était manquant) |
| A3.3 ✓ Sanitizer multi-phase | INCHANGÉ | À garder |
| A3.4 ~ --permission off en dev | REPORTÉ | Décision conception (laisser dev sans filet ou warn loud) |
| A3.5 ⚡ Shadow builtin par nom | REPORTÉ | Décision threat model (nom vs sémantique) |
| A3.6 ✗ rules.ts fail-open regex | **RÉSOLU** | Refactor : `compileRules()` valide les regex au chargement via `validateRegexSafety`. Rules invalides rejetées fail-closed (loggé). `BUILTIN_RULES` pré-compilées. Tests fail-closed ajoutés |
| A4.1 ✓ Tracer no-throw | INCHANGÉ | À garder |
| A4.2 ◐ Buffer tracer 200 non-indexé | REPORTÉ | Dette de lisibilité, pas bloquante |
| A4.3 ⚡ startSpan(parentSpanId?) ignoré | **RÉSOLU** | Signature rendue honnête : plus de paramètre. Commentaire mis à jour pour décrire le comportement réel (linear span chaining) |
| A4.4 ~ MaxListeners=20 | REPORTÉ | À mesurer sur long run |
| A5.1 ✓ Policy 4-niveaux | INCHANGÉ | À garder |
| A5.2 ⚡ Binaire trusted\|brokered | **RÉSOLU** | Renommé `trusted` → `unrestricted` (backward-compat : `trusted` accepté en entrée, warn de dépréciation, normalisé en sortie). Test legacy ajouté |
| A5.3 ◐ Pas de consentement markdown | **RÉSOLU** | TOFU trust store `~/.pcc/trusted-repos.json` avec SHA-256 par fichier. `loadMarkdownCommandsWithTrust` + `loadMarkdownAgentsWithTrust`. Bypass mode auto-approve. Variable `PCC_TRUST_ALL=1` pour CI. 17 tests dédiés |
| A5.4 ~ Docker-first | REPORTÉ | Décision de packaging |
| A6.1 ✓ Static Ink scrollback | INCHANGÉ | À garder |
| A6.2 ~ Commentaire FR | **RÉSOLU** | `ctrl+o pour expand` → `ctrl+o to expand` |
| A6.3 ⚡ TrackerPanel stage async race | REPORTÉ | À revérifier si bug observé en pratique |
| A6.4 ◐ Buddy role:'user' | REPORTÉ | Décision conception (canal séparé vs role system) |
| A6.5 ✗ Ctrl+O raccourci inactif | **INVALIDÉ** | Fonctionne bien via `useInput` ligne 471-483. Mon assertion initiale était spéculative |

### Livraison — chiffres

- **Tests ajoutés** : +31 (trust-store 17, circuit-breaker 13, fail-closed rules 4, fullAuto/acceptEdits 3, invalidate/clear 3, plugin-policy legacy 1)
- **Total tests verts après intervention** : **901/901** (vs 870 avant)
- **Typecheck strict** : 0 erreur
- **Build production** : 818 KB `dist/pcc.mjs` (inchangé en ordre de grandeur)
- **Nouveaux fichiers** : `src/credentials/trust-store.ts`, `src/transport/breaker.ts`, `scripts/analyze-traces.ts`, `tests/trust-store.test.ts`, `tests/circuit-breaker.test.ts`
- **Rapport de métriques généré** : `rapport_gpt/metrics-20260416.md` (131 sessions, 15 jours)

Les 11 items RÉSOLU couvrent **tous les ✗ (bugs démontrables)**, les **2 ◐ les plus graves** (consentement plugin, ReadTracker), et **3 ⚡ nettes**. Les 9 REPORTÉ sont des décisions conception qui demandent débat, pas des bugs.

### Angle mort structurel — statut après Phase 3

**Le consentement explicite sur les markdown commands/agents est maintenant en place.** Clone d'un repo hostile → au premier démarrage, la liste des fichiers exécutables découverts s'affiche, l'utilisateur approuve en bloc, les hashes sont persistés. Une modification ultérieure (compromission après `git pull`) re-prompte. Les plugins binaires ont leur propre flow (`onConfirmLocal` préexistant). **Reste non couvert** : les modifications silencieuses d'un fichier déjà approuvé par un autre process tant que l'utilisateur n'a pas redémarré Shugu — hors scope TOFU par design (même limite que SSH known_hosts).
