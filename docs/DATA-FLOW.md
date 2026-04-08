# Shugu Data Flow -- Complete Execution Path Documentation

> 12 execution paths traced through 26 source files. Every step verified against code.

## Legend

```
->  synchronous call
=>  async call / await
~>  event emission (LoopEvent, EventEmitter, hook)
[FILE:line]  source location reference
{data}  data structure flowing between steps
|  decision branch
```

---

## 1. CLI Bootstrap -> REPL Loop

### Trigger

```
$ pcc
$ shugu
$ shugu --mode=plan
$ shugu --continue
$ shugu --resume=<id>
```

### Sequence Diagram

```
bin/pcc.mjs
  |
  |--> loadEnv(cwd/.env)                          [bin/pcc.mjs:26]
  |--> loadEnv(~/.pcc/.env)                        [bin/pcc.mjs:27]
  |--> loadEnv(pkg-root/.env)                      [bin/pcc.mjs:29]
  |--> import('../dist/entrypoints/cli.js')        [bin/pcc.mjs:31]
  |
  v
cli.ts main()                                      [cli.ts:20]
  |
  |--> parseArgs()                                 [bootstrap.ts:59]
  |      {process.argv} -> {CliArgs}
  |
  |=> bootstrap(cliArgs)                           [bootstrap.ts:187]
  |    |
  |    |--> new TerminalRenderer()
  |    |--> new MiniMaxClient(opts)
  |    |=> CredentialVault.exists()
  |    |    |-- exists: unlockExistingVault()       [bootstrap.ts:426]
  |    |    |   |--> env PCC_VAULT_PASSWORD?
  |    |    |   |    yes -> vault.unlock(envPassword)
  |    |    |   |    no  -> promptPassword() (3 attempts)
  |    |    |-- !exists: initializeNewVault()       [bootstrap.ts:458]
  |    |        |--> promptPassword({confirm:true})
  |    |        |--> vault.init(password)
  |    |
  |    |--> createDefaultRegistry(credentialProvider)
  |    |      -> {registry, agentTool, webFetchTool, obsidianTool}
  |    |--> new PermissionResolver(cliArgs.mode)
  |    |--> createDefaultSkillRegistry()
  |    |--> createDefaultCommands()
  |    |
  |    |=> pluginRegistry.loadAll(cwd, ...)         [bootstrap.ts:226]
  |    |    |--> local plugins need user confirm (unless bypass)
  |    |    -> hookRegistry
  |    |
  |    |--> registerBehaviorHooks(hookRegistry)     [bootstrap.ts:246]
  |    |--> registerVerificationHook(hookRegistry)  [bootstrap.ts:247]
  |    |=> discoverVault(cwd)                       [bootstrap.ts:250]
  |    |    |--> obsidianVault = new ObsidianVault(path)
  |    |
  |    |--> new MemoryAgent(obsidianVault, cwd)     [bootstrap.ts:258]
  |    |=> memoryAgent.loadIndex()                  [agent.ts:135]
  |    |--> memoryAgent.maintenance() [fire-and-forget]
  |    |
  |    |--> new BackgroundManager()
  |    |--> new Scheduler()
  |    |--> new Kairos()
  |    |--> new SessionManager()
  |    |--> createPermissionPrompter(renderer, permResolver)
  |    |
  |    |--> new AgentOrchestrator(client, toolMap, toolContext)
  |    |--> agentTool.setOrchestrator(orchestrator) [bootstrap.ts:282]
  |    |
  |    |--> register commands: team, review, batch, meta, vault, bg, proactive
  |    |
  |    |=> discoverTools(cwd) -> adapters           [bootstrap.ts:319]
  |    |=> buildSystemPrompt(cwd, skillRegistry, adapters, memoryAgent)
  |    |    -> {prompt, warnings}                   [prompt-builder.ts:89]
  |    |
  |    |--> handle --continue / --resume            [bootstrap.ts:364]
  |    |    |=> sessionMgr.loadLatest(cwd)
  |    |    |   or sessionMgr.load(id)
  |    |    -> resumedMessages: Message[] | null
  |    |
  |    -> {services: RuntimeServices, systemPrompt, needsHatchCeremony, resumedMessages}
  |
  |--> cliArgs.prompt?
  |    |-- YES: runSingleQuery(services, prompt, systemPrompt)  [cli.ts:27]
  |    |-- NO:  runREPL(services, systemPrompt, needsHatchCeremony, resumedMessages) [cli.ts:29]
```

### Detailed Steps

1. **`bin/pcc.mjs`** -- Shebang entrypoint. Loads `.env` files from three locations (cwd, ~/.pcc, package root) in priority order. Environment variables set by earlier files are NOT overwritten by later ones. Then dynamically imports `dist/entrypoints/cli.js`.

2. **`cli.ts:main()`** -- Calls `parseArgs()` to produce a `CliArgs` object, then calls `bootstrap(cliArgs)` to assemble all services.

3. **`bootstrap.ts:parseArgs()`** -- Iterates `process.argv.slice(2)`. Recognizes `--bypass`, `--model=`, `--continue/-c`, `--resume/-r`, `--resume=<id>`, `--verbose/-v`, `--mode=<plan|auto|accept-edits|bypass>`, `--help/-h`. Everything else is concatenated into the prompt string. Model falls back to `MINIMAX_MODEL` env var.

4. **`bootstrap.ts:bootstrap()`** -- The big service assembly function. Creates 15+ service instances, wires them together, returns `RuntimeServices`. Key sequencing: vault MUST unlock before tools are created (credential provider dependency). Plugins load after tool registry but before system prompt (so plugin-registered tools appear in the prompt).

5. **Routing decision** in `cli.ts:26-29`: if `cliArgs.prompt` is non-null, route to single-shot; otherwise route to REPL.

### Error Paths

- No API key: caught at `cli.ts:32`, prints env var instructions, exits 1.
- Vault wrong password 3x: `WrongPasswordError` propagates, caught at `bootstrap.ts:208`, exits 1.
- Any other fatal: `cli.ts:37`, prints message, exits 1.

---

## 2. Single-Shot Execution

### Trigger

```
$ shugu "fix the bug in parser.ts"
$ pcc --mode=auto "run the tests"
```

### Sequence Diagram

```
runSingleQuery(services, prompt, systemPrompt)     [single-shot.ts:13]
  |
  |--> messages = [{role:'user', content: prompt}]
  |--> interrupt = new InterruptController()
  |--> SIGINT handler -> interrupt.abort()
  |
  |--> config: LoopConfig = {
  |      client, systemPrompt (string, not array),
  |      tools, toolDefinitions, toolContext,
  |      maxTurns: 25, hookRegistry
  |    }
  |
  |=> for await (event of runLoop(messages, config, interrupt))
  |    |
  |    |--> handleEvent(event, renderer)            [cli-handlers.ts:39]
  |    |    |-- turn_start: (noop)
  |    |    |-- assistant_message: renderer.startStream() + renderContentBlock()
  |    |    |-- tool_executing: renderer.toolCall()
  |    |    |-- tool_result: renderer.toolResult()
  |    |    |-- turn_end: budget.addTurnUsage()
  |    |    |-- loop_end: renderer.endStream()
  |    |    |-- error: renderer.error()
  |    |
  |    |--> history_sync: replace messages with canonical history
  |    |--> turn_end: capture lastUsage
  |    |--> loop_end: capture totalCost
  |
  |--> renderer.endStream()
  |--> renderer.printStatusBar({model, project, context%, cost})
```

### Data Flow

- **Input**: `{prompt: string, services: RuntimeServices, systemPrompt: string}`
- **Output**: rendered to terminal via `TerminalRenderer`, then process exits naturally
- **No session persistence** -- single-shot does not save to SessionManager
- **No post-turn intelligence** -- no suggestion/speculation/memory extraction
- **No strategy analysis** -- goes directly to runLoop without analyzeTask()

---

## 3. Agentic Turn (Core Loop)

### Trigger

Called by: `runREPL()`, `runSingleQuery()`, `BackgroundManager.runSession()`, `AgentOrchestrator.spawn()`, `runStructuredQuery()` (Meta-Harness)

### Sequence Diagram

