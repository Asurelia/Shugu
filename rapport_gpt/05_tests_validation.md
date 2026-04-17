# Tests, validation et preuves executables

## Environnement

- CWD: `F:\Dev\Project\Project_cc`
- OS/shell: Windows / PowerShell
- Node observe pendant smoke test: `v24.4.1`
- Variables API shell avant chargement `.env`: non definies (`MINIMAX_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`).
- `.env`: present, contenu non affiche.

## Commande: typecheck

Commande:

```powershell
npm run typecheck
```

Resultat: OK.

Sortie utile:

```text
> shugu@0.2.0 typecheck
> tsc --noEmit
```

Aucune erreur TypeScript affichee.

## Commande: suite Vitest complete

Commande:

```powershell
npm test
```

Resultat: KO.

Synthese:

```text
Test Files  1 failed | 59 passed (60)
Tests       2 failed | 859 passed (861)
```

Echecs:

```text
FAIL tests/search-boundary.test.ts > GrepTool workspace boundary > allows search without path (defaults to cwd)
Error: spawn EPERM
src/tools/search/GrepTool.ts:207:19

FAIL tests/search-boundary.test.ts > GrepTool workspace boundary > allows traversal in bypass mode
Error: spawn EPERM
src/tools/search/GrepTool.ts:207:19
```

Interpretation:

Le test confirme que `GrepTool.tryRipgrep` ne gere pas un `spawn` qui leve synchroniquement `EPERM`; le fallback natif ne s'execute pas.

## Smoke test API reel - connectivite avec budget trop faible

Methode:

- Chargement local de `.env` dans le processus de test.
- Aucune valeur secrete imprimee.
- Appel reel du client `MiniMaxClient` via `npx --no-install tsx -e`.

Commande logique:

```text
MiniMaxClient.complete([{ role: 'user', content: 'Reply with exactly: OK' }],
  { maxTokens: 50, model: MINIMAX_MODELS.fast, temperature: 0.1 })
```

Resultat:

```json
{
  "model": "MiniMax-M2.5-highspeed",
  "stopReason": "max_tokens",
  "text": "",
  "usage": { "input_tokens": 46, "output_tokens": 50 },
  "contentTypes": ["thinking"]
}
```

Interpretation:

C'est le comportement critique pour `src/engine/strategy.ts`, car le classifieur LLM utilise exactement `maxTokens: 50` sur `MINIMAX_MODELS.fast`. Il peut obtenir seulement du `thinking` et aucun texte exploitable.

## Smoke test API reel - budget suffisant

Commande logique:

```text
MiniMaxClient.complete([{ role: 'user', content: 'Reply with exactly: OK' }],
  { maxTokens: 256, model: MINIMAX_MODELS.fast, temperature: 0.1 })
```

Resultat:

```json
{
  "model": "MiniMax-M2.5-highspeed",
  "stopReason": "end_turn",
  "text": "OK",
  "usage": { "input_tokens": 46, "output_tokens": 63 },
  "contentTypes": ["thinking", "text"]
}
```

Interpretation:

L'API et la cle fonctionnent. Le probleme observe n'est pas une panne API; c'est un budget de sortie trop faible pour un modele a raisonnement obligatoire.

## Verification des regles `.env`

Commande logique:

```text
new PermissionResolver('fullAuto').resolve({ name: 'Write', input: { file_path } })
```

Resultats:

```json
{"path":".env","decision":"allow","source":"mode"}
{"path":".env.local","decision":"allow","source":"mode"}
{"path":"sub/.env","decision":"deny","source":"builtin"}
{"path":"sub/deep/.env.local","decision":"allow","source":"mode"}
{"path":"sub\\deep\\.env","decision":"allow","source":"mode"}
```

Interpretation:

La regle builtin bloque seulement certains chemins a un niveau, pas le cas le plus important: `.env` a la racine.

## Tests non effectues / blind spots

- Pas de test TTY manuel de Ctrl+C.
- Pas de test bracketed paste interactif.
- Pas de serveur SSE local pour simuler un body qui bloque apres headers.
- Pas de vraie reponse 429 provider avec header `Retry-After`.
- Pas d'exploitation plugin malveillant en sandbox Windows.
- Pas de test WebFetch sur body lent.
- Pas de test Bash avec arbre de processus enfant/grand-enfant.

## Priorite de correction proposee

1. Corriger `GrepTool.tryRipgrep` pour retablir la suite de tests.
2. Corriger la regle `.env*`.
3. Corriger `classifyByLLM` avec budget/retry/telemetrie.
4. Corriger plugin policy/sandbox ou documenter/refuser les modes non surs.
5. Corriger `FileWriteTool` read-before-write.
6. Corriger les chemins telemetrie fire-and-forget et redaction.
7. Corriger Ctrl+C et paste handling.
