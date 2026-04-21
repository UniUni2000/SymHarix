#!/usr/bin/env node

/**
 * claude-adapter.js
 * Translates Symphony's Codex App-Server JSON-RPC to Claude Code's stream-json format.
 */

const cp = require('child_process');
const readline = require('readline');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let childProcess = null;
let currentMessageId = 0;
let apiCallCount = 0;  // Set to 1 when turn completes (represents one API call per turn)
let turnCounter = 0; // Increments each turn/start; represents the logical turn number
let lastOrchTurnCompleted = -1; // Orch turn number we last sent turn/completed for (dedup)
let pendingOrchTurn = null; // Orch turn number for the current in-flight turn (set at turn/start)
const processingOrchTurns = new Set(); // Tracks orch turns currently being processed (for dedup)

function sendToOrchestrator(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function debugLog(msg) {
  // Can be viewed via orchestrator standard error
  process.stderr.write(`[adapter] ${msg}\n`);
}

// Enhanced tool execution - supports all claude-haha built-in tools
async function executeTool(toolName, toolInput, cwd) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  const fs = require('fs').promises;

  try {
    switch (toolName) {
      case 'Bash':
      case 'bash':
        const cmd = toolInput.command || '';
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: cwd || process.cwd(),
          timeout: 300000,  // 5 min timeout
          maxBuffer: 50 * 1024 * 1024
        });
        return stdout || stderr || 'Command executed (no output)';

      case 'Glob':
      case 'glob':
        const { glob } = require('glob');
        const pattern = toolInput.pattern || '*';
        const files = await glob(pattern, { cwd: cwd || process.cwd() });
        return files.slice(0, 100).join('\n') + (files.length > 100 ? `\n... ${files.length - 100} more` : '');

      case 'Read':
      case 'read':
        const content = await fs.readFile(toolInput.file_path, 'utf-8');
        const maxLen = toolInput.max_length || 50000;
        return content.slice(0, maxLen) + (content.length > maxLen ? '\n... (truncated)' : '');

      case 'Write':
      case 'write':
        await fs.writeFile(toolInput.file_path, toolInput.content || '', 'utf-8');
        return `Written to ${toolInput.file_path}`;

      case 'Edit':
      case 'edit':
        const fileContent = await fs.readFile(toolInput.file_path, 'utf-8');
        const newContent = fileContent.replace(toolInput.old_string, toolInput.new_string);
        if (fileContent === newContent) {
          return `No replacement made - old_string not found`;
        }
        await fs.writeFile(toolInput.file_path, newContent, 'utf-8');
        return `Edited ${toolInput.file_path}`;

      case 'WebFetch':
      case 'web_fetch':
      case 'WebFetchTool':
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(toolInput.url, {
          headers: toolInput.headers || {},
          timeout: 15000
        });
        const text = await response.text();
        return text.slice(0, 20000);

      case 'Grep':
      case 'grep':
      case 'GrepTool':
        const grepCmd = `rg -n "${toolInput.pattern}" ${toolInput.path || '.'} ${toolInput.glob ? `-g "${toolInput.glob}"` : ''} -C ${toolInput.context || 0}`.trim();
        const grepResult = await execAsync(grepCmd, { cwd: cwd || process.cwd(), maxBuffer: 10 * 1024 * 1024 });
        return grepResult.stdout.slice(0, 20000);

      case 'MCPTool':
      case 'mcp':
        return `MCP tool ${toolInput.name || 'unknown'} called but not executed by adapter`;

      default:
        return `[Adapter] Tool '${toolName}' executed (unsupported by adapter, result simulated)`;
    }
  } catch (err) {
    const error = err.message || String(err);
    return `Error: ${error}`;
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const msg = JSON.parse(line);
    
    // 1. Handshake Phase
    if (msg.method === 'initialize') {
      debugLog('Received initialize');
      sendToOrchestrator({ method: 'initialized' });
      // Send thread ID response with the same id as the initialize request
      sendToOrchestrator({ id: msg.id, result: { thread: { id: "adapter-thread-1" } } });
    }
    
    // 2. Thread Session Setup Phase
    if (msg.method === 'thread/start') {
      const cwd = msg.params?.cwd || process.cwd();
      debugLog(`Received thread/start. Spawning Claude Code at ${cwd}`);
      
      const cliPath = path.resolve(__dirname, '../claude-code/bin/claude-haha');
      const args = [
        '-c',                                  // Resume/continue from last session
        '-p',
        '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--replay-user-messages',
        '--permission-mode', 'bypassPermissions'  // Bypass all permission checks for automated workflow
      ];
      
      childProcess = cp.spawn(cliPath, args, {
        cwd: cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit'] // pipe stdin/stdout, let stderr inherit
      });
      
      // Intercept stream-json output
      childProcess.stdout.on('data', (data) => {
        const streamLines = data.toString().split('\n');
        for (const l of streamLines) {
          if (!l.trim()) continue;
          try {
            const ccMsg = JSON.parse(l);
            debugLog(`Claude emitted: ${ccMsg.type}${ccMsg.subtype ? '/' + ccMsg.subtype : ''}`);
            
            // API Invocation and Rate Limit tracking
            if (ccMsg.type === 'system' && ccMsg.subtype === 'api_retry') {
              console.error(`[adapter] ⚠️ API Rate Limit Hit! Attempt: ${ccMsg.attempt}, Delay: ${Math.round(ccMsg.retry_delay_ms)}ms`);
            }
            if (ccMsg.type === 'system' && ccMsg.subtype === 'api_success') {
               // This can be used if claude releases api_success events
               console.log(`[adapter] API call succeeded.`);
            }
            
            // Count API calls - each turn represents one API call
            // Deduplicate by orchestrator turn number: only send turn/completed once per logical turn.
            // We use pendingOrchTurn (set at turn/start) as the authoritative turn identifier.
            // This avoids issues with session_id/num_turns being inconsistent across message types.

            const isAssistantWithUsage = (() => {
              const msg = ccMsg.message || {};
              const usage = msg.usage || {};
              const inputTokens = Number(usage.input_tokens) || 0;
              const outputTokens = Number(usage.output_tokens) || 0;
              return usage && (inputTokens > 0 || outputTokens > 0);
            })();
            const isResultSuccess = ccMsg.type === 'result';

            // Only send turn/completed if we haven't already sent it for this orch turn
            if (pendingOrchTurn !== null && lastOrchTurnCompleted !== pendingOrchTurn) {
              if (isAssistantWithUsage) {
                const msg = ccMsg.message || {};
                const usage = msg.usage || {};
                const inputTokens = Number(usage.input_tokens) || 0;
                const outputTokens = Number(usage.output_tokens) || 0;
                apiCallCount = 1;
                console.log(`[adapter] 📊 Agent Turn Finished (usage). OrchTurn=${pendingOrchTurn}, Tokens: In=${inputTokens}, Out=${outputTokens}`);
                sendToOrchestrator({
                  method: 'turn/completed',
                  result: {
                    turn: {
                      id: `adapter-turn-${pendingOrchTurn}`,
                      api_calls: apiCallCount,
                      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens }
                    }
                  }
                });
                lastOrchTurnCompleted = pendingOrchTurn;
                processingOrchTurns.delete(pendingOrchTurn);
                apiCallCount = 0;
              } else if (isResultSuccess) {
                apiCallCount = 1;
                console.log(`[adapter] 📊 Agent Turn Finished (result). OrchTurn=${pendingOrchTurn}`);
                sendToOrchestrator({
                  method: 'turn/completed',
                  result: {
                    turn: {
                      id: `adapter-turn-${pendingOrchTurn}`,
                      api_calls: apiCallCount,
                      tokens: { input: 0, output: 0, total: 0 }
                    }
                  }
                });
                lastOrchTurnCompleted = pendingOrchTurn;
                processingOrchTurns.delete(pendingOrchTurn);
                apiCallCount = 0;
              }
            }
            
            if (ccMsg.type === 'error') {
              const errorMessage = ccMsg.message || ccMsg.error || 'Unknown Claude Error';
              console.error(`[adapter] 🚨 FATAL API ERROR: ${typeof errorMessage === 'object' ? JSON.stringify(errorMessage) : errorMessage}`);
              sendToOrchestrator({
                method: 'turn/failed',
                error: { code: -32000, message: typeof errorMessage === 'object' ? JSON.stringify(errorMessage) : errorMessage }
              });
            }
            // For observability in orchestrator
            else if (ccMsg.type === 'text_delta') {
               // We don't need to forward every token, but could track progress implicitly.
               // Runner.ts ignores unknown methods but prints them in debug mode.
               sendToOrchestrator({ method: 'turn/progress', text: ccMsg.text });
            }
            
            // Check for tool_use in content array (Claude Code format)
            if (ccMsg.message && ccMsg.message.content && Array.isArray(ccMsg.message.content)) {
              for (const contentItem of ccMsg.message.content) {
                if (contentItem.type === 'tool_use') {
                  console.error(`[adapter] TOOL_USE DETECTED: ${contentItem.name}`);
                  const toolCallId = contentItem.id;
                  const toolName = contentItem.name;
                  const toolInput = contentItem.input || {};
                  
                  debugLog(`Claude called tool: ${toolName}`);
                  debugLog(`Tool input: ${JSON.stringify(toolInput).slice(0, 200)}`);
                  debugLog(`Child process stdin available: ${!!(childProcess && childProcess.stdin && childProcess.stdin.writable)}`);
                  debugLog(`Child process cwd: ${childProcess.cwd || process.cwd()}`);
                  
                  // Execute tool using process.nextTick to ensure it's processed after current line
                  process.nextTick(async () => {
                    console.error(`[adapter] EXECUTING TOOL: ${toolName}`);
                    try {
                      debugLog(`Starting tool execution: ${toolName}`);
                      const result = await executeTool(toolName, toolInput, childProcess.cwd || process.cwd());
                      debugLog(`Tool execution completed, result length: ${result.length}`);
                      const toolResult = {
                        type: 'tool_result',
                        tool_use_id: toolCallId,
                        content: [{type: 'text', text: result}]
                      };
                      debugLog(`Sending tool result back to Claude`);
                      if (childProcess && childProcess.stdin && childProcess.stdin.writable) {
                        childProcess.stdin.write(JSON.stringify(toolResult) + '\n');
                        debugLog(`Tool result sent successfully`);
                      } else {
                        debugLog(`Error: child process stdin not available`);
                      }
                    } catch (err) {
                      console.error(`[adapter] TOOL EXECUTION ERROR: ${err.message}`);
                      debugLog(`Tool execution error: ${err.message}`);
                      debugLog(`Stack: ${err.stack}`);
                    }
                  });
                }
              }
            }
          } catch (e) {
            // Ignore incomplete lines or non-json
          }
        }
      });
      
      childProcess.on('exit', (code) => {
         debugLog(`Claude process exited with code ${code}`);
      });
      
      // Acknowledge thread start
      sendToOrchestrator({
        id: msg.id,
        result: { thread: { id: "adapter-thread-1" } }
      });
    }
    
    // 3. Turn Execution Phase
    if (msg.method === 'turn/start') {
      // Deduplicate: ignore if we're already processing this specific orch turn number
      // (same turn/start can arrive multiple times due to stdout buffering)
      const newOrchTurn = turnCounter + 1;
      if (processingOrchTurns.has(newOrchTurn)) {
        debugLog(`Received duplicate turn/start (orch=${newOrchTurn}), ignoring`);
        return;
      }
      // First time seeing this turn number - start processing it
      turnCounter++;
      processingOrchTurns.add(turnCounter);  // Mark as "in progress" before any async ops
      pendingOrchTurn = turnCounter;
      debugLog(`Received turn/start (orch=${pendingOrchTurn})`);

      // Acknowledge turn start immediately (for logging inside Symphony target stream)
      sendToOrchestrator({ result: { turn: { id: `adapter-turn-${pendingOrchTurn}` } } });

      if (childProcess && childProcess.stdin.writable) {
        // Find the actual prompt. Orchestrator format: params.input[0].text
        let textPrompt = '';
        if (msg.params?.input && msg.params.input.length > 0) {
           textPrompt = msg.params.input[0].text;
        } else if (msg.params?.text) {
           textPrompt = msg.params.text;
        }

        debugLog(`Sending prompt to Claude (${textPrompt.length} bytes)`);

        const ccInput = {
          type: "user",
          message: { role: "user", content: textPrompt }
        };

        childProcess.stdin.write(JSON.stringify(ccInput) + '\n');
      } else {
        debugLog('Error: Claude process not available');
        sendToOrchestrator({
          method: 'turn/failed',
          result: { error: 'Claude process not spawned or stdin closed.' }
        });
      }
    }
    
  } catch (err) {
    debugLog(`Input parsing error: ${err.message}`);
  }
});

// Avoid Zombie / Ghost process leakage when Orchestrator crashes
rl.on('close', () => {
  debugLog('Standard input stream severed. Parent must have died. Committing suicide.');
  if (childProcess) {
    childProcess.kill('SIGKILL');
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (childProcess) childProcess.kill('SIGKILL');
  process.exit(0);
});

process.on('SIGINT', () => {
  if (childProcess) childProcess.kill('SIGKILL');
  process.exit(0);
});

debugLog('Started and listening for standard JSON-RPC');