```
runLoop(initialMessages, config, interrupt)         [loop.ts:86]
  |
  |--> budget = new BudgetTracker(model, maxBudgetUsd)
  |--> continuation = new ContinuationTracker()
  |--> messages = [...initialMessages]
  |--> turnIndex = 0
  |--> recentToolCalls = []  (loop detection buffer)
  |
  |--- while(true) -----------------------------------------------
  |    |
  |    |=> interrupt.checkpoint()                   [loop.ts:110]
  |    ~> yield {turn_start, turnIndex}
  |    |
  |    |== STEP 1: STREAM MODEL RESPONSE ==
  |    |
  |    |--> streamOptions = {systemPrompt, tools: toolDefinitions, abortSignal}
  |    |--> ensureToolResultPairing(messages)        [turns.ts:86]
  |    |    (patches orphaned tool_use blocks with synthetic results)
  |    |=> client.stream(pairedMessages, streamOptions)
  |    |=> accumulateStream(eventStream, callbacks)  [stream.ts]
  |    |    -> {message: AssistantMessage, stopReason, usage}
  |    |
  |    ~> yield {assistant_message, message}
  |    |
  |    |--> hookRegistry.runMessageHook() [fire-and-forget]
  |    |    (OnMessage hooks run asynchronously, do not block)
  |    |
  |    |--> messages.push(assistantMessage)
  |    |
  |    |== STEP 2: ANALYZE THE TURN ==
  |    |
  |    |--> analyzeTurn(assistantMessage, stopReason, usage)  [turns.ts:33]
  |    |    |--> getToolUseBlocks(assistantMessage)
  |    |    -> {toolCalls[], needsToolExecution, stopReason, usage}
  |    |
  |    |--> budget.addTurnUsage(turnUsage)
  |    ~> yield {turn_end, turnIndex, usage}
  |    |
  |    |== STEP 2.5: MID-TURN REFLECTION ==
  |    |
  |    |--> effectiveReflectionInterval (harnessRuntime || config || 0)
  |    |--> shouldReflect(turnIndex, interval, maxTurns)?
  |    |    |-- turnIndex < 2: NO
  |    |    |-- turnIndex % interval == 0: YES
  |    |    |-- turnIndex == maxTurns/2: YES (force at 50% budget)
  |    |    |-- YES: messages.push(buildReflectionPrompt())
  |    |
  |    |== STEP 3: DECIDE WHETHER TO CONTINUE ==
  |    |
  |    |--> budget.isOverBudget()? -> yield history_sync + loop_end(budget_exceeded)
  |    |
  |    |--> continuation.shouldContinue(usedTokens, contextWindow)?
  |    |    |-- continuationCount >= 5: NO
  |    |    |-- usage >= 90% context: NO
  |    |    |-- last 2 continuations < 500 tokens each: NO (diminishing returns)
  |    |
  |    |--> shouldContinue(turnResult, turnIndex, maxTurns, budgetAllows)
  |    |    |-- stopReason='end_turn' + no tools: STOP (end_turn)
  |    |    |-- stopReason='max_tokens' + no tools + budget OK: AUTO_CONTINUE
  |    |    |-- stopReason='max_tokens' + no tools + no budget: STOP (max_tokens)
  |    |    |-- turnIndex >= maxTurns: STOP (max_turns_reached)
  |    |    |-- needsToolExecution: CONTINUE
  |    |    |-- else: STOP
  |    |
  |    |-- AUTO_CONTINUE:
  |    |    |--> continuation.recordContinuation(outputTokens)
  |    |    |--> messages.push("[System: continue where you left off]")
  |    |    |--> turnIndex++, continue (skip tool execution)
  |    |
  |    |-- STOP:
  |    |    ~> yield {history_sync, messages}
  |    |    ~> yield {loop_end, reason, totalUsage, totalCost}
  |    |    return
  |    |
  |    |== STEP 4: EXECUTE TOOLS ==
  |    |
  |    |=> interrupt.checkpoint()
  |    |
  |    |--> for each call in turnResult.toolCalls:
  |    |    |
  |    |    |--> LOOP DETECTION                     [loop.ts:247]
  |    |    |    |--> push callSig to recentToolCalls (max 5)
  |    |    |    |--> last 3 identical? inject warning message
  |    |    |
  |    |    ~> yield {tool_executing, call, triggeredBy: Agent}
  |    |    |
  |    |    |--> tool = tools.get(call.name)
  |    |    |    |-- !tool: yield {tool_result, "Unknown tool", is_error}
  |    |    |
  |    |    |--> VALIDATE INPUT                     [loop.ts:278]
  |    |    |    |-- error: yield {tool_result, "Validation error", is_error}
  |    |    |
  |    |    |=> PRE-TOOL-USE HOOK                   [loop.ts:293]
  |    |    |    |--> hookRegistry.runPreToolUse({tool, call})
  |    |    |    |    -> {proceed, modifiedCall?, blockReason?}
  |    |    |    |-- !proceed: yield {tool_result, "Blocked by hook", is_error}
  |    |    |    |-- modifiedCall: call = modifiedCall
  |    |    |
  |    |    |=> PERMISSION CHECK                    [loop.ts:314]
  |    |    |    |--> toolContext.askPermission(call.name, actionSummary)
  |    |    |    |    -> createPermissionPrompter() [bootstrap.ts:150]
  |    |    |    |       -> permResolver.resolve(call) [permissions.ts:44]
  |    |    |    |          -> PermissionResult (see Flow 10)
  |    |    |    |-- !granted: yield {tool_result, "Permission denied", is_error}
  |    |    |
  |    |    |=> EXECUTE TOOL                        [loop.ts:333]
  |    |    |    |--> Promise.race([
  |    |    |    |      tool.execute(call, toolContext),
  |    |    |    |      timeout(TOOL_TIMEOUT_MS),       // default 300s
  |    |    |    |      abortPromise(interrupt.signal),
  |    |    |    |    ])
  |    |    |    |-- timeout/abort: result = error
  |    |    |
  |    |    |=> POST-TOOL-USE HOOK                  [loop.ts:361]
  |    |    |    |--> hookRegistry.runPostToolUse({tool, call, result, durationMs})
  |    |    |    |-- modifiedResult: result = modifiedResult
  |    |    |
  |    |    |--> toolResults.push(result)
  |    |    ~> yield {tool_result, result, durationMs}
  |    |
  |    |=> enforceMessageLimit(toolResults)          [loop.ts:395]
  |    |    (spill oversized results to disk)
  |    |--> buildToolResultMessage(limitedResults)    [turns.ts:64]
  |    |    -> UserMessage { content: ToolResultBlock[] }
  |    |--> messages.push(toolResultMessage)
  |    ~> yield {tool_result_message, message}
  |    |
  |    |--> turnIndex++
  |    |--- end while ---
  |
  |-- CATCH: AbortError
  |    ~> yield {history_sync, messages}
  |    ~> yield {loop_end, reason:'aborted', totalUsage, totalCost}
  |
  |-- CATCH: other Error
  |    ~> yield {error, error}
  |    ~> yield {history_sync, messages}
  |    ~> yield {loop_end, reason:'error', totalUsage, totalCost}
```

### Events Emitted (LoopEvent types)

| Event | When | Data |
|---|---|---|
| `turn_start` | Beginning of each while-loop iteration | `{turnIndex}` |
| `assistant_message` | After stream accumulation completes | `{message: AssistantMessage}` |
| `tool_executing` | Before each tool call | `{call: ToolCall, triggeredBy}` |
| `tool_result` | After each tool execution | `{result: ToolResult, durationMs?}` |
| `tool_result_message` | After all tools in a turn, message appended | `{message: UserMessage}` |
| `turn_end` | After analysis, before continuation check | `{turnIndex, usage: Usage}` |
| `history_sync` | Before loop_end -- canonical message snapshot | `{messages: Message[]}` |
| `loop_end` | Terminal event | `{reason, totalUsage, totalCost}` |
| `error` | On unhandled errors | `{error: Error}` |

### Decision Points

1. **Auto-continuation** (`shouldContinue` + `ContinuationTracker`): if model hits max_tokens without tool calls and budget allows, inject a continuation nudge and loop again. Max 5 continuations, with diminishing returns detection.

2. **Loop detection**: if the same tool+args signature appears 3 consecutive times, inject a warning message telling the model to change its approach.

3. **Reflection injection**: at configurable intervals (set by strategy layer or Meta-Harness), inject `[REFLECTION]` prompts that trigger self-evaluation via the model's next thinking step. Zero extra LLM calls.

---

## 4. REPL Interactive Turn (Full Cycle)

### Trigger

User types a non-command input at the REPL prompt.

### Sequence Diagram

```
runREPL(services, systemPrompt, needsHatchCeremony, resumedMessages)
  |                                                 [repl.ts:30]
  |--> conversationMessages = [...resumedMessages] or []
  |--> budget = new BudgetTracker(model)
  |--> tokenTracker = new TokenBudgetTracker({model})
  |--> session = sessionMgr.createSession(cwd, model)
  |--> launchFullApp()  (Ink React UI)              [repl.ts:108]
  |--> wire agent event rendering                   [repl.ts:120]
  |--> render banner into scrollable area           [repl.ts:150]
  |--> set session title (project + git branch)     [repl.ts:175]
  |--> hatch ceremony (if first run)                [repl.ts:186]
  |
  |--- while(true) -----------------------------------------------
  |    |
  |    |--> input = await app.waitForInput()        [repl.ts:251]
  |    |--> (empty input: continue)
  |    |
  |    |--> tracer.startTrace()
  |    |--> correctionPatterns.test(input)?          [repl.ts:263]
  |    |    |--> correctionCount++
  |    |
  |    |--> kairos.onUserInput()                    [repl.ts:269]
  |    |    |--> away_summary or break_suggestion?
  |    |
  |    |== DISPATCH: INLINE COMMANDS ==
  |    |
  |    |=> handleInlineCommand(input, replState)     [repl-commands.ts:40]
  |    |    |-- /buddy, /pet, /buddy card, /buddy pet, /buddy mute/unmute/off/name
  |    |    |-- /cost: show budget summary
  |    |    |-- /expand, /transcript: dump transcript
  |    |    |-- /thinking: toggle thinking expanded
  |    |    |-- /context: show token usage
  |    |    |-- /resume, /continue: session management
  |    |    |-- /mode <mode>: switch permission mode
  |    |    |-- /compact: manual compaction
  |    |    |-- handled? continue
  |    |
  |    |== DISPATCH: SKILL MATCHING ==
  |    |
  |    |--> input.startsWith('/')?
  |    |    |--> skillRegistry.match(input)          [loader.ts:135]
  |    |    |    1. command triggers (exact /cmd match)
  |    |    |    2. keyword triggers (substring match)
  |    |    |    3. pattern triggers (regex match)
  |    |    |-- match found:
  |    |    |    |=> skill.execute(skillCtx)
  |    |    |    |-- type='handled': continue
  |    |    |    |-- type='error': display, continue
  |    |    |    |-- type='prompt': push to conversationMessages
  |    |
  |    |== DISPATCH: COMMAND REGISTRY ==
  |    |
  |    |--> input.startsWith('/')?
  |    |    |=> commands.dispatch(input, cmdCtx)
  |    |    |-- 'handled': continue
  |    |    |-- 'clear': conversationMessages.length = 0, continue
  |    |    |-- 'exit': save session, dispose, return
  |    |    |-- 'error': display, continue
  |    |    |-- 'prompt': push to conversationMessages, fall through
  |    |
  |    |-- NOT a command: conversationMessages.push({role:'user', content:input})
  |    |
  |    |== STRATEGY ANALYSIS ==
  |    |
  |    |=> analyzeTask(input, messages, client)      [strategy.ts:191]
  |    |    |--> classifyByHeuristics(input)          [strategy.ts:52]
  |    |    |    (zero tokens, regex-based)
  |    |    |-- null (ambiguous):
  |    |    |    |=> classifyByLLM(client, input)     [strategy.ts:98]
  |    |    |       (~150 tokens, M2.5 fast model)
  |    |    -> {complexity, strategyPrompt, reflectionInterval, classifiedBy}
  |    |
  |    |== VOLATILE PROMPT ASSEMBLY ==
  |    |
  |    |=> obsidianVault.refreshContext()  (throttled 60s)
  |    |=> memoryAgent.getRelevantContext(input, 5)   [agent.ts:259]
  |    |--> buildVolatilePromptParts({mode, vault, strategy, kairos, memory})
  |    |    -> string[] (injected as extra system prompt blocks)
  |    |
  |    |== AUTO-COMPACTION ==
  |    |
  |    |--> tokenTracker.shouldAutoCompact()?
  |    |    |=> compactConversation(messages, client)  [compactor.ts:40]
  |    |    |-- wasCompacted: replace messages, record success
  |    |    |-- error: record failure, circuit breaker after 3
  |    |
  |    |== EXECUTE AGENTIC LOOP ==
  |    |
  |    |--> interrupt = new InterruptController()
  |    |--> SIGINT -> interrupt.abort()
  |    |--> config: LoopConfig = {
  |    |      client, systemPrompt: [static + volatile],
  |    |      tools, toolDefinitions, toolContext(fresh abort),
  |    |      hookRegistry, maxTurns: 25, reflectionInterval
  |    |    }
  |    |
  |    |=> for await (event of runLoop(conversationMessages, config, interrupt))
  |    |    |--> handleEventForApp(event, app, budget)   [cli-handlers.ts:99]
  |    |    |    (pushes UIMessages to Ink FullApp)
  |    |    |--> companion reactions on tool_executing/error
  |    |    |--> history_sync: replace conversationMessages
  |    |    |--> turn_end: update tokenTracker + statusBar
  |    |
  |    |--> brew timer (duration + token count display)
  |    |--> companion done reaction
  |    |
  |    |== POST-TURN INTELLIGENCE ==
  |    |
  |    |=> runPostTurnIntelligence(config, callback)  [intelligence.ts:272]
  |    |    [fire-and-forget, does NOT block REPL]
  |    |    |=> parallel:
  |    |    |    |- generatePromptSuggestion()         [intelligence.ts:51]
  |    |    |    |  (last 4 messages, ~100 tokens, M2.5)
  |    |    |    |- extractMemories()                   [intelligence.ts:199]
  |    |    |       (last 6 messages, ~500 tokens, M2.5)
  |    |    |=> sequential (only if suggestion found):
  |    |    |    |- speculate()                          [intelligence.ts:122]
  |    |    |       (read-only pre-analysis, ~300 tokens)
  |    |    |
  |    |    callback(result):
  |    |       |--> display suggestion
  |    |       |--> display speculation preview
  |    |       |=> memoryAgent.saveLLMExtracted(memories)
  |    |       |=> memoryAgent.flushIndex()
  |    |
  |    |== SESSION PERSISTENCE ==
  |    |
  |    |=> sessionMgr.save(session)
  |    |
  |    |--- end while ---
```

### Data Flowing Per Turn

| Step | Input | Output |
|---|---|---|
| User input | raw string | trimmed string |
| Inline command check | input string | `{handled: bool}` |
| Skill match | `/command args` | `{skill, args}` or null |
| Command dispatch | `/cmd args` | `CommandResult` |
| Strategy analysis | input + messages | `{complexity, strategyPrompt, reflectionInterval}` |
| Volatile prompt | mode, vault, strategy, kairos, memory | `string[]` |
| Auto-compaction | messages + client | `{wasCompacted, removedTurns}` |
| Agentic loop | messages + config | stream of `LoopEvent` |
| Post-turn intelligence | messages + client | `{suggestion, speculation, memories}` |

---

## 5. Sub-Agent Spawn

### Trigger

Model calls the `Agent` tool, or commands like `/team`, `/review`, `/batch` invoke the orchestrator programmatically.

### Sequence Diagram

```
AgentOrchestrator.spawn(task, agentType, options)   [orchestrator.ts:128]
  |
  |--> GUARD: activeAgents.size >= MAX_ACTIVE_AGENTS (15)?
  |    |-- YES: return error result immediately
  |
  |--> definition = agentRegistry[agentType] || BUILTIN_AGENTS[agentType] || 'general'
  |
  |    Built-in agent types:
  |    - 'general':  all tools, 15 turns
  |    - 'explore':  Read/Glob/Grep/Bash only, 10 turns
  |    - 'code':     all tools, 20 turns
  |    - 'review':   Read/Glob/Grep/Bash only, 10 turns
  |    - 'test':     all tools, 15 turns
  |
  |--> agentId = "agent-{counter}"
  |--> interrupt = new InterruptController()
  |--> activeAgents.set(agentId, interrupt)
  |
  |-- options.isolation === 'worktree'?
  |    |=> resolveGitRoot(parentCwd)
  |    |=> createWorktree(gitRoot)                   [worktree.ts]
  |    |--> effectiveCwd = worktree.path (+ relCwd)
  |
  |--> buildToolSet(definition, overrideAllowed, depth)
  |    |-- depth >= MAX_AGENT_DEPTH (3): remove Agent tool
  |    |-- depth < MAX: clone Agent tool with incremented depth
  |
  |--> buildAgentPrompt(definition, context, depth, cwd)
  |    |-- base guidelines + role prompt + environment info
  |    |-- additionalContext from parent (if provided)
  |
  |--> agentToolContext = {cwd: effectiveCwd, abortSignal: interrupt, ...parent}
  |--> messages = [{role:'user', content: task}]
  |
  |=> for await (event of runLoop(messages, config, interrupt))
  |    |--> events.push(event)
  |    |--> track: lastAssistantMessage, canonicalMessages, turns, endReason, costUsd
  |    |--> options.onEvent?.(event)  (forward to parent UI)
  |
  |--> extract text response from lastAssistantMessage
  |
  |-- worktree cleanup:
  |    |=> worktreeHasChanges(worktree)?
  |    |-- no changes: removeWorktree(gitRoot, worktree)
  |    |-- has changes: keep in result for caller to merge/inspect
  |
  |--> finally: activeAgents.delete(agentId)
  |
  -> AgentResult {
       response, events, messages,
       success: (endReason === 'end_turn'),
       endReason, costUsd, turns,
       worktree?, cleanupWarnings?
     }
```

### Nesting Rules

- **MAX_AGENT_DEPTH = 3**: agents can spawn sub-agents up to 3 levels deep
- **MAX_ACTIVE_AGENTS = 15**: total across all nesting levels
- At max depth, the `Agent` tool is removed from the sub-agent's tool set
- Below max depth, the Agent tool is cloned with `depth + 1` so it propagates the counter

### Delegation Patterns (`delegation.ts`)

```
delegateParallel(orchestrator, tasks[])              [delegation.ts:28]
  |--> Promise.all(tasks.map(t => orchestrator.spawn(...)))
  -> ParallelResults { results: Map<id, AgentResult>, totalCostUsd, allSucceeded }

delegateChain(orchestrator, steps[])                 [delegation.ts:68]
  |--> for each step:
  |    |--> prompt = step.prompt(previousResult) or step.prompt
  |    |=> orchestrator.spawn(prompt, agentType, {context: previousResult})
  |    |--> previousResult = result.response
  |    |-- !result.success: break chain
  -> AgentResult[]
```

---

## 6. Slash Command Dispatch

### Trigger

User types `/something` at the REPL prompt.

### Resolution Order

```
User input: "/foo bar baz"
  |
  |== 1. INLINE REPL COMMANDS (repl-commands.ts) ==
  |--> handleInlineCommand(input, replState)
  |    These have direct REPL state access:
  |    /buddy, /pet, /cost, /expand, /transcript, /thinking,
  |    /context, /resume, /continue, /mode, /compact
  |    |-- handled? -> done
  |
  |== 2. SKILL REGISTRY (skills/loader.ts) ==
  |--> skillRegistry.match(input)
  |    |--> check command triggers: /cmd exact match
  |    |--> check keyword triggers: substring match
  |    |--> check pattern triggers: regex match
  |    |-- match found?
  |    |    |=> skill.execute(skillCtx)
  |    |    -> SkillResult: 'handled' | 'error' | 'prompt'
  |    |-- 'prompt': inject into conversationMessages, fall through to loop
  |
  |== 3. COMMAND REGISTRY (commands/registry.ts) ==
  |--> commands.dispatch(input, cmdCtx)
  |    Registered commands:
  |    /team, /review, /batch, /meta, /vault, /bg, /proactive,
  |    /clear, /exit, /quit, /help, /tools, /mode, /model,
  |    /status, /reset, /export, /import, /diff, /history
  |    -> CommandResult: 'handled' | 'clear' | 'exit' | 'error' | 'prompt'
  |
  |== 4. FALLBACK ==
  |--> unrecognized /command: continue (skip, no error shown)
```

### Data Structures

```typescript
// SkillResult union
{ type: 'handled' }                     // Skill fully handled the input
{ type: 'error', message: string }      // Display error, skip loop
{ type: 'prompt', prompt: string }      // Inject as user message, run loop

// CommandResult union
{ type: 'handled' }                     // Command executed, continue REPL
{ type: 'clear' }                       // Clear conversation history
{ type: 'exit', reason: string }        // Exit REPL
{ type: 'error', message: string }      // Display error
{ type: 'prompt', prompt: string }      // Inject as user message, run loop
```

---

## 7. Skill Invocation

### Trigger

`skillRegistry.match(input)` finds a matching skill.

### Sequence Diagram

```
skillRegistry.match(input)                           [loader.ts:135]
  |
  |--> for each skill:
  |    |--> for each trigger:
  |    |    |-- command trigger: /cmd exact match
  |    |    |-- keyword trigger: any keyword in input (case-insensitive)
  |    |    |-- pattern trigger: regex match
  |    -> {skill: Skill, args: string} or null
  |
  |--> if match found:
       |
       |--> build SkillContext:                      [repl.ts:298]
       |    {
       |      input,          // raw user input
       |      args,           // extracted args from trigger
       |      cwd,            // working directory
       |      messages,       // conversation history
       |      toolContext,    // tool execution context
       |      tools,          // available tool map
       |      info(msg),      // display info callback
       |      error(msg),     // display error callback
       |      query(prompt),  // raw model query (no tools)
       |      runAgent(prompt) // full agentic loop
       |    }
       |
       |=> skill.execute(skillCtx) -> SkillResult
       |
       |-- type='handled':
       |    Done. REPL continues to next prompt.
       |
       |-- type='error':
       |    Display error message. REPL continues.
       |
       |-- type='prompt':
       |    Push prompt into conversationMessages.
       |    Fall through to agentic loop execution.
```

### Skill Categories

| Category | Purpose | Examples |
|---|---|---|
| workflow | Multi-step generation pipelines | /vibe, /dream |
| analysis | Code analysis, review, exploration | /hunt, /brain |
| automation | Recurring/proactive tasks | /proactive |
| knowledge | Memory, Obsidian, second brain | (memory skills) |
| utility | One-shot utilities | /loop, /schedule |
| custom | User-defined | (loaded from disk) |

### Skill Loading

- **Bundled skills**: registered by `createDefaultSkillRegistry()` at bootstrap
- **External skills**: `loadExternalSkills(registry, directory)` scans a directory for `.ts`/`.js`/`.mjs` files exporting a `skill` object
- **Plugin skills**: loaded by `PluginRegistry.loadAll()` as part of plugin initialization

---

## 8. Meta-Harness Run

### Trigger

```
/meta run [--gen=5] [--candidates=2] [--repeat=1]
```

### Sequence Diagram

```
handleRun(args, cwd, archive, orchestrator, client, ctx)  [cli.ts:145]
  |
  |--> parseRunOptions(args)
  |    -> {generations, candidates, repeat, dataset}
  |
  |=> loadHarnessConfig(harnesses/default/)          [config.ts]
  |=> validateHarnessConfig(baseConfig)
  |=> loadDataset(datasetPath, 0.7)                  [dataset.ts]
  |    -> {searchSet: EvalTask[], holdoutSet: EvalTask[]}
  |
  |--> manifest = {runId, status:'running', generation:0, ...}
  |=> archive.createRun(manifest)
  |
  |--> evaluator = new MetaEvaluator(archive, evalOptions)
  |--> proposer = new MetaProposer(orchestrator, archive, client)
  |
  |== BASELINE EVALUATION ==
  |
  |=> evaluator.evaluate(baseConfig, searchSet, runId, baselineId)
  |    |--> for each task (repeated N times):
  |    |    |=> evaluateTask(config, task, ...)       [evaluator.ts:100]
  |    |    |    |
  |    |    |    |=> resolveGitRoot() + createWorktree()
  |    |    |    |    (fresh git worktree per task)
  |    |    |    |
  |    |    |    |=> task.setupCommand if provided
  |    |    |    |
  |    |    |    |=> bootstrapMeta({harnessConfig, cwd, archivePath})
  |    |    |    |    [runtime.ts:48]
  |    |    |    |    |--> new MiniMaxClient(temp/maxTokens from config)
  |    |    |    |    |--> vault.unlock(PCC_VAULT_PASSWORD env)
  |    |    |    |    |--> createDefaultRegistry()
  |    |    |    |    |--> new PermissionResolver('fullAuto')
  |    |    |    |    |--> askPermission = async () => true
  |    |    |    |    |--> pluginRegistry.loadAll() (auto-accept)
  |    |    |    |    |--> registerBehaviorHooks() + registerVerificationHook()
  |    |    |    |    |--> new AgentOrchestrator(client, tools, toolContext, agentRegistry)
  |    |    |    |    |=> buildSystemPrompt(cwd, null, null, null, harnessConfig)
  |    |    |    |    |    (no skills, no adapters, no memory in meta mode)
  |    |    |    |    |--> build LoopConfig with harnessRuntime overrides
  |    |    |    |    -> MetaRuntime {loopConfig, orchestrator, systemPrompt, dispose()}
  |    |    |    |
  |    |    |    |=> runStructuredQuery(task.prompt, runtime, {timeoutMs})
  |    |    |    |    [collect.ts:26]
  |    |    |    |    |--> messages = [{role:'user', content: prompt}]
  |    |    |    |    |=> for await (event of runLoop(messages, loopConfig, interrupt))
  |    |    |    |    |    |--> collect events, toolStats, turns, cost, usage
  |    |    |    |    |    |--> history_sync: replace messages
  |    |    |    |    -> StructuredResult {messages, events, costUsd, turns, toolStats, ...}
  |    |    |    |
  |    |    |    |=> scoreTask(task, structured, cwd)  [evaluator.ts:189]
  |    |    |    |    |-- 'criteria':
  |    |    |    |    |    |--> for each criterion:
  |    |    |    |    |    |    |-- file_exists: stat(path)
  |    |    |    |    |    |    |-- file_contains: grep pattern in recent files
  |    |    |    |    |    |    |-- command_succeeds: run command
  |    |    |    |    |    |    |-- output_contains: search assistant messages
  |    |    |    |    |    |    |-- cost_under: compare costUsd
  |    |    |    |    |    |    |-- turns_under: compare turns
  |    |    |    |    |    -> weighted score [0,1]
  |    |    |    |    |-- 'command': run command, parse exit code or stdout float
  |    |    |    |    |-- 'llm_judge': (TODO) MiniMax call with rubric
  |    |    |    |
  |    |    |    |=> redactMessages() + redactTraceEvents()
  |    |    |    |=> archive.writeResult() + archive.writeTrace()
  |    |    |    |
  |    |    |    |--> finally: runtime.dispose() + removeWorktree()
  |    |    |
  |    |    -> EvalResult per task
  |    |
  |    |--> aggregateScores(results)                  [evaluator.ts:356]
  |    |    |--> group by taskId
  |    |    |--> per-task: aggregate via mean/median/best/worst
  |    |    |--> overall: average of task scores
  |    |    -> {aggregateScore, successRate, avgTurns, avgTokens}
  |    |
  |    -> CandidateManifest
  |
  |== OPTIMIZATION LOOP (generations) ==
  |
  |--> for gen = 1 to maxGenerations:
  |    |
  |    |== PARENT SELECTION ==
  |    |
  |    |=> archive.listCandidates(runId)
  |    |--> scored = candidates.map(c => {objectives: {accuracy, cost, tokens, turns, errorRate}})
  |    |--> selectParents(scored, 3)                  [selector.ts:152]
  |    |    |--> computeParetoFrontier(candidates)    [selector.ts:58]
  |    |    |    (non-dominated set using 5 objectives)
  |    |    |--> if frontier >= count: pick evenly spaced from ranked frontier
  |    |    |--> else: frontier + top-ranked non-frontier
  |    |
  |    |== PROPOSAL ==
  |    |
  |    |=> proposer.propose(runId, parentManifests, gen, count)
  |    |    [proposer.ts:48]
  |    |    |--> buildProposerPrompt()                [proposer.ts:85]
  |    |    |    (parent summaries, per-task results, Pareto frontier, leaderboard,
  |    |    |     mutation space documentation)
  |    |    |=> orchestrator.spawn(prompt, 'general', {
  |    |    |     maxTurns:25, maxBudgetUsd:0.50,
  |    |    |     isolation:'worktree',
  |    |    |     allowedTools: [Read, Write, Glob, Grep, Bash]
  |    |    |   })
  |    |    |    (PROPOSER IS A SHUGU AGENT reading the archive filesystem)
  |    |    |
  |    |    |--> extractConfigs(response, worktreePath, count)
  |    |    |    1. Try reading proposed-N.yaml from worktree
  |    |    |    2. Fallback: extract YAML blocks from response text
  |    |    |    3. validateHarnessConfig() each one
  |    |    -> HarnessConfig[]
  |    |
  |    |== EVALUATION ==
  |    |
  |    |--> for each proposal:
  |    |    |=> evaluator.evaluate(config, searchSet, runId, candidateId)
  |    |    (same flow as baseline evaluation above)
  |    |
  |    |=> archive.updateRun(runId, manifest)
  |
  |== FINAL REPORT ==
  |
  |--> manifest.status = 'completed'
  |--> computeParetoFrontier(finalScored)
  |--> generateRunReport(manifest, candidates, frontier)
```

### Key Design: Proposer is a Shugu Agent

The Meta-Harness proposer is NOT a separate system. It is a regular Shugu sub-agent spawned via `orchestrator.spawn()` that reads the archive filesystem using standard tools (Read, Glob, Grep, Bash). This means it has the same capabilities as any other sub-agent and can inspect execution traces, compare configs, and write YAML files.

---

## 9. Background Session

### Trigger

```
/bg "watch for test failures and fix them"
```

### Sequence Diagram

```
BackgroundManager.start(name, prompt, config)       [background.ts:62]
  |
  |--> id = "bg-{counter}"
  |--> interrupt = new InterruptController()
  |--> session = {id, name, prompt, status:'running', ...}
  |--> sessions.set(id, session)
  ~> emit 'session:start'
  |
  |--> runSession(id, prompt, config, interrupt) [fire-and-forget]
       |                                            [background.ts:165]
       |--> messages = [{role:'user', content: prompt}]
       |
       |=> for await (event of runLoop(messages, config, interrupt))
       |    |--> processEvent(id, event)
       |    |    |-- turn_start: logLine("Turn N")
       |    |    |-- assistant_message: update session.response, logLine(text)
       |    |    |-- history_sync: store canonical messages
       |    |    |-- tool_executing: logLine("[tool] name")
       |    |    |-- tool_result: logLine("[result] preview")
       |    |    |-- turn_end: session.turns++
       |    |    |-- loop_end: session.costUsd, status='aborted' if reason='aborted'
       |    |    |-- error: logLine("[ERROR] message")
       |
       |-- catch: session.status = 'error'
       |-- finally: session.endedAt = now, emit 'session:end'
       |
       |    logLine(id, line):                      [background.ts:248]
       |    |--> session.log.push(line) (max 200 lines, FIFO)
       |    |--> notify all attached listeners
```

### Interaction from REPL

- **`/bg list`**: list all sessions with status
- **`/bg attach <id>`**: attach listener, replay log, see live output
- **`/bg kill <id>`**: `bgManager.abort(id)` -> interrupt.abort()
- **`/bg remove <id>`**: remove completed/aborted session from list

---

## 10. Permission Resolution Chain

### Trigger

Every tool call in the agentic loop passes through `toolContext.askPermission()`.

### Resolution Order

```
toolContext.askPermission(toolName, actionSummary)
  |                                                  [bootstrap.ts:150]
  |--> createPermissionPrompter(renderer, permResolver)
       |
       |--> permResolver.resolve(call)               [permissions.ts:44]
       |
       |== STEP 1: BUILT-IN DENY RULES ==           [permissions.ts:46]
       |--> evaluateRules(BUILTIN_RULES, call)
       |    (hardcoded safety rules: e.g., block rm -rf /, format c:)
       |    |-- decision='deny': return {deny, reason, source:'builtin'}
       |
       |== STEP 2: USER RULES ==                     [permissions.ts:56]
       |--> evaluateRules(this.userRules, call)
       |    (user-configured allow/deny/ask rules)
       |    |-- match: return {decision, reason, source:'user'}
       |
       |== STEP 3: SESSION ALLOWS ==                 [permissions.ts:66]
       |--> sessionAllows.has(sessionKey)?
       |    sessionKey:
       |      Bash -> "Bash:{first_word_of_command}"
       |      other -> tool name
       |    |-- YES: return {allow, source:'user'}
       |
       |== STEP 4: TOOL CATEGORY + MODE DEFAULT ==   [permissions.ts:76]
       |--> category = getToolCategory(call.name)    [modes.ts:29]
       |    Read/Glob/Grep -> 'read'
       |    Write/Edit -> 'write'
       |    Bash -> 'execute'
       |    WebFetch/WebSearch -> 'network'
       |    Agent -> 'agent'
       |    other -> 'system'
       |
       |--> getDefaultDecision(mode, category)       [modes.ts:76]
       |
       |    MODE MATRIX:
       |    +--------------+-------+-------+---------+---------+-------+--------+
       |    | Mode         | read  | write | execute | network | agent | system |
       |    +--------------+-------+-------+---------+---------+-------+--------+
       |    | plan         | ask   | ask   | ask     | ask     | ask   | ask    |
       |    | default      | allow | ask   | ask     | allow   | ask   | ask    |
       |    | acceptEdits  | allow | allow | ask     | allow   | ask   | ask    |
       |    | fullAuto     | allow | allow | *class* | allow   | allow | allow  |
       |    | bypass       | allow | allow | allow   | allow   | allow | allow  |
       |    +--------------+-------+-------+---------+---------+-------+--------+
       |
       |== STEP 5: RISK CLASSIFIER (fullAuto + execute only) ==
       |--> mode='fullAuto' && category='execute'?   [permissions.ts:80]
       |    |--> classifyBashRisk(command)            [classifier.ts]
       |    |    -> {level: 'low'|'medium'|'high', reason}
       |    |    |-- low: return {allow, source:'classifier'}
       |    |    |-- medium: return {ask, source:'classifier'}
       |    |    |-- high: return {ask, source:'classifier'}
       |
       |== STEP 6: RETURN MODE DEFAULT ==
       -> {decision, reason:"Mode X default for Y tools", source:'mode'}
  |
  |--> decision === 'allow': return true
  |--> decision === 'deny': renderer.permissionDenied(), return false
  |--> decision === 'ask': return renderer.permissionPrompt()
       (interactive Y/N prompt in terminal)
```

---

## 11. Memory Extraction Pipeline

### Trigger

Two extraction paths fire on every REPL turn:

1. **Regex hints** (inline, synchronous, 0 tokens)
2. **LLM extraction** (post-turn, async, ~500 tokens via M2.5)

### Sequence Diagram

```
== PATH A: REGEX HINTS (inline) ==

memoryAgent.extractHints(userMessage)                [agent.ts:170]
  |--> detectMemoryHints(userMessage)                [extract.ts]
  |    (regex patterns for preferences, decisions, etc.)
  -> MemoryCandidate[] -> MemoryItem[] (source:'hint', confidence varies)

== PATH B: LLM EXTRACTION (post-turn async) ==

runPostTurnIntelligence(config, callback)            [intelligence.ts:272]
  |
  |=> extractMemories(client, messages, model)       [intelligence.ts:199]
  |    |--> last 6 messages as context
  |    |--> MEMORY_EXTRACTION_PROMPT (system prompt)
  |    |    "Extract knowledge worth persisting..."
  |    |    "0-3 items per turn. Quality > quantity."
  |    |=> client.complete([...], {maxTokens:500, temp:0.3})
  |    |--> parse "MEMORY: title | content" lines
  |    -> ExtractedMemory[] {title, content}
  |
  callback:
  |=> memoryAgent.saveLLMExtracted(memories)         [agent.ts:179]
       |--> for each memory:
       |    |--> classify type (decision/preference/error_solution/reference/project_fact)
       |    |--> REDACTION CHECK                     [agent.ts:93]
       |    |    isSuspiciousMemory(content)?
       |    |    (sk-*, ghp_*, Bearer tokens, connection strings, passwords)
       |    |    |-- YES: reject, log warning
       |    |
       |    |=> memoryAgent.save(item)               [agent.ts:208]
       |         |--> DEDUP: findSimilar(title, content)
       |         |    (slug title match OR first-100-chars content match)
       |         |    |-- existing with lower confidence: update in place
       |         |    |-- existing with higher confidence: skip (return false)
       |         |
       |         |-- Obsidian vault available?
       |         |    |=> vault.saveAgentNote(title, content, {tags, type})
       |         |    |--> item.vaultPath = result
       |         |
       |         |--> index.items.push(item)
       |         |--> dirty = true
       |
       |=> memoryAgent.flushIndex()                  [agent.ts:151]
            |--> write index.json to .pcc/memory/index.json
```

### Memory Retrieval (per-turn injection)

```
memoryAgent.getRelevantContext(query, limit=5)       [agent.ts:259]
  |
  |--> searchIndex(query, limit)                     [agent.ts:397]
  |    |--> queryWords = query.split().filter(>2 chars)
  |    |--> expandQueryTerms(queryWords)             [agent.ts:74]
  |    |    (synonym expansion: "database" -> "db","sql","postgres",...)
  |    |--> score each item:
  |    |    title match: +3, tag match: +2, content match: +1
  |    |    prefix matching: +0.5
  |    |    recency boost: 0-0.5 (linear decay over 30 days)
  |    |--> filter(score > 0.5), sort descending, slice(limit)
  |
  |-- vault available?
  |    |=> vault.searchContent(query, limit)
  |    |--> merge vault results not already in index
  |
  |--> format as "# Relevant memories\n- [type] title: content"
  -> string (injected into volatile system prompt parts)
```

### Startup Context (session start)

```
memoryAgent.getStartupContext()                      [agent.ts:300]
  |--> sort index.items by timestamp descending
  |--> take top 10
  -> "# Memories from previous sessions\n- [type] title: content"
```

---

## 12. Context Compaction

### Trigger

Two paths:

1. **Auto-compaction**: `tokenTracker.shouldAutoCompact()` returns true in REPL loop
2. **Manual compaction**: user types `/compact`

### Sequence Diagram

```
compactConversation(messages, client, config?)       [compactor.ts:40]
  |
  |--> config defaults: keepRecentTurns=6, summaryMaxTokens=2048
  |
  |--> identifyTurns(messages)                       [compactor.ts:112]
  |    |--> group messages into turns
  |    |    turn boundary = user message that is NOT a tool_result
  |    |    tool_result messages stay in the current turn
  |    -> Turn[] (each with messages[])
  |
  |--> turns.length <= keepRecentTurns?
  |    |-- YES: return {messages, wasCompacted:false, removedTurns:0}
  |
  |--> cutIndex = turns.length - keepRecentTurns
  |--> turnsToSummarize = turns[0..cutIndex]
  |--> turnsToKeep = turns[cutIndex..]
  |
  |=> generateSummary(messagesToSummarize, client, maxTokens)
  |    [compactor.ts:161]
  |    |--> COMPACTION_PROMPT:
  |    |    "Summarize as structured action log:
  |    |     [TOOL: name] path -> outcome
  |    |     [DECISION] what and why
  |    |     [FINDING] what was discovered
  |    |     [PENDING] unresolved issues
  |    |     Preserve ALL file paths, tool names, error messages.
  |    |     Keep under 500 words."
  |    |
  |    |--> build text representation of messages
  |    |    (each message truncated to 2000 chars)
  |    |=> client.complete([{user: PROMPT + conversation}], {maxTokens})
  |    -> summary: string
  |    |-- empty? throw Error (caught above, returns wasCompacted:false)
  |
  |--> build compacted message array:
  |    [0] UserMessage: "[Previous conversation summary -- N turns compacted]\n{summary}"
  |    [1] AssistantMessage: "Understood. I have the context... Continuing."
  |    [2..] keptMessages (last 6 turns intact)
  |
  -> CompactionResult {
       messages: Message[],
       wasCompacted: true,
       removedTurns: N,
       summaryLength: summary.length
     }
```

### Auto-Compaction in REPL

```
repl.ts:399-417

|--> tokenTracker.shouldAutoCompact()?
|    (threshold: context usage % exceeds configured limit)
|
|=> compactConversation(conversationMessages, client)
|    |-- wasCompacted:
|    |    conversationMessages.length = 0
|    |    conversationMessages.push(...result.messages)
|    |    tokenTracker.recordCompactSuccess()
|    |
|    |-- error:
|    |    tokenTracker.recordCompactFailure()
|    |    3 failures -> circuit breaker tripped
|    |    user told to use /compact manually
```

---

## 13. System Prompt Assembly

### Trigger

Called once at bootstrap, and the static portion is cached. Volatile parts are rebuilt per turn.

### Sequence Diagram

```
buildSystemPrompt(cwd, skillRegistry, adapters, memoryAgent, harnessConfig?)
  |                                                  [prompt-builder.ts:89]
  |
  |== IMMUTABLE BASE ==
  |--> BASE_SYSTEM_PROMPT                            [prompt-builder.ts:19]
  |    (~80 lines: identity, tool usage, orchestration guidelines)
  |
  |-- harnessConfig?.systemPromptAppend?
  |    basePrompt += "\n\n" + append
  |
  |== ENVIRONMENT ==
  |--> "# Environment\n  cwd, platform, date"
  |
  |== PARALLEL CONTEXT FETCH ==
  |=> Promise.all([
  |     getGitContext(cwd),       -> branch, status, recent commits
  |     getProjectContext(cwd),   -> package.json, tsconfig, custom instructions
  |     obsidianVault.getContextSummary(), -> vault note stats
  |   ])
  |
  |--> memoryAgent.getStartupContext()  (sync, already loaded)
  |
  |== ASSEMBLY (order matters for prompt quality) ==
  |--> gitContext -> "# Git Context\n..."
  |--> projectContext -> "# Project\n..." + "# Project Instructions\n..."
  |--> cliHints -> "# CLI Tools\n..." (generateHints from adapters)
  |--> vaultContext -> vault summary
  |--> memoryContext -> "# Memories from previous sessions\n..."
  |--> skillsPrompt -> "# Available Skills\n..." (generateSkillsPrompt)
  |--> companionPrompt -> companion personality + intro
  |--> harnessConfig?.promptFragments -> "# {name}\n{content}" for each
  |
  -> {prompt: string, warnings: string[]}
```

### Volatile Per-Turn Parts

```
buildVolatilePromptParts({mode, dynamicVaultContext, strategyPrompt, kairosContext, memoryContext})
  |                                                  [prompt-builder.ts:176]
  |-- mode='plan': "[MODE: PLAN] Do NOT make changes. Analyze and propose."
  |-- mode='default': "[MODE: DEFAULT] Ask before making changes."
  |-- mode='acceptEdits': "[MODE: ACCEPT-EDITS] Edit freely. Ask for shell."
  |-- fullAuto/bypass: (no injection)
  |
  |-- dynamicVaultContext? -> "# Updated vault context\n..."
  |-- strategyPrompt? -> "[STRATEGY] This is a {complexity} task..."
  |-- kairosContext? -> time context injection
  |-- memoryContext? -> "# Relevant memories\n..."
  |
  -> string[] (concatenated as additional system prompt blocks)
```

### System Prompt in LoopConfig

The REPL builds the system prompt as an array of blocks:
```typescript
[
  { type: 'text', text: staticSystemPrompt, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: volatileParts.join('\n\n') },  // if any
]
```

The `cache_control: { type: 'ephemeral' }` on the static part enables prompt caching for the immutable portion (saves tokens on subsequent turns).

---

## 14. Hook System Pipeline

### Trigger

Hooks fire at specific points in the agentic loop and REPL lifecycle.

### Hook Types and Timing

```
LIFECYCLE:
  OnStart  -> bootstrap completion (before first REPL iteration)
  OnExit   -> REPL exit / session end

PER-TOOL-CALL:
  PreToolUse  -> BEFORE tool.execute()               [loop.ts:293]
  PostToolUse -> AFTER tool.execute()                 [loop.ts:361]

PER-COMMAND:
  PreCommand  -> before command dispatch
  PostCommand -> after command dispatch

PER-MESSAGE:
  OnMessage   -> after assistant message received     [loop.ts:164]
                 (fire-and-forget, does not block)
```

### PreToolUse Chain

```
hookRegistry.runPreToolUse({tool, call})              [hooks.ts:116]
  |
  |--> handlers = hooks.get('PreToolUse') (sorted by priority, low=first)
  |
  |--> for each handler (priority order):
  |    |=> handler({tool, call: currentCall})
  |    |    -> PreToolUseResult {proceed, modifiedCall?, blockReason?}
  |    |
  |    |-- !proceed: BLOCK
  |    |    ~> emit 'hook:blocked'
  |    |    return {proceed:false, blockReason}
  |    |    (tool execution SKIPPED, error result returned to model)
  |    |
  |    |-- modifiedCall: currentCall = modifiedCall
  |    |    (subsequent hooks see the modified call)
  |    |
  |    |-- handler throws: log warning, continue to next hook
  |
  -> {proceed:true, modifiedCall: currentCall}
```

### PostToolUse Chain

```
hookRegistry.runPostToolUse({tool, call, result, durationMs})
  |                                                  [hooks.ts:150]
  |--> for each handler (priority order):
  |    |=> handler({...payload, result: currentResult})
  |    |    -> PostToolUseResult {modifiedResult?}
  |    |    |-- modifiedResult: currentResult = modifiedResult
  |    |-- handler throws: log warning, continue
  |
  -> {modifiedResult: currentResult}
```

### Built-in Hooks

- **BehaviorHooks** (`registerBehaviorHooks`): enforce mode-specific constraints
- **VerificationHook** (`registerVerificationHook`): validate tool outputs

### Hook Registration

```typescript
hookRegistry.register({
  type: 'PreToolUse',
  pluginName: 'my-plugin',
  priority: 50,  // 0-100, lower runs first
  handler: async (payload) => {
    // inspect/modify/block
    return { proceed: true };
  },
});
```

---

## 15. Scheduled Job Execution

### Trigger

Two scheduling modes:
1. **Cron**: checked every 60 seconds via tick timer
2. **Interval**: dedicated `setInterval` per job

### Sequence Diagram

```
Scheduler.start()                                    [scheduler.ts:157]
  |
  |--> tickTimer = setInterval(tick, 60_000)
  |--> for each enabled interval job: startIntervalJob()
  |
  tick():                                            [scheduler.ts:277]
  |--> now = new Date()
  |--> for each enabled cron job:
  |    |--> parseCron(expression)
  |    |--> cronMatches(schedule, now)?               [scheduler.ts:74]
  |    |    (check minute, hour, dom, month, dow)
  |    |    |-- YES && not already running:
  |    |        |=> executeJob(job)                   [scheduler.ts:310]
  |
  startIntervalJob(job):                             [scheduler.ts:295]
  |--> setInterval(() => {
  |      if (!running && enabled) executeJob(job)
  |    }, job.schedule.ms)
  |
  executeJob(job):                                   [scheduler.ts:310]
  |--> GUARD: !executor? throw "No executor set"
  |--> GUARD: running.has(job.id)? return "[already running]"
  |
  |--> running.add(job.id)
  ~> emit 'job:start'
  |
  |=> executor(job)                                  [type: JobExecutor]
  |    (injected by REPL/CLI: runs prompt through runLoop)
  |    |-- with timeout if job.timeoutMs set
  |
  |--> job.lastRunAt = now
  |--> job.lastResult = result (truncated to 500 chars)
  |--> job.runCount++
  ~> emit 'job:complete'
  |
  |-- error:
  |    job.lastResult = "Error: message"
  |    ~> emit 'job:error'
  |
  |--> finally: running.delete(job.id)
```

### Cron Expression Support

5-field format: `minute hour day-of-month month day-of-week`

Supported: numbers, `*` (wildcard), `/step`, comma-separated values.

NOT supported: ranges (`1-5`), `L`, `W`, `#`.

---

## 16. Tool Executor Patterns

### Trigger

The tool executor in `executor.ts` provides the batch execution strategy. Note: the main loop (`loop.ts`) runs tools sequentially inline. The executor module is available for parallel batch execution by other callers.

### Sequence Diagram

```
partitionToolCalls(calls, registry)                  [executor.ts:28]
  |
  |--> for each call:
  |    |--> tool = registry.get(call.name)
  |    |-- tool.definition.concurrencySafe?
  |    |   YES: add to current read batch
  |    |   NO:  flush read batch, add as solo batch
  |
  -> batches: Array<{calls[], parallel: bool}>
  |
  |    Example partition:
  |    [Read, Grep, Read, Edit, Read, Glob]
  |     \___________/  \__/  \_________/
  |      parallel      solo    parallel

executeToolCalls(calls, registry, context)           [executor.ts:62]
  |
  |--> partitionToolCalls(calls, registry)
  |
  |--> for each batch:
  |    |-- parallel && calls.length > 1:
  |    |    |=> runParallel(fns, MAX_CONCURRENCY=10)  [executor.ts:102]
  |    |        (worker pool pattern, up to 10 concurrent)
  |    |
  |    |-- sequential:
  |    |    |=> executeSingle(call, tool, context)
  |    |        |--> validateInput?
  |    |        |=> tool.execute(call, context)
  |    |        |-- error: return error ToolResult
  |
  -> ExecutionResult { results: ToolResult[], durationMs }
```

---

## Appendix A: RuntimeServices Container

All services assembled by `bootstrap()` and threaded to REPL/single-shot:

```
RuntimeServices                                      [services.ts:24]
{
  client:             MiniMaxClient          // LLM transport
  registry:           ToolRegistryImpl       // Tool definitions + implementations
  toolContext:         ToolContext            // cwd, abortSignal, permissionMode, askPermission
  permResolver:       PermissionResolver     // Permission chain
  hookRegistry:       HookRegistry           // Plugin hooks
  skillRegistry:      SkillRegistry          // Skill definitions
  commands:           CommandRegistry         // Slash command definitions
  sessionMgr:         SessionManager         // Session persistence
  bgManager:          BackgroundManager      // Background sessions
  scheduler:          Scheduler              // Cron/interval jobs
  memoryAgent:        MemoryAgent            // Unified memory (Obsidian + index)
  obsidianVault:      ObsidianVault | null   // Obsidian vault adapter
  credentialProvider: CredentialProvider      // Encrypted credential access
  kairos:             Kairos                 // Time-awareness (break suggestions, away detection)
  renderer:           TerminalRenderer       // Terminal output
  dispose():          Promise<void>          // Cleanup: stop scheduler, lock vault, flush memory
}
```

## Appendix B: LoopEvent Type Union

Complete event type emitted by `runLoop()`:

```typescript
type LoopEvent =
  | { type: 'turn_start';        turnIndex: number }
  | { type: 'stream_delta';      delta: ContentDelta; blockIndex: number }
  | { type: 'stream_text';       text: string }
  | { type: 'stream_thinking';   thinking: string }
  | { type: 'stream_tool_start'; toolName: string; toolId: string }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_executing';    call: ToolCall; triggeredBy: ActionTriggerBy }
  | { type: 'tool_result';       result: ToolResult; durationMs?: number }
  | { type: 'tool_result_message'; message: UserMessage }
  | { type: 'turn_end';          turnIndex: number; usage: Usage }
  | { type: 'history_sync';      messages: Message[] }
  | { type: 'loop_end';          reason: string; totalUsage: Usage; totalCost: number }
  | { type: 'error';             error: Error }
```

## Appendix C: Strategy Classification Flow

```
analyzeTask(input, messages, client)                 [strategy.ts:191]
  |
  |-- input starts with '/' or length < 5?
  |    -> trivial (no injection, no reflection)
  |
  |--> classifyByHeuristics(input)                   [strategy.ts:52]
  |    |-- EXPLORE_KEYWORDS + < 20 words?      -> trivial
  |    |-- < 8 words + no complex verbs?        -> trivial
  |    |-- EPIC_KEYWORDS + > 8 words?           -> epic
  |    |-- 3+ distinct action verbs?            -> complex
  |    |-- multi-step connectors + 2+ actions?  -> complex
  |    |-- 1-2 actions + <= 30 words?           -> simple
  |    |-- > 40 words + 2+ actions?             -> complex
  |    |-- null (ambiguous)
  |
  |-- heuristic returned value?
  |    -> TaskStrategy {complexity, strategyPrompt, reflectionInterval, classifiedBy:'heuristic'}
  |
  |-- null (ambiguous):
  |    |=> classifyByLLM(client, input)              [strategy.ts:98]
  |    |    ~150 tokens via M2.5 fast model
  |    |    "Classify: trivial/simple/complex/epic"
  |    |    "Recommend tools on line 2"
  |    -> TaskStrategy {complexity, strategyPrompt, reflectionInterval, classifiedBy:'llm'}

  Reflection intervals by complexity:
    trivial: 0 (never)
    simple:  5 (every 5 turns)
    complex: 3 (every 3 turns)
    epic:    3 (every 3 turns)
```

## Appendix D: File Reference Index

| File | Layer | Purpose |
|---|---|---|
| `bin/pcc.mjs` | Entrypoint | .env loading, import CLI |
| `src/entrypoints/cli.ts` | Entrypoint | main(), routing |
| `src/entrypoints/bootstrap.ts` | Entrypoint | Service assembly, parseArgs() |
| `src/entrypoints/repl.ts` | Entrypoint | Interactive REPL loop |
| `src/entrypoints/single-shot.ts` | Entrypoint | Single prompt execution |
| `src/entrypoints/repl-commands.ts` | Entrypoint | Inline REPL commands |
| `src/entrypoints/prompt-builder.ts` | Entrypoint | System prompt assembly |
| `src/entrypoints/cli-handlers.ts` | Entrypoint | LoopEvent -> UI rendering |
| `src/entrypoints/services.ts` | Entrypoint | RuntimeServices interface |
| `src/engine/loop.ts` | Engine | Core agentic while-loop |
| `src/engine/turns.ts` | Engine | Turn analysis, shouldContinue() |
| `src/engine/strategy.ts` | Engine | Task complexity classification |
| `src/engine/intelligence.ts` | Engine | Post-turn suggestion/speculation/memory |
| `src/engine/reflection.ts` | Engine | Mid-turn self-evaluation injection |
| `src/tools/executor.ts` | Tools | Batch tool execution with parallelism |
| `src/policy/permissions.ts` | Policy | Permission resolution chain |
| `src/policy/modes.ts` | Policy | Mode matrix, tool categories |
| `src/agents/orchestrator.ts` | Agents | Sub-agent spawning |
| `src/agents/delegation.ts` | Agents | Parallel/chain delegation patterns |
| `src/context/compactor.ts` | Context | Conversation compaction |
| `src/context/memory/agent.ts` | Context | Unified memory agent |
| `src/automation/background.ts` | Automation | Background sessions |
| `src/automation/scheduler.ts` | Automation | Cron/interval job scheduling |
| `src/plugins/hooks.ts` | Plugins | Hook system (Pre/PostToolUse, etc.) |
| `src/skills/loader.ts` | Skills | Skill registry, matching, loading |
| `src/meta/runtime.ts` | Meta | Non-interactive runtime bootstrap |
| `src/meta/evaluator.ts` | Meta | Task evaluation engine |
| `src/meta/proposer.ts` | Meta | Agentic config proposer |
| `src/meta/selector.ts` | Meta | Pareto frontier selection |
| `src/meta/cli.ts` | Meta | /meta command handler |
| `src/meta/collect.ts` | Meta | Structured query collector |
